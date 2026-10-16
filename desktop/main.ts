import path from "node:path"
import fs from "node:fs"
import { app, BrowserWindow, Menu, Tray, nativeImage, Notification, ipcMain, shell, session } from "electron"
import { fileURLToPath } from "node:url"
import { loadAgentConfig } from "../desktop-agent/src/config.js"
import { AgentBackendClient } from "../desktop-agent/src/agent-client.js"
import { BrowserRunner } from "../desktop-agent/src/browser-runner.js"
import { getAutomationEngine } from "../desktop-agent/src/marketplaces/registry.js"
import { logger } from "../desktop-agent/src/logger.js"

// Hardware efficiency switches for low-spec PCs (4GB RAM, 2-Core CPUs)
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256")
app.commandLine.appendSwitch("renderer-process-limit", "2")
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")
app.commandLine.appendSwitch("disable-background-timer-throttling", "false")

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// Agent State
const PRODUCTION_URL = "https://return.youthnic.shop"
const agentConfig = loadAgentConfig()

// Server URL: Production VPS default, fallback to explicit env if specified
const APP_URL =
  process.env.APP_URL ||
  process.env.BACKEND_URL ||
  (agentConfig.backendUrl && !agentConfig.backendUrl.includes("127.0.0.1") && !agentConfig.backendUrl.includes("localhost")
    ? agentConfig.backendUrl
    : PRODUCTION_URL)

// Ensure agent backend client connects to the exact same production endpoint
agentConfig.backendUrl = APP_URL
const client = new AgentBackendClient(agentConfig)
let isBotActive = true
let isProcessingJob = false
let activeJobSummary: string | null = null

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// 24/7 Background Claim Automation Worker
// ---------------------------------------------------------------------------------------------------------------

async function runAutomationWorkerLoop(): Promise<boolean> {
  if (!isBotActive || isProcessingJob) return false

  let pollResult: any = null
  try {
    pollResult = await client.pollJob()
    if (!pollResult.hasJob || !pollResult.job) return false

    isProcessingJob = true
    const jobHeader = pollResult.job
    activeJobSummary = `${jobHeader.marketplace} #${jobHeader.jobId} (${jobHeader.orderNumber})`

    logger.info(`[Desktop App Bot] Received Claim Job #${jobHeader.jobId} (${jobHeader.marketplace} · Order: ${jobHeader.orderNumber})`)

    if (Notification.isSupported()) {
      new Notification({
        title: `Auto-Claim Processing: ${jobHeader.marketplace}`,
        body: `Processing return claim for Order ${jobHeader.orderNumber}...`,
        silent: true,
      }).show()
    }

    await client.sendHeartbeat("busy", { activeJobId: jobHeader.jobId, marketplace: jobHeader.marketplace })

    const bundle = await client.getExecutionBundle(jobHeader.jobId)
    if (!bundle) {
      isProcessingJob = false
      activeJobSummary = null
      return
    }

    await client.updateProgress(jobHeader.jobId, {
      stage: "downloading_media",
      logMessage: "Desktop app downloading evidence media files...",
    })

    const evidenceFilesMap = await client.downloadEvidenceFiles(bundle.claimId, bundle.evidenceFiles)

    // Launch browser with persistent profile
    const browserRunner = new BrowserRunner()
    const isHeadless = bundle.automationMode === "headless"
    const profilePath = path.join(agentConfig.userDataDir, `profile-${bundle.marketplace.toLowerCase().replace(/[^a-z0-9]/g, "_")}`)

    const browserSession = await browserRunner.launch({
      profileDir: profilePath,
      headless: isHeadless,
    })

    try {
      await browserRunner.connectToPage(browserSession.port)

      const engine = getAutomationEngine(
        bundle.marketplace,
        browserRunner,
        bundle,
        evidenceFilesMap,
        path.join(agentConfig.workDir, `claim-${bundle.claimId}`),
      )

      const action = jobHeader.stage === "submitting" ? "submit" : "prepare"
      const result = await engine.execute(action)

      if (result.stage === "prepared") {
        await client.updateProgress(jobHeader.jobId, {
          stage: "prepared",
          logMessage: "Claim prepared on seller portal. Waiting for user approval.",
          screenshotPath: result.screenshotPath,
        })
        if (Notification.isSupported()) {
          new Notification({
            title: "Claim Prepared · Review Required",
            body: `${bundle.marketplace} claim #${bundle.claimId} prepared. Review in Claims tab.`,
          }).show()
        }
      } else if (result.stage === "completed") {
        await client.completeJob(jobHeader.jobId, {
          marketplaceClaimId: result.marketplaceClaimId || "CONFIRMED",
          screenshotPath: result.screenshotPath,
        })
        await client.cleanClaimEvidenceFiles(bundle.claimId)
        if (Notification.isSupported()) {
          new Notification({
            title: "Claim Submitted Successfully ✓",
            body: `${bundle.marketplace} claim filed. Ticket Ref: ${result.marketplaceClaimId || "CONFIRMED"}`,
          }).show()
        }
      } else if (result.stage === "manual_intervention_required") {
        await client.updateProgress(jobHeader.jobId, {
          stage: "manual_intervention_required",
          logMessage: result.manualActionReason || "Manual action required on portal.",
          screenshotPath: result.screenshotPath,
          manualActionReason: result.manualActionReason,
        })
        if (Notification.isSupported()) {
          new Notification({
            title: "Manual Action Required on Portal",
            body: result.manualActionReason || "OTP or review needed for claim submission.",
          }).show()
        }
      }
    } finally {
      await browserRunner.close()
    }
  } catch (err: any) {
    logger.error("[Desktop App Bot] Automation error:", err)
    if (pollResult?.job?.claimId) {
      await client.cleanClaimEvidenceFiles(pollResult.job.claimId).catch(() => undefined)
    }
    return false
  } finally {
    isProcessingJob = false
    activeJobSummary = null
    await client.sendHeartbeat("online", { status: "idle" }).catch(() => undefined)
  }
  return true
}

let schedulerTimeout: NodeJS.Timeout | null = null
let currentPollDelayMs = 10000
let consecutiveEmptyPolls = 0

async function triggerNextPoll(): Promise<void> {
  if (schedulerTimeout) {
    clearTimeout(schedulerTimeout)
    schedulerTimeout = null
  }

  if (!isBotActive) {
    schedulerTimeout = setTimeout(triggerNextPoll, 15000)
    return
  }

  try {
    const processedJob = await runAutomationWorkerLoop()
    if (processedJob) {
      consecutiveEmptyPolls = 0
      currentPollDelayMs = 5000 // Fast-poll when active claims are being processed
    } else {
      consecutiveEmptyPolls++
      // Dynamic backoff for 4GB RAM / 2-core CPU efficiency
      if (consecutiveEmptyPolls > 10) {
        currentPollDelayMs = 30000 // 30s when completely idle
      } else if (consecutiveEmptyPolls > 4) {
        currentPollDelayMs = 20000 // 20s after a minute of idle
      } else {
        currentPollDelayMs = 10000 // default 10s
      }
    }
  } catch (err) {
    logger.error("[Desktop Scheduler] Poll error:", err)
    currentPollDelayMs = 20000
  }

  schedulerTimeout = setTimeout(triggerNextPoll, currentPollDelayMs)
}

function startDesktopBotScheduler(): void {
  // Prune legacy temporary evidence directories on startup to keep disk usage minimal
  void client.pruneOldEvidenceFiles()

  // Register with backend
  void client.register()

  // Heartbeat every 20s with memory metrics
  setInterval(() => {
    void client.sendHeartbeat("online", {
      status: isProcessingJob ? "busy" : "idle",
      uptime: process.uptime(),
      memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    }).catch(() => undefined)
  }, 20000)

  // Start adaptive polling loop
  schedulerTimeout = setTimeout(triggerNextPoll, 2500)
}

// ---------------------------------------------------------------------------------------------------------------
// Main Application Window
// ---------------------------------------------------------------------------------------------------------------

function createMainWindow(): void {
  const iconPath = path.join(app.getAppPath(), "public", "app-icon.png")
  let appIcon: nativeImage | undefined
  if (fs.existsSync(iconPath)) {
    appIcon = nativeImage.createFromPath(iconPath)
  }

  // Persistent session partition so login ID, password, and session cookies persist forever
  const ses = session.fromPartition("persist:return-app-desktop")

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "Return App · Youthnic VB Exports",
    icon: appIcon,
    backgroundColor: "#0b1311",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
      webSecurity: true,
      backgroundThrottling: true,
      spellcheck: false,
    },
  })

  // Smooth appearance once ready
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show()
  })

  function showOfflinePage(targetUrl: string, errorDescription?: string): void {
    const safeUrl = targetUrl || PRODUCTION_URL
    const offlineHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Connecting to Return App...</title>
        <style>
          * { box-sizing: border-box; }
          body { 
            background: #060b09; 
            color: #f0fdf4; 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            min-height: 100vh; 
            margin: 0; 
            padding: 24px;
            text-align: center; 
          }
          .card { 
            background: #0f1c18; 
            border: 1px solid #1a332a; 
            border-radius: 16px; 
            padding: 40px 36px; 
            max-width: 480px; 
            width: 100%;
            box-shadow: 0 24px 48px rgba(0,0,0,0.5); 
          }
          .icon { 
            font-size: 38px; 
            margin-bottom: 16px; 
            display: inline-block;
          }
          h2 { margin: 0 0 10px; font-size: 22px; font-weight: 700; color: #34d399; }
          p { margin: 0 0 20px; color: #94a3b8; font-size: 13px; line-height: 1.6; }
          .url-box { 
            background: #060b09; 
            border: 1px solid #1a332a; 
            border-radius: 8px; 
            padding: 10px 14px; 
            font-family: monospace; 
            color: #34d399; 
            font-size: 13px; 
            word-break: break-all;
            margin-bottom: 24px;
          }
          .btn-group { display: flex; flex-direction: column; gap: 10px; }
          .btn { 
            background: #10b981; 
            color: #022c22; 
            border: none; 
            padding: 12px 24px; 
            border-radius: 8px; 
            font-weight: 600; 
            font-size: 14px; 
            cursor: pointer; 
            transition: all 0.15s ease; 
            display: block; 
            text-decoration: none;
          }
          .btn:hover { background: #34d399; transform: translateY(-1px); }
          .btn-secondary {
            background: transparent;
            color: #a7f3d0;
            border: 1px solid #1a332a;
          }
          .btn-secondary:hover { background: #162d25; color: #f0fdf4; }
          .countdown { font-size: 12px; color: #64748b; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">🔄</div>
          <h2>Connecting to Return App Server</h2>
          <p>Connecting to Return App Cloud Server. Please check your internet connection.${errorDescription ? `<br><small style="color:#64748b">(${errorDescription})</small>` : ""}</p>
          <div class="url-box">${safeUrl}</div>
          <div class="btn-group">
            <button class="btn" onclick="retryConnection('${safeUrl}')">Retry Connection Now</button>
            <button class="btn btn-secondary" onclick="retryConnection('${PRODUCTION_URL}')">Connect to Production Cloud (return.youthnic.shop)</button>
          </div>
          <div class="countdown" id="timer">Retrying automatically in 6 seconds...</div>
        </div>
        <script>
          let seconds = 6;
          const timerEl = document.getElementById('timer');
          function retryConnection(url) {
            window.location.href = url;
          }
          setInterval(() => {
            seconds--;
            if (seconds <= 0) {
              retryConnection('${safeUrl}');
            } else {
              timerEl.innerText = 'Retrying automatically in ' + seconds + ' seconds...';
            }
          }, 1000);
        </script>
      </body>
      </html>
    `
    mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlineHtml)}`)
  }

  // Load production web application
  logger.info(`Loading Return App from: ${APP_URL}`)
  mainWindow.loadURL(APP_URL).catch((err) => {
    logger.error("Failed to load APP_URL:", err)
    showOfflinePage(APP_URL, err?.message)
  })

  // Handle network drops or navigation failure
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL && !validatedURL.startsWith("data:")) {
      logger.warn(`Failed loading ${validatedURL} (code ${errorCode}: ${errorDescription})`)
      showOfflinePage(validatedURL, errorDescription)
    }
  })

  // Prevent opening untrusted URLs in the app window; open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) {
      shell.openExternal(url)
    }
    return { action: "deny" }
  })

  // Close to tray if user closes window on 24/7 server PC
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
      if (Notification.isSupported()) {
        new Notification({
          title: "Return App Minimized to Tray",
          body: "The 24/7 Claim Desktop Bot is still running in the background.",
          silent: true,
        }).show()
      }
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// System Tray Setup
// ---------------------------------------------------------------------------------------------------------------

function createTray(): void {
  const iconPath = path.join(app.getAppPath(), "public", "favicon.ico")
  let trayIcon: nativeImage
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath)
  } else {
    trayIcon = nativeImage.createEmpty()
  }

  tray = new Tray(trayIcon)
  tray.setToolTip("Return App · 24/7 Desktop Bot Active")

  const updateContextMenu = () => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Return App · Open Window",
        click: () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          }
        },
      },
      { type: "separator" },
      {
        label: isBotActive ? "● 24/7 Bot: Active" : "○ 24/7 Bot: Paused",
        enabled: false,
      },
      {
        label: activeJobSummary ? `Active: ${activeJobSummary}` : "Status: Waiting for claims",
        enabled: false,
      },
      {
        label: isBotActive ? "Pause Background Bot" : "Resume Background Bot",
        click: () => {
          isBotActive = !isBotActive
          updateContextMenu()
        },
      },
      { type: "separator" },
      {
        label: "Check for Claims Now",
        click: () => {
          consecutiveEmptyPolls = 0
          void triggerNextPoll()
        },
      },
      { type: "separator" },
      {
        label: "Quit Return App",
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ])
    tray?.setContextMenu(contextMenu)
  }

  updateContextMenu()

  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// IPC Listeners
// ---------------------------------------------------------------------------------------------------------------

ipcMain.on("desktop:notify", (_event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
})

ipcMain.handle("desktop:get-bot-status", () => ({
  isBotActive,
  isProcessingJob,
  activeJobSummary,
  backendUrl: APP_URL,
}))

ipcMain.handle("desktop:toggle-bot", () => {
  isBotActive = !isBotActive
  return { isBotActive }
})

// ---------------------------------------------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------------------------------------------

app.whenReady().then(() => {
  createMainWindow()
  createTray()
  startDesktopBotScheduler()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on("before-quit", () => {
  isQuitting = true
})

app.on("window-all-closed", () => {
  // On Windows, keep app running in tray if minimized
  if (process.platform !== "darwin" && isQuitting) {
    app.quit()
  }
})
