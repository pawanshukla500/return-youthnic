import path from "node:path"
import fs from "node:fs"
import { app, BrowserWindow, Menu, Tray, nativeImage, Notification, ipcMain, shell, session } from "electron"
import { fileURLToPath } from "node:url"
import { loadAgentConfig, saveAgentConfig } from "../desktop-agent/src/config.js"
import { AgentBackendClient } from "../desktop-agent/src/agent-client.js"
import { BrowserRunner } from "../desktop-agent/src/browser-runner.js"
import { closePortalLoginBrowser, holdPortalBrowser, profileDirFor, readSessionSavedAt } from "../desktop-agent/src/portal-login.js"
import { getAutomationEngine } from "../desktop-agent/src/marketplaces/registry.js"
import { logger } from "../desktop-agent/src/logger.js"
import {
  resumeClaimBotIfSignedIn,
  startDesktopAppServer,
  type DesktopBotControl,
} from "../desktop-agent/src/desktop-app-server.js"

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
const DASHBOARD_PORT = 3005
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}/`
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
let client = new AgentBackendClient(agentConfig)
let isBotActive = false
let operatorSignedIn = false
let isProcessingJob = false
let activeJobSummary: string | null = null
let lastPollLabel = ""
let schedulerStarted = false
let refreshTray = () => {}

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
  if (!isBotActive || isProcessingJob || holdPortalBrowser()) return false
  lastPollLabel = new Date().toLocaleTimeString("en-IN")

  let pollResult: any = null
  let submissionOutcomeUnknown = false
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

    // The supplier-login window uses the same browser profile. Close it before this claim opens the portal.
    await closePortalLoginBrowser()

    // Launch browser with persistent profile
    const browserRunner = new BrowserRunner()
    const isHeadless = bundle.automationMode === "headless"
    const profilePath = path.join(agentConfig.userDataDir, `profile-${bundle.marketplace.toLowerCase().replace(/[^a-z0-9]/g, "_")}`)

    const browserSession = await browserRunner.launch({
      profileDir: profilePath,
      headless: isHeadless,
    })

    let keepBrowserOpen = false
    try {
      await browserRunner.connectToPage(browserSession.port)

      const engine = getAutomationEngine(
        bundle.marketplace,
        browserRunner,
        bundle,
        evidenceFilesMap,
        path.join(agentConfig.workDir, `claim-${bundle.claimId}`),
      )

      const sessionSaved = Boolean(readSessionSavedAt(profileDirFor(agentConfig.userDataDir, bundle.marketplace)))
      const action = jobHeader.stage === "submitting" || sessionSaved ? "submit" : "prepare"
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
      } else if (result.stage === "completed" && result.marketplaceClaimId) {
        submissionOutcomeUnknown = true
        await client.completeJob(jobHeader.jobId, {
          marketplaceClaimId: result.marketplaceClaimId,
          screenshotPath: result.screenshotPath,
        })
        submissionOutcomeUnknown = false
        await client.cleanClaimEvidenceFiles(bundle.claimId)
        if (Notification.isSupported()) {
          new Notification({
            title: "Claim Submitted Successfully ✓",
            body: `${bundle.marketplace} claim filed. Ticket Ref: ${result.marketplaceClaimId}`,
          }).show()
        }
      } else if (result.stage === "manual_intervention_required") {
        keepBrowserOpen = true
        holdPortalBrowser(browserRunner)
        await client.updateProgress(jobHeader.jobId, {
          stage: "manual_intervention_required",
          logMessage: result.manualActionReason || "Manual action required on portal.",
          screenshotPath: result.screenshotPath,
          manualActionReason: result.manualActionReason,
        })
        if (Notification.isSupported()) {
          new Notification({
            title: "Finish the supplier login",
            body: result.manualActionReason || "The supplier browser stays open. Finish the login, then run this claim again.",
          }).show()
        }
      } else if (result.stage === "not_eligible") {
        logger.warn(`[Desktop App Bot] Job #${jobHeader.jobId} is not eligible for a claim. Kept for manual review; moving to the next job.`)
        await client.updateProgress(jobHeader.jobId, {
          stage: "not_eligible",
          logMessage: result.manualActionReason || "The marketplace says this order is not eligible for a claim.",
          screenshotPath: result.screenshotPath,
          manualActionReason: result.manualActionReason,
        })
        await client.cleanClaimEvidenceFiles(bundle.claimId).catch(() => undefined)
      }
    } finally {
      if (!keepBrowserOpen) await browserRunner.close()
    }
  } catch (err: any) {
    logger.error("[Desktop App Bot] Automation error:", err)
    if (pollResult?.job?.jobId) {
      await client.updateProgress(pollResult.job.jobId, {
        stage: submissionOutcomeUnknown ? "manual_intervention_required" : "failed",
        logMessage: err instanceof Error ? err.message : "Desktop automation failed.",
        manualActionReason: submissionOutcomeUnknown
          ? "Meesho returned a ticket, but the server acknowledgement was lost. Verify the ticket before retrying."
          : err instanceof Error ? err.message : "Desktop automation failed.",
      }).catch(() => undefined)
    }
    if (pollResult?.job?.claimId && !submissionOutcomeUnknown) {
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
const startHidden = process.argv.includes("--hidden")
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

function ensureScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  startDesktopBotScheduler()
}

const botControl: DesktopBotControl = {
  isRunning: () => isBotActive,
  isProcessing: () => isProcessingJob,
  activeSummary: () => activeJobSummary,
  nextPollSeconds: () => Math.max(1, Math.round(currentPollDelayMs / 1000)),
  lastPollTime: () => lastPollLabel,
  onSignedIn: () => {
    operatorSignedIn = true
    isBotActive = true
    ensureScheduler()
    void triggerNextPoll()
    refreshTray()
  },
  onSignedOut: () => {
    operatorSignedIn = false
    isBotActive = false
    if (schedulerTimeout) {
      clearTimeout(schedulerTimeout)
      schedulerTimeout = null
    }
    refreshTray()
  },
  pause: () => {
    isBotActive = false
    refreshTray()
  },
  pollNow: () => {
    if (!operatorSignedIn) return
    isBotActive = true
    consecutiveEmptyPolls = 0
    ensureScheduler()
    void triggerNextPoll()
  },
  backendUrl: () => agentConfig.backendUrl,
  setBackendUrl: (url: string) => {
    const saved = saveAgentConfig({ backendUrl: url })
    agentConfig.backendUrl = saved.backendUrl
    client = new AgentBackendClient(agentConfig)
  },
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

function iconFor(name: "png" | "ico"): string {
  // Windows prefers .ico, Linux/macOS prefer .png. Both ship in public/.
  const ordered = process.platform === "win32" ? ["app-icon.ico", "app-icon.png"] : ["app-icon.png", "app-icon.ico"]
  for (const file of ordered) {
    const p = path.join(app.getAppPath(), "public", file)
    if (fs.existsSync(p)) return p
  }
  return path.join(app.getAppPath(), "public", name === "ico" ? "app-icon.ico" : "app-icon.png")
}

function createMainWindow(): void {
  const iconPath = iconFor("png")
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
    title: "Return App · 24/7 Claim Bot",
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
    if (!startHidden) mainWindow?.show()
  })

  function showOfflinePage(_targetUrl?: string, errorDescription?: string): void {
    const safeUrl = DASHBOARD_URL
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
          <h2>Opening the claim bot</h2>
          <p>This window is the 24/7 claim bot. It does not open return scanning.${errorDescription ? `<br><small style="color:#64748b">(${errorDescription})</small>` : ""}</p>
          <div class="url-box">${safeUrl}</div>
          <div class="btn-group">
            <button class="btn" onclick="retryConnection('${safeUrl}')">Open the claim bot</button>
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

  // Claim-bot window only. The warehouse scan screen stays on the web app and the phone.
  logger.info(`Opening claim bot window at ${DASHBOARD_URL}`)
  mainWindow.loadURL(DASHBOARD_URL).catch((err) => {
    logger.error("Failed to open the claim bot window:", err)
    showOfflinePage(DASHBOARD_URL, err?.message)
  })

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(DASHBOARD_URL) && !url.startsWith("data:")) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL && !validatedURL.startsWith("data:") && !validatedURL.startsWith(DASHBOARD_URL)) {
      logger.warn(`Blocked navigation away from the claim bot (${errorCode}: ${errorDescription})`)
      showOfflinePage(DASHBOARD_URL, errorDescription)
    } else if (validatedURL?.startsWith(DASHBOARD_URL)) {
      logger.warn(`Claim bot window failed to load (${errorCode}: ${errorDescription})`)
      showOfflinePage(DASHBOARD_URL, errorDescription)
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
          body: "The claim bot is still running. Return scanning is not open in this app.",
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
  const iconPath = iconFor("ico")
  let trayIcon: nativeImage
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath)
  } else {
    trayIcon = nativeImage.createEmpty()
  }

  tray = new Tray(trayIcon)
  tray.setToolTip("Return App · 24/7 claim bot")

  const updateContextMenu = () => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Open claim bot",
        click: () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          }
        },
      },
      { type: "separator" },
      {
        label: !operatorSignedIn ? "Sign in to run the claim bot" : isBotActive ? "● Claim bot: running" : "○ Claim bot: paused",
        enabled: false,
      },
      {
        label: activeJobSummary ? `Active: ${activeJobSummary}` : "Status: Waiting for claims",
        enabled: false,
      },
      {
        label: isBotActive ? "Pause claim bot" : "Resume claim bot",
        enabled: operatorSignedIn,
        click: () => {
          if (!operatorSignedIn) return
          isBotActive = !isBotActive
          if (isBotActive) {
            ensureScheduler()
            void triggerNextPoll()
          }
          updateContextMenu()
        },
      },
      { type: "separator" },
      {
        label: "Check for Claims Now",
        enabled: operatorSignedIn,
        click: () => {
          if (!operatorSignedIn) return
          isBotActive = true
          consecutiveEmptyPolls = 0
          ensureScheduler()
          void triggerNextPoll()
          updateContextMenu()
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

  refreshTray = updateContextMenu
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
  if (!operatorSignedIn) return { isBotActive: false, operatorSignedIn }
  isBotActive = !isBotActive
  if (isBotActive) {
    ensureScheduler()
    void triggerNextPoll()
  }
  refreshTray()
  return { isBotActive, operatorSignedIn }
})

// ---------------------------------------------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------------------------------------------

app.whenReady().then(async () => {
  process.env.RETURN_APP_VERSION = app.getVersion()
  if (app.isPackaged) {
    // Cross-platform auto-start: Windows registry / macOS login items /
    // Linux .desktop entry. Launches hidden so the 24/7 bot resumes in the tray.
    app.setLoginItemSettings({
      openAtLogin: true,
      args: ["--hidden"],
    })
  }
  try {
    await startDesktopAppServer(DASHBOARD_PORT, botControl)
    await resumeClaimBotIfSignedIn()
  } catch (err) {
    logger.error("Claim bot window failed to start. Scanning was not opened.", err)
  }
  createMainWindow()
  createTray()

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
  // Windows + Linux: keep the 24/7 bot in the tray after the window closes.
  // macOS: standard behaviour — stay active until the user quits explicitly.
  if (process.platform === "darwin") return
  if (isQuitting) {
    app.quit()
  }
})
