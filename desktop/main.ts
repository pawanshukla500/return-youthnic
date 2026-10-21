import path from "node:path"
import fs from "node:fs"
import { app, BrowserWindow, Menu, Tray, nativeImage, Notification, ipcMain, shell, session, type NativeImage } from "electron"
import {
  enginePause,
  enginePollNow,
  engineStart,
  engineStatus,
  resumeClaimBotIfSignedIn,
  startDesktopAppServer,
} from "../desktop-agent/src/desktop-app-server.js"
import { resolveEngineBind, type EngineBind } from "../desktop-agent/src/engine-config.js"
import { logger } from "../desktop-agent/src/logger.js"

// Hardware efficiency switches for low-spec PCs (4GB RAM, 2-Core CPUs)
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256")
app.commandLine.appendSwitch("renderer-process-limit", "2")
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")
app.commandLine.appendSwitch("disable-background-timer-throttling", "false")

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let refreshTray = () => {}

const startHidden = process.argv.includes("--hidden")

// ---------------------------------------------------------------------------------------------------------------
// Engine target
//
// Local (default): this shell embeds the automation engine on 127.0.0.1 and drives it in-process.
// Remote: RETURN_ENGINE_URL points at a Linux server's engine, so this shell starts no local engine and
//         drives it over the control API with a bearer token. Either way the engine owns the worker loop.
// ---------------------------------------------------------------------------------------------------------------

type EngineTarget =
  | { kind: "local"; bind: EngineBind; url: string }
  | { kind: "remote"; url: string; token: string }

type ShellStatus = {
  workerRunning: boolean
  isCurrentlyProcessing: boolean
  activeSummary: string | null
  signedIn: boolean
  backendUrl: string
  engineLabel: string
}

let engineTarget: EngineTarget | null = null

function readRemoteEngineTarget(): { url: string; token: string } | null {
  const raw = (process.env.RETURN_ENGINE_URL || "").trim()
  if (!raw) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`RETURN_ENGINE_URL is not a valid URL: "${raw}"`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("RETURN_ENGINE_URL must start with http:// or https://")
  }
  const token = (process.env.ENGINE_TOKEN || "").trim()
  if (!token) {
    throw new Error("RETURN_ENGINE_URL is set, so ENGINE_TOKEN must also be set to reach that engine.")
  }
  return { url: parsed.toString(), token }
}

async function startLocalEngine(): Promise<EngineTarget> {
  const bind = resolveEngineBind()
  await startDesktopAppServer(bind)
  await resumeClaimBotIfSignedIn()
  return { kind: "local", bind, url: `http://127.0.0.1:${bind.port}/` }
}

async function resolveEngineTarget(): Promise<EngineTarget> {
  const remote = readRemoteEngineTarget()
  if (remote) {
    logger.info(`Desktop shell is a client of the remote engine at ${remote.url}. No local worker runs on this machine.`)
    return { kind: "remote", url: remote.url, token: remote.token }
  }
  return startLocalEngine()
}

function engineOrigin(target: EngineTarget): string {
  return target.kind === "local" ? `http://127.0.0.1:${target.bind.port}` : new URL(target.url).origin
}

/** Status for the tray and the preload bridge, from the local engine or the remote control API. */
async function shellStatus(): Promise<ShellStatus> {
  const target = engineTarget
  if (!target) {
    return {
      workerRunning: false,
      isCurrentlyProcessing: false,
      activeSummary: null,
      signedIn: false,
      backendUrl: "",
      engineLabel: "starting",
    }
  }

  if (target.kind === "local") {
    const status = engineStatus()
    return {
      workerRunning: status.workerRunning,
      isCurrentlyProcessing: status.isCurrentlyProcessing,
      activeSummary: status.activeSummary,
      signedIn: status.signedIn,
      backendUrl: status.backendUrl,
      engineLabel: `local 127.0.0.1:${target.bind.port}`,
    }
  }

  const host = new URL(target.url).host
  try {
    const res = await fetch(new URL("/api/status", target.url), {
      headers: { Authorization: `Bearer ${target.token}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Record<string, unknown>
    return {
      workerRunning: Boolean(data.isRunning),
      isCurrentlyProcessing: Boolean(data.isCurrentlyProcessing),
      activeSummary: (data.activeSummary as string | null) ?? null,
      signedIn: Boolean(data.signedIn),
      backendUrl: String(data.backendUrl || ""),
      engineLabel: `remote ${host}`,
    }
  } catch {
    return {
      workerRunning: false,
      isCurrentlyProcessing: false,
      activeSummary: null,
      signedIn: false,
      backendUrl: "",
      engineLabel: `remote ${host} (unreachable)`,
    }
  }
}

async function toggleWorker(): Promise<ShellStatus> {
  const before = await shellStatus()
  const target = engineTarget
  if (!target || !before.signedIn) return before

  if (target.kind === "local") {
    if (before.workerRunning) enginePause()
    else engineStart()
  } else {
    await fetch(new URL("/api/scheduler/toggle", target.url), {
      method: "POST",
      headers: { Authorization: `Bearer ${target.token}` },
    }).catch(() => undefined)
  }
  return shellStatus()
}

// ---------------------------------------------------------------------------------------------------------------
// Main Application Window
// ---------------------------------------------------------------------------------------------------------------

function iconFor(name: "png" | "ico"): string {
  // Windows prefers .ico, Linux/macOS prefer .png. Both ship in public/.
  const ordered = process.platform === "win32" ? ["app-icon.ico", "app-icon.png"] : ["app-icon.png", "app-icon.ico"]
  for (const file of ordered) {
    const candidate = path.join(app.getAppPath(), "public", file)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(app.getAppPath(), "public", name === "ico" ? "app-icon.ico" : "app-icon.png")
}

function createMainWindow(target: EngineTarget, startupError?: string): void {
  const iconPath = iconFor("png")
  let appIcon: NativeImage | undefined
  if (fs.existsSync(iconPath)) {
    appIcon = nativeImage.createFromPath(iconPath)
  }

  // Persistent session partition so login ID, password, and session cookies persist forever
  const ses = session.fromPartition("persist:return-app-desktop")

  if (target.kind === "remote") {
    // The remote engine requires the bearer token on every route. Inject it for
    // that origin only, so the dashboard, panels, logs and SSE stream all work.
    const origin = new URL(target.url).origin
    const token = target.token
    ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
      details.requestHeaders["Authorization"] = `Bearer ${token}`
      callback({ requestHeaders: details.requestHeaders })
    })
  }

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

  mainWindow.once("ready-to-show", () => {
    if (!startHidden) mainWindow?.show()
  })

  const origin = engineOrigin(target)
  const engineUrl = target.url

  function showOfflinePage(errorDescription?: string): void {
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
          .icon { font-size: 38px; margin-bottom: 16px; display: inline-block; }
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
          .btn {
            background: #10b981;
            color: #022c22;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            display: block;
            width: 100%;
            text-decoration: none;
          }
          .btn:hover { background: #34d399; }
          .countdown { font-size: 12px; color: #64748b; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">🔄</div>
          <h2>Opening the claim bot</h2>
          <p>This window is the 24/7 claim bot. It does not open return scanning.${errorDescription ? `<br><small style="color:#64748b">(${errorDescription})</small>` : ""}</p>
          <div class="url-box">${engineUrl}</div>
          <button class="btn" onclick="retryConnection('${engineUrl}')">Open the claim bot</button>
          <div class="countdown" id="timer">Retrying automatically in 6 seconds...</div>
        </div>
        <script>
          let seconds = 6;
          const timerEl = document.getElementById('timer');
          function retryConnection(url) { window.location.href = url; }
          setInterval(() => {
            seconds--;
            if (seconds <= 0) { retryConnection('${engineUrl}'); }
            else { timerEl.innerText = 'Retrying automatically in ' + seconds + ' seconds...'; }
          }, 1000);
        </script>
      </body>
      </html>
    `
    mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlineHtml)}`)
  }

  logger.info(`Opening claim bot window at ${engineUrl}`)
  if (startupError) {
    showOfflinePage(startupError)
  } else {
    mainWindow.loadURL(engineUrl).catch((err) => {
      logger.error("Failed to open the claim bot window:", err)
      showOfflinePage(err?.message)
    })
  }

  // The window is the engine's own dashboard. Anything else opens in the system browser.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin) && !url.startsWith("data:")) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL?.startsWith("data:")) return
    logger.warn(`Claim bot window failed to load (${errorCode}: ${errorDescription})`)
    showOfflinePage(errorDescription)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) {
      shell.openExternal(url)
    }
    return { action: "deny" }
  })

  // Close to tray so the 24/7 bot keeps running on the server PC.
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
  let trayIcon: NativeImage
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath)
  } else {
    trayIcon = nativeImage.createEmpty()
  }

  tray = new Tray(trayIcon)
  tray.setToolTip("Return App · 24/7 claim bot")

  const updateContextMenu = async () => {
    const status = await shellStatus()
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
      { label: `Engine: ${status.engineLabel}`, enabled: false },
      {
        label: !status.signedIn ? "Sign in to run the claim bot" : status.workerRunning ? "● Claim bot: running" : "○ Claim bot: paused",
        enabled: false,
      },
      {
        label: status.activeSummary ? `Active: ${status.activeSummary}` : "Status: Waiting for claims",
        enabled: false,
      },
      {
        label: status.workerRunning ? "Pause claim bot" : "Resume claim bot",
        enabled: status.signedIn,
        click: () => {
          void toggleWorker().then(() => updateContextMenu())
        },
      },
      { type: "separator" },
      {
        label: "Check for Claims Now",
        enabled: status.signedIn,
        click: () => {
          void checkForClaimsNow().then(() => updateContextMenu())
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

  refreshTray = () => {
    void updateContextMenu()
  }
  refreshTray()

  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

async function checkForClaimsNow(): Promise<void> {
  const target = engineTarget
  if (!target) return
  if (target.kind === "local") {
    enginePollNow()
    return
  }
  await fetch(new URL("/api/scheduler/poll-now", target.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${target.token}` },
  }).catch(() => undefined)
}

// ---------------------------------------------------------------------------------------------------------------
// IPC Listeners
// ---------------------------------------------------------------------------------------------------------------

ipcMain.on("desktop:notify", (_event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
})

ipcMain.handle("desktop:get-bot-status", async () => shellStatus())

ipcMain.handle("desktop:toggle-bot", async () => toggleWorker())

// ---------------------------------------------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------------------------------------------

// Single instance lock: a second launch focuses the running window instead.
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

app.whenReady().then(async () => {
  process.env.RETURN_APP_VERSION = app.getVersion()

  if (app.isPackaged) {
    // Cross-platform auto-start: Windows registry / macOS login items / Linux .desktop entry.
    app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] })
  }

  let startupError: string | undefined
  try {
    engineTarget = await resolveEngineTarget()
  } catch (err) {
    startupError = err instanceof Error ? err.message : "The engine could not start."
    logger.error("Claim bot engine failed to start. Scanning was not opened.", err)
  }

  // Even with no engine, show a window so the operator can see why.
  const fallbackTarget: EngineTarget = {
    kind: "local",
    bind: { host: "127.0.0.1", port: 3005, mode: "local", remoteAccess: false, authToken: "" },
    url: "http://127.0.0.1:3005/",
  }
  createMainWindow(engineTarget ?? fallbackTarget, startupError)
  createTray()

  // Refresh the tray periodically so it reflects the engine without a manual nudge.
  setInterval(() => refreshTray(), 15000)

  app.on("activate", () => {
    mainWindow?.show()
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
