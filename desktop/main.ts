import path from "node:path"
import fs from "node:fs"
import { app, BrowserWindow, Menu, Tray, nativeImage, Notification, ipcMain, shell, session, type NativeImage } from "electron"
import {
  enginePause,
  engineRunOnceNow,
  engineStart,
  engineStatus,
  resumeClaimBotIfSignedIn,
  startDesktopAppServer,
} from "../desktop-agent/src/desktop-app-server.js"
import { isInsecureRemoteUrl, isSameOrigin, localEngineUrl, resolveEngineBind, type EngineBind } from "../desktop-agent/src/engine-config.js"
import { escapeHtml, scriptLiteral } from "../desktop-agent/src/html-escape.js"
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
  // The engine serves its dashboard and control API at the root. A path on the
  // URL cannot work: the shell would load "<path>/" and every control request
  // would miss, so reject it here rather than show a broken dashboard.
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `RETURN_ENGINE_URL must be an origin with no path, such as https://claims-engine.example.com (received "${parsed.pathname}").`,
    )
  }
  // The engine token is a long-lived shared secret sent as a bearer header on
  // every request. Plain http: to a non-loopback host would put it in clear text
  // on the network. Loopback (and an SSH tunnel to it) is allowed; anything else
  // must use https.
  if (isInsecureRemoteUrl(parsed.toString())) {
    throw new Error(
      "RETURN_ENGINE_URL uses plain http: to a remote host, which would send ENGINE_TOKEN in clear text. " +
        "Use an https:// URL, or an http://127.0.0.1 tunnel.",
    )
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
  // Use the bound host: ENGINE_HOST=::1 listens on IPv6 loopback only.
  return { kind: "local", bind, url: localEngineUrl(bind) }
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
  if (target.kind === "local") return new URL(localEngineUrl(target.bind)).origin
  return new URL(target.url).origin
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
      engineLabel: `local ${target.bind.host}:${target.bind.port}`,
    }
  }

  const host = new URL(target.url).host
  try {
    // AbortSignal.timeout() caps the wait so a stalled remote engine does not hang the 15-second tray
    // refresh and pile up pending requests. 5 s is enough for a LAN/WAN status read; a timeout lands in
    // the catch block below and returns the same offline status as a refused connection.
    const res = await fetch(new URL("/api/status", target.url), {
      headers: { Authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(5000),
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
  const target = engineTarget
  if (!target) return shellStatus()
  const before = await shellStatus()
  if (!before.signedIn) return before

  if (target.kind === "local") {
    // Re-read right before toggling. `before` was captured earlier in the IPC round-trip; another
    // client (or the Poll Now button) could have changed the worker state since then, and a stale
    // read would start the worker when the operator meant to pause it, or vice versa.
    const current = await shellStatus()
    if (current.workerRunning) enginePause()
    else engineStart()
  } else {
    await fetch(new URL("/api/scheduler/toggle", target.url), {
      method: "POST",
      headers: { Authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(5000),
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

  // Every route except the health probe needs the bearer token whenever the
  // engine has one. That is always the remote engine, but also a *local* engine
  // bound to a non-loopback ENGINE_HOST: resolveEngineBind() gives that bind an
  // authToken too, because the port is reachable from outside this machine. The
  // token is injected for the engine origin only, so the dashboard, panels, logs
  // and SSE stream all work. A loopback bind has an empty authToken, so this
  // stays a no-op in the normal single-machine case.
  const engineAuthToken = target.kind === "remote" ? target.token : target.bind.authToken
  if (engineAuthToken) {
    const origin = engineOrigin(target)
    ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
      details.requestHeaders["Authorization"] = `Bearer ${engineAuthToken}`
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
    // The engine URL and the Chromium failure message are operator/OS controlled, but this window carries the
    // preload bridge, so nothing is interpolated raw. `safeUrlText` covers the HTML text context; the URL is
    // handed to the script as a JSON literal, so a quote in a URL fragment cannot end the string and inject
    // code, and a `</script>` inside it cannot close the block.
    const safeUrlText = escapeHtml(engineUrl)
    const engineUrlLiteral = scriptLiteral(engineUrl)
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
          <p>This window is the 24/7 claim bot. It does not open return scanning.${errorDescription ? `<br><small style="color:#64748b">(${escapeHtml(errorDescription)})</small>` : ""}</p>
          <div class="url-box">${safeUrlText}</div>
          <button class="btn" id="open-engine" type="button">Open the claim bot</button>
          <div class="countdown" id="timer">Retrying automatically in 6 seconds...</div>
        </div>
        <script>
          const engineUrl = ${engineUrlLiteral};
          let seconds = 6;
          const timerEl = document.getElementById('timer');
          function retryConnection() { window.location.href = engineUrl; }
          document.getElementById('open-engine').addEventListener('click', retryConnection);
          setInterval(() => {
            seconds--;
            if (seconds <= 0) { retryConnection(); }
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
    if (url.startsWith("data:")) return
    if (!isSameOrigin(url, origin)) {
      logger.warn(`Blocked navigation to a non-engine origin from the claim bot window: ${url}`)
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

  // Long-running shell: if the renderer dies (GPU reset, out of memory, a driver
  // crash), reload it instead of leaving a dead window on a 24/7 server PC. The
  // engine keeps filing throughout; only this window is affected.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logger.error(`Claim bot window renderer gone (${details.reason}). Reloading.`)
    setTimeout(() => {
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.reload()
      }
    }, 2000)
  })

  mainWindow.webContents.on("unresponsive", () => {
    logger.warn("Claim bot window is unresponsive. The engine keeps running; the window will be reloaded if it dies.")
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
  // One-shot check: this must not resume a worker the operator paused.
  if (target.kind === "local") {
    await engineRunOnceNow()
    return
  }
  await fetch(new URL("/api/scheduler/poll-now", target.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${target.token}` },
    signal: AbortSignal.timeout(5000),
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

/**
 * Retry a failed local engine start.
 *
 * A 24/7 bot must not stay dead because of a startup race (a previous instance
 * still holding the port, a slow antivirus scan of the app folder). Retry with a
 * bound so a genuine configuration error does not loop forever; the offline card
 * keeps showing why in the meantime.
 */
let engineRetryTimer: NodeJS.Timeout | null = null
const ENGINE_RETRY_INTERVAL_MS = 30_000
const ENGINE_RETRY_MAX_ATTEMPTS = 20

function stopEngineRetry(): void {
  if (engineRetryTimer) clearInterval(engineRetryTimer)
  engineRetryTimer = null
}

/**
 * Read the remote target without letting a bad RETURN_ENGINE_URL reject.
 *
 * readRemoteEngineTarget() throws on a malformed URL or a missing token. In the
 * retry loop that throw happened *before* the try block, so it escaped as an
 * unhandled rejection every 30 seconds and could take the whole Electron process
 * down. A configuration error is also not transient, so it must stop the retries
 * rather than burn all 20 attempts.
 */
function readRemoteTargetSafely(): { target: { url: string; token: string } | null; configError: string | null } {
  try {
    return { target: readRemoteEngineTarget(), configError: null }
  } catch (err) {
    return { target: null, configError: err instanceof Error ? err.message : String(err) }
  }
}

function scheduleLocalEngineRetry(): void {
  if (engineRetryTimer) return
  let attempts = 0
  engineRetryTimer = setInterval(() => {
    void (async () => {
      attempts += 1
      const remote = readRemoteTargetSafely()
      if (remote.configError) {
        logger.error("RETURN_ENGINE_URL is not usable, so no engine was started. Fix the setting and relaunch.", remote.configError)
        stopEngineRetry()
        return
      }
      // A remote target is a configuration choice, not a race: never override it.
      if (engineTarget || remote.target) {
        stopEngineRetry()
        return
      }
      try {
        engineTarget = await startLocalEngine()
        logger.info(`Claim bot engine started after retry ${attempts}.`)
        stopEngineRetry()
        // The window was created for the placeholder target, so its bearer header
        // and its allowed navigation origin are the placeholder's. A retry can
        // bind a different origin than the placeholder (a non-loopback
        // ENGINE_HOST, or a port that changed), and then every protected request
        // from that window answers 401. Rebuild the window for the real target
        // instead of loading its URL into the old one.
        const stale = mainWindow
        mainWindow = null
        if (stale && !stale.isDestroyed()) stale.destroy()
        createMainWindow(engineTarget)
        refreshTray()
      } catch (err) {
        if (attempts >= ENGINE_RETRY_MAX_ATTEMPTS) {
          logger.error("Claim bot engine could not start after repeated retries. Giving up until the next launch.", err)
          stopEngineRetry()
        } else {
          logger.warn(`Claim bot engine retry ${attempts} failed; will try again in ${ENGINE_RETRY_INTERVAL_MS / 1000}s.`, err)
        }
      }
    })()
  }, ENGINE_RETRY_INTERVAL_MS)
}

/**
 * Start the app hidden at login, so a reboot does not stop the bot.
 *
 * Electron's setLoginItemSettings() is implemented on Windows (registry) and
 * macOS (login items) only. On Linux it is a silent no-op, so the XDG autostart
 * entry has to be written by hand; without it a packaged Linux install never
 * comes back after a reboot and the 24/7 promise is broken. The entry is
 * idempotent, so rewriting it on every launch is harmless.
 */
function registerAutoStart(): void {
  if (!app.isPackaged) return

  // A shell configured as a client of a remote engine must not register itself to
  // start at login. The autostart entry carries no environment, so the next
  // sign-in would start a LOCAL engine on this machine instead of connecting to
  // the server, silently changing where claims are filed. Writing ENGINE_TOKEN
  // into the entry is not an option either: an autostart file or a Run key value
  // is readable by anyone who can read the profile. The remote engine is the one
  // that files claims, so skipping the entry loses nothing.
  const remote = readRemoteTargetSafely()
  if (remote.target || remote.configError) {
    logger.info(
      "RETURN_ENGINE_URL is set, so this shell is a client of a remote engine. Skipping the start-at-login entry, " +
        "which would otherwise launch a local engine at the next sign-in.",
    )
    return
  }

  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] })
    return
  }

  try {
    // For an AppImage, process.execPath points inside the temporary mount, so
    // APPIMAGE (the real file) is the path that survives a reboot.
    const launchTarget = process.env.APPIMAGE || process.execPath
    const configHome = process.env.XDG_CONFIG_HOME || path.join(app.getPath("home"), ".config")
    const autostartDir = path.join(configHome, "autostart")
    fs.mkdirSync(autostartDir, { recursive: true })
    const entry = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Return App",
      "Comment=Marketplace claims bot",
      `Exec="${launchTarget}" --hidden`,
      "X-GNOME-Autostart-enabled=true",
      "Terminal=false",
      "",
    ].join("\n")
    fs.writeFileSync(path.join(autostartDir, "return-app.desktop"), entry, "utf8")
    logger.info(`Registered the Linux autostart entry at ${path.join(autostartDir, "return-app.desktop")}.`)
  } catch (err) {
    logger.warn("Could not write the Linux autostart entry. The bot will not start at login.", err)
  }
}

app.whenReady().then(async () => {
  process.env.RETURN_APP_VERSION = app.getVersion()

  registerAutoStart()

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

  if (startupError) {
    scheduleLocalEngineRetry()
  }

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
