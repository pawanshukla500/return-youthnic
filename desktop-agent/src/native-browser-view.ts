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

const chromeMajor = process.versions?.chrome ? process.versions.chrome.split(".")[0] : "131"

/** Standard genuine Chrome User-Agent header string matching Chromium engine version without automation flags. */
export const STANDARD_CHROME_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`

const configuredSessions = new WeakSet<object>()

/**
 * Injects genuine Chrome identity and client hints (sec-ch-ua) into marketplace session headers
 * to prevent automated browser detection by anti-bot WAFs (such as Akamai EdgeSuite on Meesho).
 */
export function configureSupplierSessionHeaders(sessionObj: unknown): void {
  if (!sessionObj || typeof sessionObj !== "object") return
  if (configuredSessions.has(sessionObj)) return
  configuredSessions.add(sessionObj)

  const ses = sessionObj as {
    setUserAgent?: (ua: string) => void
    webRequest?: {
      onBeforeSendHeaders?: (
        filter: unknown,
        listener: (
          details: { requestHeaders: Record<string, string>; url: string },
          callback: (response: { requestHeaders: Record<string, string> }) => void,
        ) => void,
      ) => void
    }
  }

  if (typeof ses.setUserAgent === "function") {
    ses.setUserAgent(STANDARD_CHROME_USER_AGENT)
  }

  if (ses.webRequest && typeof ses.webRequest.onBeforeSendHeaders === "function") {
    ses.webRequest.onBeforeSendHeaders(
      {
        urls: [
          "*://*.meesho.com/*",
          "*://supplier.meesho.com/*",
          "*://*.flipkart.com/*",
          "*://*.amazon.in/*",
          "*://*.myntra.com/*",
          "*://*.ajio.com/*",
        ],
      },
      (details, callback) => {
        const headers = details.requestHeaders || {}
        headers["sec-ch-ua"] = `"Google Chrome";v="${chromeMajor}", "Chromium";v="${chromeMajor}", "Not_A Brand";v="24"`
        headers["sec-ch-ua-mobile"] = "?0"
        headers["sec-ch-ua-platform"] = '"Windows"'
        callback({ requestHeaders: headers })
      },
    )
  }
}

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
 * Visible supplier views are fitted to this rect so the dashboard keeps its
 * sidebar, header, and controls visible. Fail-closed: when null (the Browsers
 * sidebar tab is inactive) or smaller than the minimum valid bounds, no view
 * is shown at all — never a full-window fallback.
 */
let browserWorkspaceRect: { x: number; y: number; width: number; height: number } | null = null

/**
 * Explicit user-triggered fullscreen/expand mode. Set only from the renderer's
 * Expand button; cleared by the Exit Fullscreen button or the Escape key. It
 * is the only path that shows the active view across the full window.
 */
let fullscreenSupplierView = false

/** Minimum valid workspace size in DIPs. Smaller rects hide the view. */
export const MIN_SUPPLIER_VIEW_SIZE = 120

/** Confine the supplier view to the dashboard workspace rect. Null hides every view. */
export function setBrowserWorkspaceRect(rect: { x: number; y: number; width: number; height: number } | null): void {
  browserWorkspaceRect = rect
  layoutSupplierViews()
  const bounds = supplierViewBounds()
  if (bounds === null) hideSupplierViews()
}

/** The active workspace rect, if the dashboard set one. Exported for tests and the shell. */
export function getBrowserWorkspaceRect(): { x: number; y: number; width: number; height: number } | null {
  return browserWorkspaceRect ? { ...browserWorkspaceRect } : null
}

/** Explicit fullscreen/expand state. True only after the operator clicks Expand. */
export function isFullscreenSupplierView(): boolean {
  return fullscreenSupplierView
}

/** Enter or exit explicit fullscreen mode, then re-fit the visible views. */
export function setFullscreenSupplierView(fullscreen: boolean): void {
  fullscreenSupplierView = fullscreen
  layoutSupplierViews()
  const bounds = supplierViewBounds()
  if (bounds === null) hideSupplierViews()
}

/**
 * Visible-view bounds: the workspace rect clamped into the window, or null to
 * hide the view. Null whenever the Browsers tab is inactive (rect is null) or
 * the rect is smaller than 120x120, unless explicit fullscreen mode is active.
 */
export function supplierViewBounds(): { x: number; y: number; width: number; height: number } | null {
  const host = supplierViewHost
  const full = host && !host.isWindowDestroyed()
    ? host.contentBounds()
    : { x: 0, y: 0, width: 0, height: 0 }
  if (fullscreenSupplierView) return full
  const rect = browserWorkspaceRect
  if (!rect) return null
  if (rect.width < MIN_SUPPLIER_VIEW_SIZE || rect.height < MIN_SUPPLIER_VIEW_SIZE) return null
  const x = Math.min(Math.max(0, rect.x), Math.max(0, full.width - 1))
  const y = Math.min(Math.max(0, rect.y), Math.max(0, full.height - 1))
  return {
    x,
    y,
    width: Math.min(Math.max(0, rect.width), Math.max(0, full.width - x)),
    height: Math.min(Math.max(0, rect.height), Math.max(0, full.height - y)),
  }
}

/**
 * Re-fit visible views after a window/display geometry change (resize, move,
 * maximize, unmaximize, display-metrics-changed). A null bounds hides the
 * views instead of leaving stale coordinates on screen.
 */
export function notifyWindowGeometryChanged(_event: "resize" | "move" | "maximize" | "unmaximize" | "display-metrics-changed"): void {
  layoutSupplierViews()
  if (supplierViewBounds() === null) hideSupplierViews()
}

/** Register (or clear) the main-window host. Called once by the Electron shell. */
export function setSupplierViewHost(host: SupplierViewHost | null): void {
  supplierViewHost = host
  layoutSupplierViews()
}

/**
 * Hardened webPreferences shared by every detached supplier BrowserWindow.
 * The secondary window only hosts the existing WebContentsView session — it
 * never runs Node in the renderer and never relaxes the Chromium sandbox.
 */
export const DETACHED_WINDOW_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const

/** Structural host for detached supplier windows (Electron shell or tests). */
export type DetachedViewHost = {
  openDetachedWindow(panelKey: string, options: { label: string; accountName: string; partition: string }): void
  attachDetachedView(panelKey: string, view: Electron.CrossProcessExports.WebContentsView | null): void
  detachDetachedView(panelKey: string, view: Electron.CrossProcessExports.WebContentsView | null): void
  /** Move the tab's OTP/CAPTCHA popups into the detached window with the main view. */
  attachDetachedPopups(panelKey: string, popups: Array<Electron.CrossProcessExports.WebContentsView>): void
  /** Remove the tab's popups from the detached window before it closes or docks. */
  detachDetachedPopups(panelKey: string, popups: Array<Electron.CrossProcessExports.WebContentsView>): void
  closeDetachedWindow(panelKey: string): void
  focusDetachedWindow(panelKey: string): void
  isDetachedWindowOpen(panelKey: string): boolean
  destroyDetachedWindow(panelKey: string): void
}

let detachedViewHost: DetachedViewHost | null = null

/** Register (or clear) the detached-window host. Called once by the Electron shell. */
export function setDetachedViewHost(host: DetachedViewHost | null): void {
  detachedViewHost = host
}

const detachedTabPanels = new Set<string>()

/** Whether the tab currently lives in the detached secondary window. */
export function isSupplierTabDetached(panelKey: string): boolean {
  const resolved = resolveStoredPanelKey(panelKey)
  return resolved !== null && detachedTabPanels.has(resolved)
}

/**
 * Move a tab's live WebContentsView into the dedicated detached BrowserWindow.
 * The main-window placeholder flips to mode "detached"; cookies, DOM state,
 * and the worker lease ride along with the view. Open OTP/CAPTCHA popups move
 * with it: leaving them attached to the main window would orphan them over the
 * dashboard while their session lives in the detached window.
 */
export function detachSupplierTab(tabId: string): SupplierTabState | null {
  const resolved = resolveStoredPanelKey(tabId)
  if (!resolved) return null
  const known = tabMetadata.has(resolved) || managedSupplierViews.has(resolved)
  if (!known) return null
  const panelKey = resolved
  const meta = metadataFor(panelKey, managedSupplierViews.get(panelKey))
  openSupplierTab(panelKey)
  const entry = managedSupplierViews.get(panelKey)
  if (entry?.visible) {
    entry.visible = false
    try {
      supplierViewHost?.removeView(entry.view as Electron.CrossProcessExports.WebContentsView)
    } catch {
      // ignore teardown races
    }
    for (const popup of entry.popups) {
      try {
        supplierViewHost?.removeView(popup)
      } catch {
        // ignore teardown races
      }
    }
  }
  detachedTabPanels.add(panelKey)
  try {
    detachedViewHost?.openDetachedWindow(panelKey, {
      label: meta.label,
      accountName: meta.accountName,
      partition: `${PARTITION_PREFIX}${panelKey}`,
    })
    detachedViewHost?.attachDetachedView(panelKey, entry?.view ?? null)
    detachedViewHost?.attachDetachedPopups(panelKey, entry?.popups ?? [])
  } catch {
    // A headless/test shell keeps the detached bookkeeping without a window.
  }
  const tab = supplierTabRegistry().find((candidate) => candidate.panelKey === panelKey) || null
  return tab
}

/** Focus the detached secondary window. Never touches the main window. */
export function focusDetachedSupplierTab(tabId: string): boolean {
  const resolved = resolveStoredPanelKey(tabId)
  if (!resolved || !detachedTabPanels.has(resolved)) return false
  const panelKey = resolved
  try {
    detachedViewHost?.focusDetachedWindow(panelKey)
  } catch {
    return false
  }
  return true
}

/**
 * Move a tab's live WebContentsView back into the main window's bounded
 * viewport (mode "active"). The transfer out of the detached window happens
 * before the secondary window closes, so the session survives the dock.
 */
export function dockSupplierTab(tabId: string): SupplierTabState | null {
  const resolved = resolveStoredPanelKey(tabId)
  if (!resolved) return null
  const panelKey = resolved
  if (!detachedTabPanels.has(panelKey)) return null
  const liveView = managedSupplierViews.get(panelKey)?.view ?? null
  const livePopups = managedSupplierViews.get(panelKey)?.popups ?? []
  try {
    detachedViewHost?.detachDetachedPopups(panelKey, livePopups)
  } catch {
    // ignore teardown races
  }
  try {
    detachedViewHost?.detachDetachedView(panelKey, liveView)
  } catch {
    // ignore teardown races
  }
  detachedTabPanels.delete(panelKey)
  try {
    detachedViewHost?.closeDetachedWindow(panelKey)
  } catch {
    // ignore teardown races
  }
  const tab = openSupplierTab(panelKey)
  // Docking returns the tab to the main window as the visible tab: mark the
  // restored view visible so the registry reports mode "active" even when the
  // headless/test shell has no live WebContentsView to attach.
  const entry = managedSupplierViews.get(panelKey)
  if (entry) entry.visible = true
  return supplierTabRegistry().find((candidate) => candidate.panelKey === panelKey) || tab
}

/** Detached-window close path: the window closing docks the tab first. */
export function handleDetachedWindowClosed(panelKey: string): SupplierTabState | null {
  const resolved = resolveStoredPanelKey(panelKey)
  if (!resolved) return null
  return dockSupplierTab(`tab-${resolved}`)
}

/** Clean quit: destroy every detached window and hide every main-window view. */
export function disposeDetachedSupplierViews(): string[] {
  const disposed = [...detachedTabPanels]
  for (const panelKey of disposed) {
    const liveView = managedSupplierViews.get(panelKey)?.view ?? null
    const livePopups = managedSupplierViews.get(panelKey)?.popups ?? []
    try {
      detachedViewHost?.detachDetachedPopups(panelKey, livePopups)
    } catch {
      // ignore teardown races
    }
    try {
      detachedViewHost?.detachDetachedView(panelKey, liveView)
    } catch {
      // ignore teardown races
    }
    try {
      detachedViewHost?.destroyDetachedWindow(panelKey)
    } catch {
      // ignore teardown races
    }
    detachedTabPanels.delete(panelKey)
    const entry = managedSupplierViews.get(panelKey)
    if (entry?.visible) {
      entry.visible = false
      try {
        supplierViewHost?.removeView(entry.view as Electron.CrossProcessExports.WebContentsView)
      } catch {
        // ignore teardown races
      }
    }
  }
  hideSupplierViews()
  return disposed
}

export type WindowLifecycleEvent = "minimize" | "maximize" | "restore" | "hide-to-tray" | "restore-from-tray" | "before-quit"

/**
 * Window lifecycle transitions preserve every tab session and worker lease.
 * Minimize/tray-hide keeps the state; restore re-syncs the bounds; quit
 * disposes detached windows. Never drops a session or leaves stale bounds.
 */
export function notifyWindowLifecycle(event: WindowLifecycleEvent): string[] {
  if (event === "before-quit") return disposeDetachedSupplierViews()
  if (event === "restore" || event === "restore-from-tray" || event === "maximize") {
    layoutSupplierViews()
    if (supplierViewBounds() === null) hideSupplierViews()
  }
  return []
}

/**
 * Attach a tab for background worker execution without touching OS focus.
 * Used by claim preparation, follow-up checks, and status polls. Never calls
 * showWindow() or focusWindow(): the window stays exactly where it is.
 */
export function attachSupplierViewForBackground(panelKey: string): boolean {
  const resolved = resolveStoredPanelKey(panelKey)
  if (!resolved) return false
  const normalized = resolved
  const host = supplierViewHost
  const entry = managedSupplierViews.get(normalized)
  if (!host || host.isWindowDestroyed() || !entry || !entry.view) return false
  if (detachedTabPanels.has(normalized)) return true
  const bounds = supplierViewBounds()
  if (bounds === null) return false
  if (!entry.visible) {
    try {
      host.removeView(entry.view)
    } catch {
      // ensure a single attach
    }
    host.addView(entry.view)
    entry.view.setBounds(bounds)
    entry.visible = true
  } else {
    try {
      entry.view.setBounds(bounds)
    } catch {
      // ignore teardown races
    }
  }
  return true
}

/**
 * Explicit user-initiated show for a tab. Focus only when the caller passes
 * focus: true (toolbar Detach/Dock, Focus Window, Open in Browsers, Sign in).
 * Background worker steps must use attachSupplierViewForBackground() instead.
 */
export function showSupplierViewForUser(panelKey: string, options?: { focus?: boolean }): boolean {
  const resolved = resolveStoredPanelKey(panelKey)
  if (!resolved) return false
  const normalized = resolved
  const ok = showSupplierView(normalized)
  if (!ok) return false
  if (options?.focus === true) {
    try {
      supplierViewHost?.focusWindow()
    } catch {
      // ignore teardown races
    }
  }
  return true
}

function normalizePanelKey(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_") || "unknown"
}

/**
 * Resolve a tab/panel reference to the stored panel key. Panel keys are
 * stored verbatim (e.g. "SYN-meesho" in tests, "meesho" in production); this
 * resolves tab ids, exact keys, and normalized keys without renaming the
 * stored entry, so view registration and tab metadata never diverge.
 */
function resolveStoredPanelKey(value: string): string | null {
  const raw = String(value || "")
  const withoutTab = raw.startsWith("tab-") ? raw.slice(4) : raw
  const candidates = [withoutTab, normalizePanelKey(withoutTab)]
  for (const candidate of candidates) {
    if (tabMetadata.has(candidate) || managedSupplierViews.has(candidate) || detachedTabPanels.has(candidate)) {
      return candidate
    }
  }
  // Exact-but-unknown keys are still usable for fresh detach/dock bookkeeping.
  if (withoutTab && !candidates.includes(withoutTab)) return withoutTab
  return candidates[0] || null
}

type ManagedSupplierView = {
  view: Electron.CrossProcessExports.WebContentsView | null
  visible: boolean
  popups: Electron.CrossProcessExports.WebContentsView[]
}

const managedSupplierViews = new Map<string, ManagedSupplierView>()

/** Live per-tab metadata snapshot shared with the detach/dock feature. */
export type SupplierTabMode = "active" | "background" | "detached" | "closed"

export type SupplierTabClaim = {
  claimId: string
  orderId?: string
  awb?: string
  stage?: string
  statusText?: string
  paused: boolean
} | null

export type SupplierTabState = {
  tabId: string
  panelKey: string
  label: string
  accountName: string
  partition: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  mode: SupplierTabMode
  workerOwned: boolean
  activeClaim: SupplierTabClaim
}

export const WORKER_ACTIVE_PAUSE_REQUIRED = "WORKER_ACTIVE_PAUSE_REQUIRED" as const

type TabMetadata = {
  label: string
  accountName: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  workerOwned: boolean
  activeClaim: SupplierTabClaim
}

const tabMetadata = new Map<string, TabMetadata>()
let activeTabPanelKey: string | null = null
const closedTabStack: string[] = []

/** Deterministic tab id: one isolated tab per supplier panel key. */
export function tabIdForPanelKey(panelKey: string): string {
  return `tab-${panelKey}`
}

/** Display label for a panel key (Meesho, Myntra VB, ...). */
export function labelForPanelKey(panelKey: string): string {
  const normalized = String(panelKey || "").toLowerCase()
  if (normalized === "myntra_vb") return "Myntra VB"
  if (normalized === "myntra_ej") return "Myntra EJ"
  if (!normalized) return "Supplier"
  return normalized
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

/** Account identity shown in the URL/account pill. Defaults to the label. */
function accountNameForPanelKey(panelKey: string): string {
  return tabMetadata.get(panelKey)?.accountName || labelForPanelKey(panelKey)
}

function viewMetadata(view: Electron.CrossProcessExports.WebContentsView | null): {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
} {
  const fallback = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false }
  if (!view) return fallback
  try {
    const contents = view.webContents as unknown as {
      getURL?: () => string
      getTitle?: () => string
      isLoading?: () => boolean
      navigationHistory?: { canGoBack?: () => boolean; canGoForward?: () => boolean }
      canGoBack?: () => boolean
      canGoForward?: () => boolean
    }
    const canGoBack =
      typeof contents.navigationHistory?.canGoBack === "function"
        ? contents.navigationHistory.canGoBack()
        : typeof contents.canGoBack === "function"
          ? contents.canGoBack()
          : false
    const canGoForward =
      typeof contents.navigationHistory?.canGoForward === "function"
        ? contents.navigationHistory.canGoForward()
        : typeof contents.canGoForward === "function"
          ? contents.canGoForward()
          : false
    return {
      url: typeof contents.getURL === "function" ? String(contents.getURL() || "") : fallback.url,
      title: typeof contents.getTitle === "function" ? String(contents.getTitle() || "") : fallback.title,
      loading: typeof contents.isLoading === "function" ? Boolean(contents.isLoading()) : fallback.loading,
      canGoBack: Boolean(canGoBack),
      canGoForward: Boolean(canGoForward),
    }
  } catch {
    return fallback
  }
}

function metadataFor(panelKey: string, entry: ManagedSupplierView | undefined): TabMetadata {
  const stored = tabMetadata.get(panelKey)
  if (stored) return stored
  const fresh: TabMetadata = {
    label: labelForPanelKey(panelKey),
    accountName: labelForPanelKey(panelKey),
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    workerOwned: false,
    activeClaim: null,
  }
  void entry
  tabMetadata.set(panelKey, fresh)
  return fresh
}

/** Full per-tab registry: every known panel, including closed tabs awaiting reopen. */
export function supplierTabRegistry(): SupplierTabState[] {
  const tabs: SupplierTabState[] = []
  const seen = new Set<string>()
  for (const [panelKey, entry] of managedSupplierViews) {
    seen.add(panelKey)
    const meta = metadataFor(panelKey, entry)
    const live = viewMetadata(entry.view)
    const closed = closedTabStack.includes(panelKey)
    // A detached tab lives in the secondary window: it keeps its live session
    // but never reports as active/background in the main window.
    const mode: SupplierTabMode = closed
      ? "closed"
      : detachedTabPanels.has(panelKey)
        ? "detached"
        : panelKey === activeTabPanelKey
          ? "active"
          : entry.visible
            ? "background"
            : "background"
    tabs.push({
      tabId: tabIdForPanelKey(panelKey),
      panelKey,
      label: meta.label,
      accountName: meta.accountName,
      partition: `${PARTITION_PREFIX}${panelKey}`,
      url: live.url || meta.url,
      title: live.title || meta.title,
      loading: live.loading || meta.loading,
      canGoBack: live.canGoBack || meta.canGoBack,
      canGoForward: live.canGoForward || meta.canGoForward,
      mode,
      workerOwned: meta.workerOwned,
      activeClaim: meta.activeClaim,
    })
  }
  for (const [panelKey, meta] of tabMetadata) {
    if (seen.has(panelKey)) continue
    // Headless/test engines open tabs without a live WebContentsView: the tab
    // is open (active, background, or detached) unless it sits on the closed stack.
    const reopened = closedTabStack.includes(panelKey)
    const reopenedMode: SupplierTabMode = reopened
      ? "closed"
      : detachedTabPanels.has(panelKey)
        ? "detached"
        : panelKey === activeTabPanelKey
          ? "active"
          : "background"
    tabs.push({
      tabId: tabIdForPanelKey(panelKey),
      panelKey,
      label: meta.label,
      accountName: meta.accountName,
      partition: `${PARTITION_PREFIX}${panelKey}`,
      url: meta.url,
      title: meta.title,
      loading: meta.loading,
      canGoBack: meta.canGoBack,
      canGoForward: meta.canGoForward,
      mode: reopenedMode,
      workerOwned: meta.workerOwned,
      activeClaim: meta.activeClaim,
    })
  }
  tabs.sort((a, b) => (a.panelKey < b.panelKey ? -1 : a.panelKey > b.panelKey ? 1 : 0))
  return tabs
}

/** Panel key of the active tab, if any. */
export function activeSupplierTabPanelKey(): string | null {
  return activeTabPanelKey
}

/**
 * Open (or re-activate) a tab. Creates the metadata row on first open, marks
 * every other open tab as background, attaches the tab's view inside the
 * bounded viewport, and never spawns a duplicate worker.
 */
export function openSupplierTab(
  panelKey: string,
  options?: { label?: string; accountName?: string; url?: string; title?: string },
): SupplierTabState {
  const resolvedStored = resolveStoredPanelKey(panelKey)
  // An empty reference can never be a stored key: resolveStoredPanelKey falls
  // back to a candidate for bookkeeping, so guard empties explicitly.
  const rawRef = String(panelKey || "").trim()
  const normalized = resolvedStored && rawRef ? resolvedStored
    : (rawRef.toLowerCase().replace(/[^a-z0-9_]/g, "_") || "unknown")
  const meta = metadataFor(normalized, managedSupplierViews.get(normalized))
  if (options?.label) meta.label = options.label
  if (options?.accountName) meta.accountName = options.accountName
  if (typeof options?.url === "string") meta.url = options.url
  if (typeof options?.title === "string") meta.title = options.title
  const reopenIndex = closedTabStack.lastIndexOf(normalized)
  if (reopenIndex >= 0) closedTabStack.splice(reopenIndex, 1)
  activeTabPanelKey = normalized
  // A detached tab stays in its secondary window until it is docked: opening
  // or switching never yanks the live view back into the main window.
  if (detachedTabPanels.has(normalized)) {
    const current = supplierTabRegistry().find((tab) => tab.panelKey === normalized)
    if (!current) throw new Error(`Could not open the supplier tab for ${normalized}.`)
    return current
  }
  // Background tabs keep their view, cookies, DOM state, and active claims:
  // only attachment changes, never a close or a reload.
  for (const [otherKey, otherEntry] of managedSupplierViews) {
    if (otherKey === normalized || !otherEntry.visible) continue
    otherEntry.visible = false
    try {
      supplierViewHost?.removeView(otherEntry.view as Electron.CrossProcessExports.WebContentsView)
    } catch {
      // ignore teardown races
    }
  }
  const entry = managedSupplierViews.get(normalized)
  if (entry && !detachedTabPanels.has(normalized)) {
    showSupplierView(normalized)
  }
  const current = supplierTabRegistry().find((tab) => tab.panelKey === normalized)
  if (!current) throw new Error(`Could not open the supplier tab for ${normalized}.`)
  return current
}

/** Switch the active tab without destroying any view, session, or worker claim. */
export function switchSupplierTab(tabId: string): SupplierTabState | null {
  const panelKey = String(tabId || "").startsWith("tab-") ? String(tabId).slice(4) : String(tabId || "")
  const known = tabMetadata.has(panelKey) || managedSupplierViews.has(panelKey)
  if (!known) return null
  return openSupplierTab(panelKey)
}

/** Whether the tab's worker currently blocks a close. */
export function isSupplierTabCloseBlocked(panelKey: string): boolean {
  const meta = tabMetadata.get(panelKey)
  if (!meta) return false
  if (!meta.workerOwned) return false
  const claim = meta.activeClaim
  if (claim && claim.paused) return false
  return true
}

export type CloseSupplierTabResult =
  | { ok: true; tab: SupplierTabState }
  | { ok: false; code: typeof WORKER_ACTIVE_PAUSE_REQUIRED; error: string }

/**
 * Close a tab. Manual/idle tabs close immediately while the persistent
 * partition stays on disk for reopen. Worker-owned tabs need a paused worker
 * first and answer 409 WORKER_ACTIVE_PAUSE_REQUIRED otherwise.
 */
export function closeSupplierTab(tabId: string, options?: { force?: boolean }): CloseSupplierTabResult {
  const panelKey = String(tabId || "").startsWith("tab-") ? String(tabId).slice(4) : String(tabId || "")
  const meta = metadataFor(panelKey, managedSupplierViews.get(panelKey))
  const blocked = isSupplierTabCloseBlocked(panelKey)
  if (blocked && options?.force !== true) {
    return {
      ok: false,
      code: WORKER_ACTIVE_PAUSE_REQUIRED,
      error: "This tab has an active worker claim. Pause the worker before closing the tab.",
    }
  }
  if (blocked && options?.force === true) {
    return {
      ok: false,
      code: WORKER_ACTIVE_PAUSE_REQUIRED,
      error: "This tab has an active worker claim. Pause the worker before closing the tab.",
    }
  }
  const entry = managedSupplierViews.get(panelKey)
  if (entry?.visible) {
    entry.visible = false
    try {
      supplierViewHost?.removeView(entry.view as Electron.CrossProcessExports.WebContentsView)
    } catch {
      // ignore teardown races
    }
  }
  // Closing a detached tab retires its secondary window with the tab; the
  // persistent partition on disk survives for a later reopen.
  if (detachedTabPanels.has(panelKey)) {
    detachedTabPanels.delete(panelKey)
    try {
      detachedViewHost?.closeDetachedWindow(panelKey)
    } catch {
      // ignore teardown races
    }
  }
  if (!closedTabStack.includes(panelKey)) closedTabStack.push(panelKey)
  if (activeTabPanelKey === panelKey) {
    const fallback = [...managedSupplierViews.entries()].find(
      ([otherKey, otherEntry]) => otherKey !== panelKey && otherEntry.view,
    )
    activeTabPanelKey = fallback ? fallback[0] : null
    if (fallback) showSupplierView(fallback[0])
  }
  const tabs = supplierTabRegistry()
  const tab = tabs.find((candidate) => candidate.panelKey === panelKey)
  if (!tab) throw new Error(`Could not close the supplier tab for ${panelKey}.`)
  void meta
  return { ok: true, tab: { ...tab, mode: "closed" } }
}

/** Reopen the most recently closed tab, preserving its persistent partition. */
export function reopenClosedSupplierTab(): SupplierTabState | null {
  const panelKey = closedTabStack.pop()
  if (!panelKey) return null
  return openSupplierTab(panelKey)
}

/** Record worker ownership + active claim metadata for the close guard. */
export function setSupplierTabWorkerState(
  panelKey: string,
  state: { workerOwned: boolean; activeClaim?: SupplierTabClaim; paused?: boolean; label?: string; accountName?: string },
): SupplierTabState {
  const meta = metadataFor(panelKey, managedSupplierViews.get(panelKey))
  meta.workerOwned = state.workerOwned
  if (state.activeClaim !== undefined) {
    meta.activeClaim = state.activeClaim
  } else if (!state.workerOwned) {
    meta.activeClaim = null
  }
  if (typeof state.paused === "boolean") {
    if (meta.activeClaim) meta.activeClaim = { ...meta.activeClaim, paused: state.paused }
    else if (state.workerOwned) meta.activeClaim = { claimId: "", paused: state.paused }
  }
  if (state.label) meta.label = state.label
  if (state.accountName) meta.accountName = state.accountName
  const tab = supplierTabRegistry().find((candidate) => candidate.panelKey === panelKey)
  if (!tab) throw new Error(`Unknown supplier tab for ${panelKey}.`)
  return tab
}

/** Update cached navigation metadata (url/title/loading/history) for a tab. */
export function noteSupplierTabNavigation(
  panelKey: string,
  nav: { url?: string; title?: string; loading?: boolean; canGoBack?: boolean; canGoForward?: boolean },
): void {
  const meta = metadataFor(panelKey, managedSupplierViews.get(panelKey))
  if (typeof nav.url === "string") meta.url = nav.url
  if (typeof nav.title === "string") meta.title = nav.title
  if (typeof nav.loading === "boolean") meta.loading = nav.loading
  if (typeof nav.canGoBack === "boolean") meta.canGoBack = nav.canGoBack
  if (typeof nav.canGoForward === "boolean") meta.canGoForward = nav.canGoForward
}

export type SupplierTabNavAction = "back" | "forward" | "reload" | "stop"

/**
 * Run Back/Forward/Reload/Stop on the active tab's webContents. Reads live
 * state on Electron; on headless/test engines it records the intent against
 * the cached metadata so the toolbar stays honest without a window.
 */
export function navigateSupplierTab(
  tabId: string,
  action: SupplierTabNavAction,
): { ok: boolean; tab: SupplierTabState | null; error?: string } {
  const panelKey = String(tabId || "").startsWith("tab-") ? String(tabId).slice(4) : String(tabId || "")
  const entry = managedSupplierViews.get(panelKey)
  const meta = metadataFor(panelKey, entry)
  if (!entry || !entry.view) {
    if (action === "reload") meta.loading = true
    if (action === "stop") meta.loading = false
    const tab = supplierTabRegistry().find((candidate) => candidate.panelKey === panelKey) || null
    return { ok: true, tab }
  }
  try {
    const contents = entry.view.webContents as unknown as {
      goBack?: () => void
      goForward?: () => void
      reload?: () => void
      stop?: () => void
      isLoading?: () => boolean
      navigationHistory?: { canGoBack?: () => boolean; canGoForward?: () => boolean }
      canGoBack?: () => boolean
      canGoForward?: () => boolean
      getURL?: () => string
      getTitle?: () => string
    }
    if (action === "back") {
      const canGoBack =
        typeof contents.navigationHistory?.canGoBack === "function"
          ? contents.navigationHistory.canGoBack()
          : typeof contents.canGoBack === "function"
            ? contents.canGoBack()
            : true
      if (!canGoBack) return { ok: false, tab: null, error: "No earlier page in this tab." }
      contents.goBack?.()
    } else if (action === "forward") {
      const canGoForward =
        typeof contents.navigationHistory?.canGoForward === "function"
          ? contents.navigationHistory.canGoForward()
          : typeof contents.canGoForward === "function"
            ? contents.canGoForward()
            : true
      if (!canGoForward) return { ok: false, tab: null, error: "No later page in this tab." }
      contents.goForward?.()
    } else if (action === "reload") {
      contents.reload?.()
      meta.loading = true
    } else {
      contents.stop?.()
      meta.loading = false
    }
    if (typeof contents.getURL === "function") {
      try {
        meta.url = String(contents.getURL() || meta.url)
      } catch {
        // keep the cached url
      }
    }
    if (typeof contents.getTitle === "function") {
      try {
        meta.title = String(contents.getTitle() || meta.title)
      } catch {
        // keep the cached title
      }
    }
    if (typeof contents.isLoading === "function") {
      try {
        meta.loading = action === "stop" ? false : Boolean(contents.isLoading()) || action === "reload"
      } catch {
        // keep the cached flag
      }
    }
    const tab = supplierTabRegistry().find((candidate) => candidate.panelKey === panelKey) || null
    return { ok: true, tab }
  } catch (error) {
    return { ok: false, tab: null, error: error instanceof Error ? error.message : "Navigation failed." }
  }
}

/** Reset tab-manager state. Tests only. */
export function resetSupplierTabsForTests(): void {
  tabMetadata.clear()
  closedTabStack.length = 0
  activeTabPanelKey = null
  detachedTabPanels.clear()
}

/** Attach an OTP/CAPTCHA popup to a tab's view entry. Tests only (the shell's adapter does this on window-open). */
export function addSupplierPopupForTests(
  panelKey: string,
  popup: Electron.CrossProcessExports.WebContentsView,
): boolean {
  const resolved = resolveStoredPanelKey(panelKey)
  if (!resolved) return false
  const entry = managedSupplierViews.get(resolved)
  if (!entry || entry.popups.includes(popup)) return false
  entry.popups.push(popup)
  return true
}

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
  if (bounds === null) {
    hideSupplierViews()
    return
  }
  for (const entry of managedSupplierViews.values()) {
    if (!entry.visible || !entry.view) continue
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
      if (entry.view) host?.removeView(entry.view)
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

/** Attach a panel's view to the main window (tab-switch back from the dashboard).
 *
 * Focus discipline (VAL-WIN-004): this low-level attach never touches OS
 * focus. Explicit user actions go through showSupplierViewForUser(..., { focus:
 * true }); background worker steps use attachSupplierViewForBackground().
 */
export function showSupplierView(panelKey: string): boolean {
  const resolved = resolveStoredPanelKey(panelKey)
  if (!resolved) return false
  const normalized = resolved
  if (detachedTabPanels.has(normalized)) return false
  const host = supplierViewHost
  const entry = managedSupplierViews.get(normalized)
  if (!host || host.isWindowDestroyed() || !entry || !entry.view) return false
  // Fail-closed: a null or undersized workspace rect hides the view instead
  // of covering the window. The session stays alive; returning to Browsers
  // re-attaches it at the exact bounded coordinates.
  const bounds = supplierViewBounds()
  if (bounds === null) {
    hideSupplierViews()
    return false
  }
  if (!entry.visible) {
    try {
      host.removeView(entry.view)
    } catch {
      // ensure a single attach
    }
    host.addView(entry.view)
    entry.view.setBounds(bounds)
    for (const popup of entry.popups) {
      try {
        host.removeView(popup)
      } catch {
        // ensure a single attach
      }
      host.addView(popup)
      popup.setBounds(bounds)
    }
    entry.visible = true
  }
  return true
}

async function elementCenter(
  contents: Electron.CrossProcessExports.WebContents,
  selector: string,
): Promise<{ x: number; y: number } | null> {
  const rect = await contents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; ` +
      `if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" }); ` +
      `const r = el.getBoundingClientRect(); ` +
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
    // One isolated metadata row per panel: reopening the same panel reuses
    // its tab instead of spawning a duplicate worker or a second view.
    openSupplierTab(this.options.panelKey)
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
        if (typeof this.view.webContents.setUserAgent === "function") {
          this.view.webContents.setUserAgent(STANDARD_CHROME_USER_AGENT)
        }
        configureSupplierSessionHeaders(this.view.webContents.session)
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
      if (typeof this.view.webContents.setUserAgent === "function") {
        this.view.webContents.setUserAgent(STANDARD_CHROME_USER_AGENT)
      }
      configureSupplierSessionHeaders(this.view.webContents.session)
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
      openSupplierTab(this.options.panelKey)
      return
    }
    this.host?.show()
    this.host?.focus()
  }

  /** Popup, download and lifecycle wiring shared by both host paths. */
  private attachViewHandlers(): void {
    if (!this.view) return
    const panelKey = this.options.panelKey
    const view = this.view
    const refreshNav = (): void => {
      try {
        const contents = view.webContents as unknown as {
          getURL?: () => string
          getTitle?: () => string
          isLoading?: () => boolean
          navigationHistory?: { canGoBack?: () => boolean; canGoForward?: () => boolean }
          canGoBack?: () => boolean
          canGoForward?: () => boolean
        }
        const canGoBack =
          typeof contents.navigationHistory?.canGoBack === "function"
            ? contents.navigationHistory.canGoBack()
            : typeof contents.canGoBack === "function"
              ? contents.canGoBack()
              : false
        const canGoForward =
          typeof contents.navigationHistory?.canGoForward === "function"
            ? contents.navigationHistory.canGoForward()
            : typeof contents.canGoForward === "function"
              ? contents.canGoForward()
              : false
        noteSupplierTabNavigation(panelKey, {
          url: typeof contents.getURL === "function" ? String(contents.getURL() || "") : undefined,
          title: typeof contents.getTitle === "function" ? String(contents.getTitle() || "") : undefined,
          loading: typeof contents.isLoading === "function" ? Boolean(contents.isLoading()) : undefined,
          canGoBack: Boolean(canGoBack),
          canGoForward: Boolean(canGoForward),
        })
      } catch {
        // Teardown races keep the last cached metadata.
      }
    }
    const wire = (event: string, handler: () => void): void => {
      try {
        ;(view.webContents as unknown as { on: (event: string, handler: () => void) => void }).on(event, handler)
      } catch {
        // Sessions without event support (unit tests): navigation stays manual.
      }
    }
    // Operator-visible only when manual completion is needed (OTP/CAPTCHA,
    // assisted submit). Automation runs headless-in-window otherwise.
    wire("dom-ready", refreshNav)
    wire("did-navigate", refreshNav)
    wire("did-navigate-in-page", refreshNav)
    wire("did-start-loading", () => noteSupplierTabNavigation(panelKey, { loading: true }))
    wire("did-stop-loading", () => {
      noteSupplierTabNavigation(panelKey, { loading: false })
      refreshNav()
    })
    refreshNav()
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
    if (typeof popup.webContents.setUserAgent === "function") {
      popup.webContents.setUserAgent(STANDARD_CHROME_USER_AGENT)
    }
    configureSupplierSessionHeaders(popup.webContents.session)
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
      const bounds = supplierViewBounds()
      if (bounds !== null) {
        try {
          host.removeView(popup)
        } catch {
          // ensure a single attach
        }
        host.addView(popup)
        popup.setBounds(bounds)
        // Focus discipline: a background popup attach never shows or focuses
        // the OS window. The operator opens it explicitly when needed.
      }
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
    const focused = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
        if (typeof el.focus === "function") el.focus();
        if ("select" in el && typeof el.select === "function") {
          try { el.select(); } catch {}
        }
        return true;
      })()
    `).catch(() => false)
    if (!focused) return false

    // Clear existing text first
    await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (nativeSetter) {
          nativeSetter.call(el, "");
        } else {
          el.value = "";
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })()
    `).catch(() => undefined)

    // Type character by character with input events
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      this.contents.sendInputEvent({ type: "char", keyCode: char } as never)
      const intended = text.slice(0, i + 1)
      await this.evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return;
          const intended = ${JSON.stringify(intended)};
          const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (nativeSetter) {
            nativeSetter.call(el, intended);
          } else {
            el.value = intended;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        })()
      `).catch(() => undefined)
      await this.delay(30)
    }
    await this.delay(500)
    return true
  }

  /**
   * Generates a client-side JavaScript evaluation script that searches for clickable elements
   * matching the provided text and invokes a click on the closest interactable ancestor or element.
   */
  private buildClickByTextScript(text: string, exact: boolean): string {
    return `
      (() => {
        const want = ${JSON.stringify(text.trim().toLowerCase())};
        if (!want) return false;
        const all = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit], div, span, p, li, label, [role=button]"));
        const matches = all.filter((el) => {
          const t = (el.textContent || (el instanceof HTMLInputElement && el.value) || "").trim().toLowerCase();
          if (${exact ? "t !== want" : "!t.includes(want)"}) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (!matches.length) return false;
        matches.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
        const target = matches[0];
        const clickable = target.closest("button, a, input[type=button], input[type=submit], [role=button]") || target;
        if (typeof clickable.scrollIntoView === "function") clickable.scrollIntoView({ block: "center" });
        if (typeof clickable.click === "function") clickable.click();
        return true;
      })()
    `
  }

  /**
   * Simulates a human click on a DOM selector. Dispatches physical coordinate mouse events
   * only when the window hosting this web contents is active and focused, cleanly falling back
   * to in-page DOM element clicks when the view is detached, unfocused, or running in background.
   */
  async humanClick(selector: string): Promise<boolean> {
    const focusedWindow = this.electron?.BrowserWindow?.getFocusedWindow?.()
    const ownerWindow = this.electron?.BrowserWindow?.fromWebContents?.(this.contents)
    if (focusedWindow && ownerWindow && focusedWindow === ownerWindow) {
      const center = await elementCenter(this.contents, selector)
      if (center && center.x > 0 && center.y > 0) {
        // Human-like approach: move the cursor toward the element in two steps
        // from a small random offset before pressing, so hover states fire.
        const targetX = Math.round(center.x)
        const targetY = Math.round(center.y)
        const startX = Math.max(0, targetX + Math.round(Math.random() * 240 - 120))
        const startY = Math.max(0, targetY + Math.round(Math.random() * 240 - 120))
        this.contents.sendInputEvent({ type: "mouseMoved", x: startX, y: startY } as never)
        await this.delay(30 + Math.floor(Math.random() * 51))
        this.contents.sendInputEvent({ type: "mouseMoved", x: Math.round((startX + targetX) / 2), y: Math.round((startY + targetY) / 2) } as never)
        await this.delay(30 + Math.floor(Math.random() * 51))
        this.contents.sendInputEvent({ type: "mouseDown", x: targetX, y: targetY, button: "left", clickCount: 1 } as never)
        this.contents.sendInputEvent({ type: "mouseUp", x: targetX, y: targetY, button: "left", clickCount: 1 } as never)
        return true
      }
    }
    return this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
        if (typeof el.click === "function") el.click();
        return true;
      })()
    `).catch(() => false)
  }

  async clickByTextIncludes(text: string): Promise<boolean> {
    return this.evaluate<boolean>(this.buildClickByTextScript(text, false)).catch(() => false)
  }

  async clickByExactText(text: string): Promise<boolean> {
    return this.evaluate<boolean>(this.buildClickByTextScript(text, true)).catch(() => false)
  }

  async clickVisibleLabel(text: string): Promise<boolean> {
    return this.clickByTextIncludes(text)
  }

  async clickLabelInDom(text: string): Promise<{ clicked: boolean; href: string }> {
    const clicked = await this.clickByTextIncludes(text)
    const href = await this.evaluate<string>(`
      (() => {
        const want = ${JSON.stringify(text.trim().toLowerCase())};
        const all = Array.from(document.querySelectorAll("a, [href]"));
        const match = all.find((e) => (e.textContent || "").toLowerCase().includes(want));
        return match ? (match.href || match.getAttribute("href") || "") : "";
      })()
    `).catch(() => "")
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

    try {
      const debuggerApi = this.contents.debugger
      debuggerApi.attach("1.3")
      try {
        const doc = (await debuggerApi.sendCommand("DOM.getDocument", { depth: -1 })) as { root: { nodeId: number } }
        const match = (await debuggerApi.sendCommand("DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector,
        }).catch(() => ({ nodeId: 0 }))) as { nodeId?: number }

        if (!match || typeof match.nodeId !== "number" || match.nodeId <= 0) {
          logger.warn(`Native adapter: input element not found for selector ${selector}; showing panel for manual step.`)
          await this.showForManualStep()
          return false
        }

        await debuggerApi.sendCommand("DOM.setFileInputFiles", { nodeId: match.nodeId, files: filePaths })
      } finally {
        try {
          debuggerApi.detach()
        } catch {
          // ignore detach error if already detached
        }
      }
    } catch (err) {
      logger.warn(`Native adapter: debugger file attach failed for ${selector}; showing the panel for a manual pick.`, err)
      await this.showForManualStep()
      return false
    }

    await this.delay(500)

    // Trigger change/input events and React onChange handler on the input
    await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        const key = Object.keys(el).find((k) => k.startsWith("__reactProps") || k.startsWith("__reactEventHandlers"));
        if (key && el[key] && typeof el[key].onChange === "function") {
          try { el[key].onChange({ target: el, currentTarget: el }); } catch {}
        }
      })()
    `).catch(() => undefined)

    await this.delay(500)
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
