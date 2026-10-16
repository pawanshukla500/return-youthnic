import path from "node:path"
import fs from "node:fs"
import { app, BrowserWindow, Menu, Tray, nativeImage, Notification, ipcMain, shell, session } from "electron"
import { fileURLToPath } from "node:url"
import { loadAgentConfig } from "../desktop-agent/src/config.js"
import { AgentBackendClient } from "../desktop-agent/src/agent-client.js"
import { BrowserRunner } from "../desktop-agent/src/browser-runner.js"
import { getAutomationEngine } from "../desktop-agent/src/marketplaces/registry.js"
import { logger } from "../desktop-agent/src/logger.js"

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// Agent State
const agentConfig = loadAgentConfig()
const client = new AgentBackendClient(agentConfig)
let isBotActive = true
let isProcessingJob = false
let activeJobSummary: string | null = null

// Server URL: Production VPS default, fallback to env or localhost if specified
const APP_URL = process.env.APP_URL || process.env.BACKEND_URL || agentConfig.backendUrl || "https://return.youthnic.shop"

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

async function runAutomationWorkerLoop(): Promise<void> {
  if (!isBotActive || isProcessingJob) return

  try {
    const poll = await client.pollJob()
    if (!poll.hasJob || !poll.job) return

    isProcessingJob = true
    const jobHeader = poll.job
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
  } finally {
    isProcessingJob = false
    activeJobSummary = null
    await client.sendHeartbeat("online", { status: "idle" })
  }
}

function startDesktopBotScheduler(): void {
  // Register with backend
  void client.register()

  // Heartbeat every 15s
  setInterval(() => {
    void client.sendHeartbeat("online", { status: isProcessingJob ? "busy" : "idle", uptime: process.uptime() })
  }, agentConfig.heartbeatIntervalMs)

  // Polling every 10s
  setInterval(() => {
    void runAutomationWorkerLoop()
  }, agentConfig.pollIntervalMs)

  // Initial poll
  setTimeout(() => {
    void runAutomationWorkerLoop()
  }, 3000)
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
    },
  })

  // Smooth appearance once ready
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show()
  })

  // Load production web application
  logger.info(`Loading Return App from: ${APP_URL}`)
  mainWindow.loadURL(APP_URL).catch((err) => {
    logger.error("Failed to load APP_URL:", err)
    // Offline / Connection retry page
    const offlineHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Connecting to Return App...</title>
        <style>
          body { background: #0b1311; color: #f0fdf4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; text-align: center; }
          .card { background: #111e1b; border: 1px solid #1a2f2a; border-radius: 14px; padding: 36px 42px; max-width: 460px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
          .icon { font-size: 42px; margin-bottom: 16px; }
          h2 { margin: 0 0 10px; font-size: 20px; font-weight: 700; color: #34d399; }
          p { margin: 0 0 24px; color: #84a99d; font-size: 13px; line-height: 1.5; }
          .btn { background: #10b981; color: #052e16; border: none; padding: 10px 24px; border-radius: 8px; font-weight: 600; font-size: 13px; cursor: pointer; transition: 0.15s; text-decoration: none; display: inline-block; }
          .btn:hover { background: #34d399; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">🔄</div>
          <h2>Connecting to Return App Server</h2>
          <p>Connecting to <code>${APP_URL}</code>. Please check your internet connection.</p>
          <button class="btn" onclick="window.location.href='${APP_URL}'">Retry Connection Now</button>
        </div>
        <script>
          setTimeout(() => { window.location.href = '${APP_URL}'; }, 6000);
        </script>
      </body>
      </html>
    `
    mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlineHtml)}`)
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
          void runAutomationWorkerLoop()
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
