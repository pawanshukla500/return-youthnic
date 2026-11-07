import "../desktop-agent/src/load-env.js"
import path from "node:path"
import fs from "node:fs"
import { app, BrowserWindow, Menu, Tray, nativeImage, Notification, ipcMain, protocol, screen, session, type NativeImage } from "electron"
import {
  enginePause,
  engineRunOnceNow,
  engineStart,
  engineStatus,
  resumeClaimBotIfSignedIn,
  startDesktopAppServer,
} from "../desktop-agent/src/desktop-app-server.js"
import { notifyWindowGeometryChanged, setBrowserWorkspaceRect, setDetachedViewHost, setFullscreenSupplierView, setSupplierViewHost, handleDetachedWindowClosed, disposeDetachedSupplierViews, notifyWindowLifecycle, DETACHED_WINDOW_WEB_PREFERENCES, STANDARD_CHROME_USER_AGENT, type WindowLifecycleEvent } from "../desktop-agent/src/native-browser-view.js"
import { isInsecureRemoteUrl, isSameOrigin, localEngineUrl, resolveEngineBind, type EngineBind } from "../desktop-agent/src/engine-config.js"
import { logger } from "../desktop-agent/src/logger.js"

// Hardware efficiency switches for low-spec PCs (4GB RAM, 2-Core CPUs)
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256")
app.commandLine.appendSwitch("renderer-process-limit", "2")
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")
app.commandLine.appendSwitch("disable-background-timer-throttling", "false")
// Prevent supplier anti-bot WAFs (e.g. Akamai on Meesho) from flagging the embedded browser as automated
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled")

app.userAgentFallback = STANDARD_CHROME_USER_AGENT

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let refreshTray = () => {}

const startHidden = process.argv.includes("--hidden")

// ---------------------------------------------------------------------------------------------------------------
// Bundled desktop renderer (returnapp://desktop)
//
// The window no longer loads the engine's server-rendered dashboard. Production
// serves a bundled React renderer from desktop/renderer/dist through a
// privileged custom scheme, which gives the app a real origin for CORS/CSP.
// Development loads the Vite dev server instead. The engine dashboard HTML at
// GET / stays in place for headless Linux mode — the desktop app simply never
// loads it. Engine reachability is the renderer's concern: it probes the engine
// API (see /api/health) and renders its own offline/connecting state.
// ---------------------------------------------------------------------------------------------------------------

const RENDERER_SCHEME = "returnapp"
const RENDERER_HOST = "desktop"
const DEV_RENDERER_URL = "http://localhost:5180"

// Must run BEFORE app ready: tells Chromium to treat returnapp://desktop as a
// standard, secure origin with fetch support. CSP from pages is still enforced
// (bypassCSP stays false).
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
])

/** The URL the shell loads: bundled scheme in production, Vite dev URL in development. */
function rendererUrl(): string {
  if (app.isPackaged) return `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`
  return process.env.DESKTOP_RENDERER_URL ?? DEV_RENDERER_URL
}

function rendererDistDir(): string {
  // Packaged (asar): <app path>/desktop/renderer/dist. Unpackaged (the bundled
  // main.cjs run from desktop/dist): desktop/dist/../renderer/dist. Resolving
  // via app.getAppPath() first and falling back to __dirname follows the
  // iconFor() asar pattern so both layouts work.
  const packaged = path.join(app.getAppPath(), "desktop", "renderer", "dist")
  if (fs.existsSync(packaged)) return packaged
  return path.join(__dirname, "..", "renderer", "dist")
}

const RENDERER_MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
}

const RENDERER_NOT_BUILT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Return App</title></head>` +
  `<body style="font-family:system-ui,sans-serif;background:#0b1311;color:#f0fdf4;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">` +
  `<div style="max-width:440px;padding:24px;text-align:center"><h1 style="font-size:18px;margin:0 0 12px">Desktop renderer not built</h1>` +
  `<p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0">The bundled desktop UI is missing. ` +
  `Build it (the Vite output goes to <code>desktop/renderer/dist</code>) and restart the app.</p></div></body></html>`

function rendererNotBuiltResponse(): Response {
  return new Response(RENDERER_NOT_BUILT_HTML, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

/**
 * Serve the bundled renderer over returnapp://desktop/<path>.
 *
 * Files resolve inside desktop/renderer/dist only: normalized paths that escape
 * the dist root are rejected. Unknown extensionless paths (SPA routes) fall
 * back to index.html; missing assets answer 404. If the dist folder does not
 * exist at all (the renderer was never built), every request answers a minimal
 * 503 page so a developer gets a clear message instead of a dead white screen.
 */
function registerRendererProtocol(targetSession?: Electron.Session): void {
  const p = targetSession ? targetSession.protocol : protocol
  if (p.isProtocolHandled(RENDERER_SCHEME)) return
  p.handle(RENDERER_SCHEME, (request) => {
    try {
      const dist = path.normalize(rendererDistDir())
      if (!fs.existsSync(dist)) return rendererNotBuiltResponse()

      const url = new URL(request.url)
      if (url.host !== RENDERER_HOST) return new Response("Not found", { status: 404 })

      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "")
      const resolved = path.normalize(path.join(dist, rel || "index.html"))
      if (resolved !== dist && !resolved.startsWith(dist + path.sep)) {
        return new Response("Not found", { status: 404 })
      }

      let filePath = resolved
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        if (rel === "" || rel === "index.html" || path.extname(rel) === "") {
          filePath = path.join(dist, "index.html")
        } else {
          return new Response("Not found", { status: 404 })
        }
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return rendererNotBuiltResponse()

      const body = fs.readFileSync(filePath)
      const type = RENDERER_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
      return new Response(new Uint8Array(body), { headers: { "Content-Type": type } })
    } catch {
      return new Response("Internal error", { status: 500 })
    }
  })
}

function isRendererNavigation(url: string, targetUrl: string): boolean {
  if (targetUrl.startsWith(`${RENDERER_SCHEME}://`)) {
    try {
      const parsed = new URL(url)
      return parsed.protocol === `${RENDERER_SCHEME}:` && parsed.host === RENDERER_HOST
    } catch {
      return false
    }
  }
  return isSameOrigin(url, new URL(targetUrl).origin)
}

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
    // Send the desired action, not a blind toggle, so a stale menu label does not start the worker when
    // the operator meant to pause it (or vice versa) after another client changed the state between the
    // menu display and the click.
    const action = before.workerRunning ? "pause" : "start"
    const toggleUrl = new URL("/api/scheduler/toggle", target.url)
    toggleUrl.searchParams.set("action", action)
    await fetch(toggleUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
  }
  return shellStatus()
}

/**
 * Push worker status to the renderer so its dashboard chip stays live without
 * renderer-side polling. Polls shellStatus() every 5 s (local: engineStatus();
 * remote: the control API fetch) and broadcasts desktop:bot-status-changed.
 * The send is guarded so a destroyed window is skipped, never an error.
 */
function startBotStatusPush(): void {
  setInterval(() => {
    void (async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const status = await shellStatus().catch(() => null)
      if (!status) return
      if (!mainWindow || mainWindow.isDestroyed()) return
      try {
        mainWindow.webContents.send("desktop:bot-status-changed", status)
      } catch {
        // window torn down mid-send
      }
    })()
  }, 5000)
}

// ---------------------------------------------------------------------------------------------------------------
// Main Application Window
// ---------------------------------------------------------------------------------------------------------------

function iconFor(): string {
  // Windows-only desktop: the .ico ships in public/ (the .png is the fallback).
  for (const file of ["app-icon.ico", "app-icon.png"]) {
    const candidate = path.join(app.getAppPath(), "public", file)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(app.getAppPath(), "public", "app-icon.ico")
}

/**
 * Register the single app window as the owner of every supplier browser view.
 *
 * The native adapter attaches marketplace `WebContentsView`s to this host, so
 * supplier sign-in, OTP/CAPTCHA and evidence work happen inside the main
 * window. No per-panel `BrowserWindow` and no system browser are involved.
 */
/**
 * Notify the engine's tab manager of window lifecycle transitions so sessions
 * survive minimize/maximize/restore/tray-hide and detached windows are
 * disposed cleanly on quit.
 */
function notifyWindowLifecycleFromShell(event: WindowLifecycleEvent): void {
  try {
    notifyWindowLifecycle(event)
  } catch {
    // ignore teardown races
  }
}

function registerSupplierViewHost(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  setSupplierViewHost({
    addView: (view) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.addChildView(view)
    },
    removeView: (view) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.contentView.removeChildView(view)
        } catch {
          // ignore teardown races
        }
      }
    },
    contentBounds: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
      const bounds = mainWindow.getContentBounds()
      return { x: 0, y: 0, width: Math.max(0, bounds.width), height: Math.max(0, bounds.height) }
    },
    showWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
      }
    },
    focusWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus()
    },
    isWindowDestroyed: () => !mainWindow || mainWindow.isDestroyed(),
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Detached supplier windows
//
// The Detach toolbar button moves a tab's live WebContentsView into its own
// hardened BrowserWindow (contextIsolation, no Node, sandbox). Cookies, DOM
// state and the worker lease ride along with the view; closing the window
// docks the tab back before the window disappears.
// ---------------------------------------------------------------------------------------------------------------

type DetachedWindowEntry = {
  window: BrowserWindow
  view: Electron.CrossProcessExports.WebContentsView | null
  popups: Array<Electron.CrossProcessExports.WebContentsView>
}

const detachedWindows = new Map<string, DetachedWindowEntry>()

function fitDetachedView(panelKey: string): void {
  const entry = detachedWindows.get(panelKey)
  if (!entry || entry.window.isDestroyed() || !entry.view) return
  const bounds = entry.window.getContentBounds()
  try {
    entry.view.setBounds({ x: 0, y: 0, width: Math.max(0, bounds.width), height: Math.max(0, bounds.height) })
    // OTP/CAPTCHA popups ride with the detached tab: same content bounds so
    // they stay usable instead of orphaned over the main-window dashboard.
    for (const popup of entry.popups) {
      popup.setBounds({ x: 0, y: 0, width: Math.max(0, bounds.width), height: Math.max(0, bounds.height) })
    }
  } catch {
    // view already destroyed during teardown
  }
}

function removeDetachedWindow(panelKey: string): void {
  const entry = detachedWindows.get(panelKey)
  detachedWindows.delete(panelKey)
  if (entry && !entry.window.isDestroyed()) {
    try {
      entry.window.destroy()
    } catch {
      // ignore teardown races
    }
  }
}

function sanitizeWindowTitle(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 120) || "Supplier"
}

function registerDetachedViewHost(): void {
  setDetachedViewHost({
    openDetachedWindow: (panelKey, options) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const existing = detachedWindows.get(panelKey)
      if (existing && !existing.window.isDestroyed()) {
        existing.window.show()
        return
      }
      const win = new BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 800,
        minHeight: 540,
        // Label/accountName come from the engine's own panel registry, but a
        // window title is still plain OS text; strip control characters.
        title: `Return App · ${sanitizeWindowTitle(options.label)} (${sanitizeWindowTitle(options.accountName)})`,
        icon: iconFor(),
        backgroundColor: "#0b1311",
        autoHideMenuBar: true,
        show: false,
        // Hardened secondary window: the supplier page runs untrusted script,
        // so no Node in the renderer and the Chromium sandbox stays on.
        webPreferences: { ...DETACHED_WINDOW_WEB_PREFERENCES },
      })
      detachedWindows.set(panelKey, { window: win, view: null, popups: [] })
      win.on("resize", () => fitDetachedView(panelKey))
      win.once("ready-to-show", () => {
        if (!win.isDestroyed()) win.show()
      })
      // Closing the detached window docks the tab first: the live view leaves
      // this window before Chromium tears it down, so the session survives.
      win.on("close", () => {
        if (isQuitting) return
        handleDetachedWindowClosed(panelKey)
      })
      win.on("closed", () => {
        detachedWindows.delete(panelKey)
      })
    },
    attachDetachedView: (panelKey, view) => {
      const entry = detachedWindows.get(panelKey)
      if (!entry || entry.window.isDestroyed() || !view) return
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view)
      } catch {
        // the view was not a child of the main window
      }
      entry.view = view
      entry.window.contentView.addChildView(view)
      fitDetachedView(panelKey)
    },
    detachDetachedView: (panelKey, view) => {
      const entry = detachedWindows.get(panelKey)
      const liveView = view ?? entry?.view ?? null
      if (entry && !entry.window.isDestroyed() && liveView) {
        try {
          entry.window.contentView.removeChildView(liveView)
        } catch {
          // ignore teardown races
        }
      }
      if (entry) entry.view = null
    },
    attachDetachedPopups: (panelKey, popups) => {
      const entry = detachedWindows.get(panelKey)
      if (!entry || entry.window.isDestroyed()) return
      for (const popup of popups) {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(popup)
        } catch {
          // the popup was not a child of the main window
        }
        entry.window.contentView.addChildView(popup)
        if (!entry.popups.includes(popup)) entry.popups.push(popup)
      }
      fitDetachedView(panelKey)
    },
    detachDetachedPopups: (panelKey, popups) => {
      const entry = detachedWindows.get(panelKey)
      const live = popups.length ? popups : (entry?.popups ?? [])
      if (entry && !entry.window.isDestroyed()) {
        for (const popup of live) {
          try {
            entry.window.contentView.removeChildView(popup)
          } catch {
            // ignore teardown races
          }
        }
      }
      if (entry) entry.popups = []
    },
    closeDetachedWindow: (panelKey) => {
      const entry = detachedWindows.get(panelKey)
      if (entry && !entry.window.isDestroyed()) {
        entry.window.close()
      }
    },
    focusDetachedWindow: (panelKey) => {
      const entry = detachedWindows.get(panelKey)
      if (entry && !entry.window.isDestroyed()) {
        if (entry.window.isMinimized()) entry.window.restore()
        entry.window.show()
        entry.window.focus()
      }
    },
    isDetachedWindowOpen: (panelKey) => {
      const entry = detachedWindows.get(panelKey)
      return Boolean(entry && !entry.window.isDestroyed())
    },
    destroyDetachedWindow: (panelKey) => {
      removeDetachedWindow(panelKey)
    },
  })
}

/**
 * Save the update installer without leaving the app: the dashboard's update
 * link opens here instead of a system browser, and the operator runs the
 * downloaded `.exe` themselves.
 */
async function downloadUpdateAsset(url: string): Promise<void> {
  const fileName = decodeURIComponent(url.split("?")[0].split("/").pop() || "Return.App.Setup.exe")
  if (!fileName.toLowerCase().endsWith(".exe")) {
    logger.warn(`Blocked a non-installer popup inside the app window: ${url}`)
    return
  }
  const downloadsDir = app.getPath("downloads")
  fs.mkdirSync(downloadsDir, { recursive: true })
  const savePath = path.join(downloadsDir, fileName)
  logger.info(`Downloading the update installer to ${savePath}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`The update download answered HTTP ${res.status}.`)
  fs.writeFileSync(savePath, Buffer.from(await res.arrayBuffer()))
  if (Notification.isSupported()) {
    new Notification({
      title: "Return App update downloaded",
      body: `${fileName} is in Downloads. Close the app and run it to update; supplier cookies are kept.`,
    }).show()
  }
}

function createMainWindow(target: EngineTarget): void {
  const iconPath = iconFor()
  let appIcon: NativeImage | undefined
  if (fs.existsSync(iconPath)) {
    appIcon = nativeImage.createFromPath(iconPath)
  }

  // Persistent session partition so login ID, password, and session cookies persist forever
  const ses = session.fromPartition("persist:return-app-desktop")
  registerRendererProtocol(ses)

  // Every route except the health probe needs the bearer token whenever the
  // engine has one. That is always the remote engine, but also a *local* engine
  // bound to a non-loopback ENGINE_HOST: resolveEngineBind() gives that bind an
  // authToken too, because the port is reachable from outside this machine. The
  // token is injected for the ENGINE origin only, so the dashboard, panels, logs
  // and SSE stream all work. A loopback bind has an empty authToken, so this
  // stays a no-op in the normal single-machine case.
  //
  // This stays keyed to the engine origin on purpose: it must keep covering
  // renderer→engine fetches regardless of the renderer's own origin — the
  // bundled returnapp://desktop origin in production, or the Vite dev origin
  // (http://localhost:5180) in development. The renderer code never sees the
  // token; remote-engine bearer auth stays in this main process.
  const engineAuthToken = target.kind === "remote" ? target.token : target.bind.authToken
  if (engineAuthToken) {
    const origin = engineOrigin(target)
    ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
      details.requestHeaders["Authorization"] = `Bearer ${engineAuthToken}`
      callback({ requestHeaders: details.requestHeaders })
    })
  }

  // Same-window downloads (update installer, evidence exports): save to the
  // operator's Downloads folder and notify instead of opening a browser.
  ses.on("will-download", (_event, item) => {
    try {
      const fileName = item.getFilename() || "download"
      const savePath = path.join(app.getPath("downloads"), fileName)
      item.setSavePath(savePath)
      item.once("done", (_doneEvent, state) => {
        if (state === "completed") {
          logger.info(`Download finished: ${savePath}`)
          if (Notification.isSupported()) {
            new Notification({ title: "Return App download finished", body: fileName, silent: true }).show()
          }
        } else {
          logger.warn(`Download did not complete (${state}): ${fileName}`)
        }
      })
    } catch (err) {
      logger.warn("Could not handle the in-window download.", err)
    }
  })

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
      preload: path.join(__dirname, "..", "preload.cjs"),
      webSecurity: true,
      backgroundThrottling: true,
      spellcheck: false,
    },
  })

  // The main window owns every supplier browser view: marketplace work is
  // embedded here through WebContentsView, never a separate window.
  registerSupplierViewHost()
  registerDetachedViewHost()
  // Bounds follow the window, not just its size: a resize, move, maximize,
  // unmaximize, display move or DPI change re-fits the supplier view into the
  // dashboard workspace rect — or hides it when no valid rect is reported.
  mainWindow.on("resize", () => notifyWindowGeometryChanged("resize"))
  mainWindow.on("move", () => notifyWindowGeometryChanged("move"))
  mainWindow.on("maximize", () => {
    notifyWindowGeometryChanged("maximize")
    notifyWindowLifecycleFromShell("maximize")
  })
  mainWindow.on("unmaximize", () => {
    notifyWindowGeometryChanged("unmaximize")
    notifyWindowLifecycleFromShell("restore")
  })
  screen.on("display-metrics-changed", () => notifyWindowGeometryChanged("display-metrics-changed"))

  // Lifecycle: minimize/restore keep every tab session; restore re-syncs the
  // supplier view bounds after a maximize or tray restore.
  mainWindow.on("minimize", () => notifyWindowLifecycleFromShell("minimize"))
  mainWindow.on("restore", () => notifyWindowLifecycleFromShell("restore"))

  mainWindow.once("ready-to-show", () => {
    if (!startHidden) mainWindow?.show()
  })

  // The shell loads the bundled React renderer, never the engine dashboard.
  // Engine reachability is the renderer's own concern: it probes the engine
  // API (/api/health) through the fetch bridge and renders its
  // offline/connecting state from failed calls.
  const shellUrl = rendererUrl()

  logger.info(`Opening desktop shell at ${shellUrl} (engine: ${target.url})`)
  mainWindow.loadURL(shellUrl).catch((err) => {
    logger.error("Failed to open the desktop shell window:", err)
  })

  // The window hosts only the bundled renderer (or the Vite dev origin in
  // development). Exact-origin check: the ENGINE origin is the API base for
  // fetch/XHR through the preload bridge, never a navigable page in this
  // window — and neither is anything else (file://, https://, data:).
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isRendererNavigation(url, shellUrl)) {
      logger.warn(`Blocked navigation away from the desktop renderer origin: ${url}`)
      event.preventDefault()
    }
  })

  // A failed RENDERER load is retried once. An engine outage does not surface
  // here: renderer assets come from the app itself (returnapp://) or the dev
  // server, while engine connectivity shows up as failed API calls inside the
  // renderer, which renders its own offline/connecting state.
  let rendererRetryScheduled = false
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return // ERR_ABORTED: navigation cancelled, not a real load failure
    if (validatedURL && !isRendererNavigation(validatedURL, shellUrl)) return
    logger.warn(`Desktop renderer failed to load (${errorCode}: ${errorDescription})`)
    if (rendererRetryScheduled) return
    rendererRetryScheduled = true
    setTimeout(() => {
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(shellUrl).catch((err) => {
          logger.error("Retrying the desktop shell load failed:", err)
        })
      }
    }, 3000)
  })
  mainWindow.webContents.on("did-finish-load", () => {
    rendererRetryScheduled = false
  })

  // No system browser: popups are denied, and an installer link downloads the
  // `.exe` into Downloads so the operator can run it themselves.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) {
      void downloadUpdateAsset(url).catch((err) => {
        logger.warn("The in-app update download failed.", err)
      })
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
      notifyWindowLifecycleFromShell("hide-to-tray")
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
  const iconPath = iconFor()
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
            notifyWindowLifecycleFromShell("restore-from-tray")
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
      notifyWindowLifecycleFromShell("restore-from-tray")
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

ipcMain.handle("desktop:get-app-info", async () => ({
  version: app.getVersion(),
  platform: process.platform,
  isPackaged: app.isPackaged,
}))

// The engine API base for the renderer. The token is deliberately never
// exposed here: remote-engine bearer auth stays in this main process (the
// webRequest injection above), and an empty url means "engine still starting".
ipcMain.handle("desktop:get-engine-target", async () => {
  const target = engineTarget
  return { kind: target?.kind ?? ("local" as const), url: target?.url ?? "" }
})

ipcMain.handle("desktop:get-bot-status", async () => shellStatus())

ipcMain.handle("desktop:toggle-bot", async () => toggleWorker())

/**
 * Dashboard workspace rect (DIPs, relative to the window content area).
 * The dashboard reports the rect of its browser viewport so the supplier
 * view shares the window with the sidebar and layout controls instead of
 * covering them. A null rect (non-Browsers sidebar tab) hides the view
 * while preserving its session. Malformed rects are ignored.
 */
ipcMain.on("desktop:browser-rect", (_event, rect) => {
  if (rect === null || rect === undefined) {
    setBrowserWorkspaceRect(null)
    return
  }
  if (typeof rect !== "object") return
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const x = num((rect as Record<string, unknown>).x)
  const y = num((rect as Record<string, unknown>).y)
  const width = num((rect as Record<string, unknown>).width)
  const height = num((rect as Record<string, unknown>).height)
  if (x === null || y === null || width === null || height === null) return
  if (width < 0 || height < 0) return
  setBrowserWorkspaceRect({ x, y, width, height })
})

/**
 * Explicit user-triggered fullscreen/expand mode for the supplier browser.
 * Sent only by the renderer's Expand / Exit Fullscreen button and its Escape
 * shortcut — never by background polling or worker steps.
 */
ipcMain.on("desktop:browser-fullscreen", (_event, fullscreen) => {
  setFullscreenSupplierView(fullscreen === true)
})

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
 * bound so a genuine configuration error does not loop forever; the bundled
 * renderer keeps showing its connecting state in the meantime.
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
        // injection is the placeholder's. A retry can bind a different origin
        // than the placeholder (a non-loopback ENGINE_HOST, or a port that
        // changed), and then every protected request from that window answers
        // 401. Rebuild the window for the real target instead of loading its
        // URL into the old one. The rebuilt window loads the same bundled
        // renderer URL; only the engine-side wiring (auth header injection)
        // changes.
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
 * Windows-only desktop: Electron's setLoginItemSettings() writes the Windows
 * registry entry. The installer also registers the ReturnAppClaimBot scheduled
 * task, which relaunches the bot after a crash.
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

  if (process.platform !== "win32") {
    logger.warn("Start-at-login is only supported on Windows in this build.")
    return
  }
  app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] })
}

app.whenReady().then(async () => {
  process.env.RETURN_APP_VERSION = app.getVersion()

  registerRendererProtocol()
  registerAutoStart()

  let startupError: string | undefined
  try {
    engineTarget = await resolveEngineTarget()
  } catch (err) {
    startupError = err instanceof Error ? err.message : "The engine could not start."
    logger.error("Claim bot engine failed to start. Scanning was not opened.", err)
  }

  // Even with no engine, show the shell so the operator can see the renderer's
  // connecting state; the retry loop may still bring the engine up.
  const fallbackTarget: EngineTarget = {
    kind: "local",
    bind: { host: "127.0.0.1", port: 3005, mode: "local", remoteAccess: false, authToken: "" },
    url: "http://127.0.0.1:3005/",
  }
  createMainWindow(engineTarget ?? fallbackTarget)
  createTray()
  startBotStatusPush()

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
  notifyWindowLifecycleFromShell("before-quit")
  disposeDetachedSupplierViews()
})

app.on("window-all-closed", () => {
  // Windows-only: keep the 24/7 bot in the tray after the window closes.
  if (isQuitting) {
    app.quit()
  }
})
