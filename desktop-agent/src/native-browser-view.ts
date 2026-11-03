import type { SupplierBrowserApi, SupplierBrowserHandle, SupplierBrowserOptions } from "./browser-adapter.js"
import { logger } from "./logger.js"

/**
 * Native supplier browser: the desktop app's bundled Chromium through `WebContentsView`.
 *
 * Desktop-only and the default inside the desktop app (override with `BROWSER_ADAPTER=external`). Each marketplace panel gets
 * its own isolated, persistent Electron session (`persist:supplier-<panelKey>`),
 * so cookies and sign-in survive app restarts and updates. Nothing is ever copied
 * from the external system-browser profiles: the first run on the native adapter
 * signs in fresh on its own partition, and the engine asks for login only when
 * that session is expired, revoked, or invalid.
 *
 * Lifetime is lazy: a panel's view is created on first use and torn down after
 * the job/follow-up finishes, while the partition (cookies) persists. In the
 * packaged app the view attaches to the shell's main window (registered via
 * `setSupplierViewHost`) — never a per-panel `BrowserWindow`. The view is
 * attached on screen only when the operator must step in (OTP/CAPTCHA,
 * assisted submit); automation itself runs detached so the warehouse PC stays
 * usable.
 *
 * Concurrency: the caller (engine worker / follow-up worker via poll-guard.ts)
 * guarantees at most one driver per panel at a time. This module adds a second
 * per-panel mutex so two opens can never attach two views to one partition.
 *
 * This module must stay import-safe outside Electron: `electron` is imported
 * dynamically inside the open path only. Importing this file on a headless
 * Linux server or in a unit test must never throw.
 */

type ElectronApi = typeof import("electron")

const PARTITION_PREFIX = "persist:supplier-"

const panelLocks = new Map<string, Promise<unknown>>()

async function withPanelLock<T>(panelKey: string, work: () => Promise<T>): Promise<T> {
  const previous = panelLocks.get(panelKey) || Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  panelLocks.set(
    panelKey,
    previous.then(() => current),
  )
  await previous
  try {
    return await work()
  } finally {
    release()
  }
}

function requireElectronMain(electron: ElectronApi): void {
  if (!electron.app || typeof electron.BrowserWindow === "undefined") {
    throw new Error("The native supplier browser needs the Electron main process.")
  }
}

/**
 * Main-window host for supplier views, provided by the Electron shell
 * (`desktop/main.ts` registers the single app window after creating it).
 *
 * Supplier `WebContentsView`s are attached to this host instead of to a
 * per-panel `BrowserWindow`, so marketplace work always happens inside the
 * main application window. The interface is structural (not the Electron
 * `BrowserWindow` type) so the manager stays unit-testable with fakes and
 * the engine stays import-safe outside Electron.
 */
export type SupplierViewHost = {
  addView(view: Electron.CrossProcessExports.WebContentsView): void
  removeView(view: Electron.CrossProcessExports.WebContentsView): void
  contentBounds(): { x: number; y: number; width: number; height: number }
  showWindow(): void
  focusWindow(): void
  isWindowDestroyed(): boolean
}

let supplierViewHost: SupplierViewHost | null = null

/**
 * Dashboard-owned workspace rect (DIPs, relative to the window content area).
 * When set, visible supplier views are fitted to this rect so the dashboard
 * keeps its layout controls visible; when null, views fill the window as
 * before. The dashboard reports it over IPC and clears it on hide.
 */
let browserWorkspaceRect: { x: number; y: number; width: number; height: number } | null = null

/** Confine the supplier view to the dashboard workspace rect. Null restores full-window layout. */
export function setBrowserWorkspaceRect(rect: { x: number; y: number; width: number; height: number } | null): void {
  browserWorkspaceRect = rect
  layoutSupplierViews()
}

/** The active workspace rect, if the dashboard set one. Exported for tests and the shell. */
export function getBrowserWorkspaceRect(): { x: number; y: number; width: number; height: number } | null {
  return browserWorkspaceRect ? { ...browserWorkspaceRect } : null
}

/** Visible-view bounds: the workspace rect clamped into the window, or the full window. */
export function supplierViewBounds(): { x: number; y: number; width: number; height: number } {
  const host = supplierViewHost
  const full = host && !host.isWindowDestroyed()
    ? host.contentBounds()
    : { x: 0, y: 0, width: 0, height: 0 }
  const rect = browserWorkspaceRect
  if (!rect) return full
  const x = Math.min(Math.max(0, rect.x), Math.max(0, full.width - 1))
  const y = Math.min(Math.max(0, rect.y), Math.max(0, full.height - 1))
  return {
    x,
    y,
    width: Math.min(Math.max(0, rect.width), Math.max(0, full.width - x)),
    height: Math.min(Math.max(0, rect.height), Math.max(0, full.height - y)),
  }
}

/** Register (or clear) the main-window host. Called once by the Electron shell. */
export function setSupplierViewHost(host: SupplierViewHost | null): void {
  supplierViewHost = host
  layoutSupplierViews()
}

type ManagedSupplierView = {
  view: Electron.CrossProcessExports.WebContentsView
  visible: boolean
  popups: Electron.CrossProcessExports.WebContentsView[]
}

const managedSupplierViews = new Map<string, ManagedSupplierView>()

/** Track a supplier view in the main-window manager. Exported for tests and the shell. */
export function registerSupplierView(panelKey: string, view: Electron.CrossProcessExports.WebContentsView): void {
  const existing = managedSupplierViews.get(panelKey)
  if (existing && existing.view === view) return
  managedSupplierViews.set(panelKey, { view, visible: existing?.visible ?? false, popups: [] })
}

/** Drop a supplier view from the main-window manager. Exported for tests and the shell. */
export function unregisterSupplierView(panelKey: string, view: Electron.CrossProcessExports.WebContentsView): void {
  const existing = managedSupplierViews.get(panelKey)
  if (existing && existing.view === view) managedSupplierViews.delete(panelKey)
}

/** Dashboard/engine status: which panels own an in-window supplier view. */
export function supplierViewStatus(): Array<{ panelKey: string; visible: boolean }> {
  return [...managedSupplierViews.entries()].map(([panelKey, entry]) => ({ panelKey, visible: entry.visible }))
}

/** Re-fit every visible supplier view after the window resizes, moves, or the display scale changes. */
export function layoutSupplierViews(): void {
  const host = supplierViewHost
  if (!host || host.isWindowDestroyed()) return
  const bounds = supplierViewBounds()
  for (const entry of managedSupplierViews.values()) {
    if (!entry.visible) continue
    for (const popup of entry.popups) {
      try {
        popup.setBounds(bounds)
      } catch {
        // A destroyed popup is unregistered on close; ignore the race here.
      }
    }
    try {
      entry.view.setBounds(bounds)
    } catch {
      // A destroyed view is unregistered on close; ignore the race here.
    }
  }
}

/** Detach every visible supplier view (sessions keep their cookies). Returns the hidden panels. */
export function hideSupplierViews(): string[] {
  const host = supplierViewHost
  const hidden: string[] = []
  for (const [panelKey, entry] of managedSupplierViews) {
    if (!entry.visible) continue
    entry.visible = false
    try {
      host?.removeView(entry.view)
    } catch {
      // ignore teardown races
    }
    for (const popup of entry.popups) {
      try {
        host?.removeView(popup)
      } catch {
        // ignore teardown races
      }
    }
    hidden.push(panelKey)
  }
  return hidden
}

/** Attach a panel's view to the main window (tab-switch back from the dashboard). */
export function showSupplierView(panelKey: string): boolean {
  const host = supplierViewHost
  const entry = managedSupplierViews.get(panelKey)
  if (!host || host.isWindowDestroyed() || !entry) return false
  if (!entry.visible) {
    try {
      host.removeView(entry.view)
    } catch {
      // ensure a single attach
    }
    host.addView(entry.view)
    entry.view.setBounds(supplierViewBounds())
    for (const popup of entry.popups) {
      try {
        host.removeView(popup)
      } catch {
        // ensure a single attach
      }
      host.addView(popup)
      popup.setBounds(supplierViewBounds())
    }
    entry.visible = true
  }
  host.showWindow()
  host.focusWindow()
  return true
}

async function elementCenter(
  contents: Electron.CrossProcessExports.WebContents,
  selector: string,
): Promise<{ x: number; y: number } | null> {
  const rect = await contents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; ` +
      `const r = el.getBoundingClientRect(); ` +
      `if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" }); ` +
      `return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`,
  )
  if (!rect || typeof rect.x !== "number") return null
  return { x: Math.round(rect.x), y: Math.round(rect.y) }
}

class NativeSupplierBrowser implements SupplierBrowserApi {
  private view: Electron.CrossProcessExports.WebContentsView | null = null
  private host: Electron.CrossProcessExports.BrowserWindow | null = null
  private ownedHost = false

  constructor(
    private electron: ElectronApi,
    private options: SupplierBrowserOptions,
  ) {}

  get profileDirectory(): string {
    // Partition-backed: Electron owns the cookie store, identified by partition.
    return `${PARTITION_PREFIX}${this.options.panelKey}`
  }

  async open(): Promise<void> {
    const { BrowserWindow, WebContentsView } = this.electron
    requireElectronMain(this.electron)
    const partition = `${PARTITION_PREFIX}${this.options.panelKey}`
    const shellHost = supplierViewHost && !supplierViewHost.isWindowDestroyed() ? supplierViewHost : null
    if (shellHost) {
      // Main-window embedding (packaged app): the shell owns the window, so
      // no per-panel BrowserWindow is ever created. The view stays detached
      // — off-screen but fully functional for automation — until
      // showForManualStep() attaches it to the main window.
      if (!this.view) {
        this.view = new WebContentsView({
          webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
        })
        this.attachViewHandlers()
        registerSupplierView(this.options.panelKey, this.view)
      }
      this.ownedHost = false
      return
    }
    if (!this.host || (this.host as unknown as { isDestroyed?: () => boolean }).isDestroyed?.()) {
      this.host = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        autoHideMenuBar: true,
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      })
      this.ownedHost = true
      this.host.on("closed", () => {
        this.host = null
        this.view = null
      })
    }
    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      })
      this.host.contentView.addChildView(this.view)
      this.view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
      // Operator-visible only when manual completion is needed (OTP/CAPTCHA,
      // assisted submit). Automation runs headless-in-window otherwise.
      this.attachViewHandlers()
      registerSupplierView(this.options.panelKey, this.view)
    }
  }

  /** Bring the panel on screen so the operator can complete OTP/CAPTCHA by hand. */
  async showForManualStep(): Promise<void> {
    if (this.view && supplierViewHost && !supplierViewHost.isWindowDestroyed()) {
      showSupplierView(this.options.panelKey)
      return
    }
    this.host?.show()
    this.host?.focus()
  }

  /** Popup, download and lifecycle wiring shared by both host paths. */
  private attachViewHandlers(): void {
    if (!this.view) return
    // Operator-visible only when manual completion is needed (OTP/CAPTCHA,
    // assisted submit). Automation runs headless-in-window otherwise.
    this.view.webContents.on("dom-ready", () => undefined)
    this.contents.setWindowOpenHandler(({ url }) => {
      // Authenticated popups stay in-app on the panel's own partition: they
      // are attached to the main window, never a system browser and never a
      // second app window.
      void this.openPopupInApp(url).catch((err) => {
        logger.warn(`Native adapter: could not open the in-app popup for ${this.options.panelKey}.`, err)
      })
      return { action: "deny" }
    })
    try {
      this.contents.session.on("will-download", (_event, item) => {
        void this.savePortalDownload(item).catch((err) => {
          logger.warn(`Native adapter: could not save the portal download for ${this.options.panelKey}.`, err)
        })
      })
    } catch {
      // Sessions without download support (unit tests): downloads stay manual.
    }
  }

  private async openPopupInApp(url: string): Promise<void> {
    const { WebContentsView } = this.electron
    const popup = new WebContentsView({
      webPreferences: {
        partition: `${PARTITION_PREFIX}${this.options.panelKey}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const entry = managedSupplierViews.get(this.options.panelKey)
    if (entry && entry.view === this.view) entry.popups.push(popup)
    popup.webContents.once("destroyed", () => {
      try {
        supplierViewHost?.removeView(popup)
      } catch {
        // ignore teardown races
      }
      const live = managedSupplierViews.get(this.options.panelKey)
      if (live) live.popups = live.popups.filter((candidate) => candidate !== popup)
    })
    await popup.webContents.loadURL(url)
    const host = supplierViewHost
    if (host && !host.isWindowDestroyed()) {
      try {
        host.removeView(popup)
      } catch {
        // ensure a single attach
      }
      host.addView(popup)
      popup.setBounds(supplierViewBounds())
      host.showWindow()
    } else if (this.host) {
      this.host.contentView.addChildView(popup)
      popup.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
      await this.showForManualStep()
    }
  }

  private async savePortalDownload(item: Electron.CrossProcessExports.DownloadItem): Promise<void> {
    const fileName = item.getFilename() || `portal-download-${Date.now()}`
    const { default: nodePath } = await import("node:path")
    const { default: fs } = await import("node:fs")
    const downloadsDir = this.electron.app.getPath("downloads")
    // Synchronous on purpose: setSavePath below must run before will-download
    // returns, so this metadata call stays on the main thread.
    fs.mkdirSync(downloadsDir, { recursive: true })
    const savePath = nodePath.join(downloadsDir, fileName)
    item.setSavePath(savePath)
    await new Promise<void>((resolve) => {
      item.once("done", (_event, state) => {
        if (state === "completed") {
          logger.info(`Portal download saved: ${savePath}`)
        } else {
          logger.warn(`Portal download did not complete (${state}): ${fileName}`)
        }
        resolve()
      })
    })
    await this.showForManualStep()
  }

  private get contents(): Electron.CrossProcessExports.WebContents {
    if (!this.view) throw new Error("Native supplier browser is not open.")
    return this.view.webContents
  }

  async connectToPage(_port: number): Promise<void> {
    // No CDP port on the native adapter: the view is already attached.
  }

  async send(_method: string, _params: Record<string, unknown> = {}): Promise<unknown> {
    throw new Error("Raw CDP send() is external-adapter only; use the typed helpers on the native adapter.")
  }

  async navigate(url: string): Promise<void> {
    await this.contents.loadURL(url)
  }

  async evaluate<T>(expression: string): Promise<T> {
    return this.contents.executeJavaScript(expression) as Promise<T>
  }

  async captureScreenshot(outputPath: string): Promise<string> {
    const image = await this.contents.capturePage()
    const { default: fsp } = await import("node:fs/promises")
    await fsp.writeFile(outputPath, image.toPNG())
    return outputPath
  }

  async detectCaptchaOrOtp(): Promise<{ challengeDetected: boolean; reason?: string }> {
    const hit = await this.evaluate<string | null>(
      `(() => { const text = (document.body ? document.body.innerText : "").toLowerCase(); ` +
        `for (const needle of ["captcha", "otp", "one-time pass", "verify you are human", "enter the code"]) { ` +
        `if (text.includes(needle)) return needle; } return null; })()`,
    ).catch(() => null)
    if (hit) {
      void this.showForManualStep()
      return { challengeDetected: true, reason: `Page asks for "${hit}". Shown for manual completion.` }
    }
    return { challengeDetected: false }
  }

  async delay(ms = 1000): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  async humanType(selector: string, text: string): Promise<boolean> {
    const center = await elementCenter(this.contents, selector)
    if (!center) return false
    this.contents.sendInputEvent({ type: "mouseDown", x: center.x, y: center.y, button: "left", clickCount: 1 } as never)
    this.contents.sendInputEvent({ type: "mouseUp", x: center.x, y: center.y, button: "left", clickCount: 1 } as never)
    for (const char of text) {
      this.contents.sendInputEvent({ type: "char", keyCode: char } as never)
    }
    return true
  }

  async humanClick(selector: string): Promise<boolean> {
    const center = await elementCenter(this.contents, selector)
    if (!center) return false
    this.contents.sendInputEvent({ type: "mouseDown", x: center.x, y: center.y, button: "left", clickCount: 1 } as never)
    this.contents.sendInputEvent({ type: "mouseUp", x: center.x, y: center.y, button: "left", clickCount: 1 } as never)
    return true
  }

  async clickByTextIncludes(text: string): Promise<boolean> {
    return this.evaluate<boolean>(
      `(() => { const want = ${JSON.stringify(text.toLowerCase())}; ` +
        `const els = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]")); ` +
        `const el = els.find((e) => (e.textContent || e.value || "").toLowerCase().includes(want)); ` +
        `if (!el) return false; el.click(); return true; })()`,
    ).catch(() => false)
  }

  async clickByExactText(text: string): Promise<boolean> {
    return this.evaluate<boolean>(
      `(() => { const want = ${JSON.stringify(text.trim().toLowerCase())}; ` +
        `const els = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]")); ` +
        `const el = els.find((e) => ((e.textContent || e.value || "").trim().toLowerCase() === want)); ` +
        `if (!el) return false; el.click(); return true; })()`,
    ).catch(() => false)
  }

  async clickVisibleLabel(text: string): Promise<boolean> {
    return this.clickByTextIncludes(text)
  }

  async clickLabelInDom(text: string): Promise<{ clicked: boolean; href: string }> {
    const clicked = await this.clickByTextIncludes(text)
    const href = await this.evaluate<string>(
      `(() => { const want = ${JSON.stringify(text.toLowerCase())}; ` +
        `const a = Array.from(document.querySelectorAll("a")).find((e) => (e.textContent || "").toLowerCase().includes(want)); ` +
        `return a ? a.href : ""; })()`,
    ).catch(() => "")
    return { clicked, href }
  }

  async uploadViaChooser(_buttonText: string, _filePath: string): Promise<boolean> {
    // Guided uploads on the native adapter go through setFileInputFiles against
    // the chooser's input element; OS-level chooser automation is intentionally
    // unsupported so the operator always sees what leaves the PC.
    return false
  }

  async setFileInputFiles(selector: string, filePaths: string[]): Promise<boolean> {
    // Every path must exist locally: reporting success for a missing file
    // would file a claim whose evidence never left the PC.
    const { default: fs } = await import("node:fs")
    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        logger.warn(`Native adapter: evidence file is missing on disk: ${filePath}`)
        return false
      }
    }
    const found = await this.evaluate<boolean>(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    ).catch(() => false)
    if (!found) {
      logger.warn(`Native adapter: no file input matches ${selector}.`)
      return false
    }
    // Electron has no silent file-chooser automation on purpose, but the main
    // process can set the input through the debugger protocol â€” the same
    // mechanism the external adapter uses over CDP. Anything that fails here
    // (an already-attached debugger, a detached view) returns false and shows
    // the panel, so the operator completes the pick by hand.
    try {
      const debuggerApi = this.contents.debugger
      debuggerApi.attach("1.3")
      try {
        const doc = (await debuggerApi.sendCommand("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } }
        const match = (await debuggerApi.sendCommand("DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector,
        })) as { nodeId?: number }
        if (!match || typeof match.nodeId !== "number") return false
        await debuggerApi.sendCommand("DOM.setFileInputFiles", { nodeId: match.nodeId, files: filePaths })
      } finally {
        debuggerApi.detach()
      }
    } catch (err) {
      logger.warn(`Native adapter: debugger file attach failed for ${selector}; showing the panel for a manual pick.`, err)
      await this.showForManualStep()
      return false
    }
    await this.delay(500)
    // Confirm through the page itself: the input must hold the files, not
    // merely exist. A zero count means the portal rejected the attach.
    const attached = await this.evaluate<number>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `return el && el.files ? el.files.length : 0; })()`,
    ).catch(() => 0)
    if (attached <= 0) {
      logger.warn(`Native adapter: ${selector} still holds no files after attach; showing the panel for a manual pick.`)
      await this.showForManualStep()
      return false
    }
    return true
  }

  async close(): Promise<void> {
    try {
      if (this.view) {
        try {
          supplierViewHost?.removeView(this.view)
        } catch {
          // ignore teardown races
        }
        const entry = managedSupplierViews.get(this.options.panelKey)
        if (entry && entry.view === this.view) {
          for (const popup of entry.popups) {
            try {
              supplierViewHost?.removeView(popup)
            } catch {
              // ignore teardown races
            }
          }
        }
        unregisterSupplierView(this.options.panelKey, this.view)
        if (this.host) {
          this.host.contentView.removeChildView(this.view)
        }
      }
    } catch {
      // Teardown best-effort: partitions persist, views do not need to.
    }
    this.view = null
    if (this.ownedHost && this.host) {
      try {
        if (!(this.host as unknown as { isDestroyed?: () => boolean }).isDestroyed?.()) this.host.close()
      } catch {
        // ignore
      }
      this.host = null
    }
  }
}

export async function openNativeSupplierBrowser(options: SupplierBrowserOptions): Promise<SupplierBrowserHandle> {
  if (!(process as unknown as { versions?: Record<string, string> }).versions?.electron) {
    throw new Error("BROWSER_ADAPTER=native needs the Electron desktop shell (bundled Chromium).")
  }
  const electron = (await import("electron")) as ElectronApi
  requireElectronMain(electron)
  return withPanelLock(options.panelKey, async () => {
    const browser = new NativeSupplierBrowser(electron, options)
    await browser.open()
    return {
      kind: "native" as const,
      browser,
      close: () => browser.close(),
    }
  })
}
