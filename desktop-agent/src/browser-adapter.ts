import { BrowserRunner } from "./browser-runner.js"
import { logger } from "./logger.js"

/**
 * Shared browser adapter for supplier-panel automation (Milestone 1: native browser foundation).
 *
 * Marketplace automation drives supplier portals through this interface instead of
 * constructing a concrete browser runner directly. Two adapters implement it:
 *
 * - `external`: the existing CDP-driven system Chromium/Edge runner
 *   (`BrowserRunner`). Used for headless Linux operation, CI, and as the
 *   compatibility fallback. Behaviour is byte-for-byte the current behaviour.
 * - `native` (default inside the desktop app): the Electron `WebContentsView` adapter backed by the desktop app's
 *   bundled Chromium (`native-browser-view.ts`). Desktop-only, opt-in via
 *   `BROWSER_ADAPTER=native`. Keeps one isolated, persistent
 *   `persist:supplier-<panel>` session per marketplace account, so cookies and
 *   sign-in survive restarts and updates without touching external profiles. No Edge,
 *   Chrome, or Chromium install is needed: the browser ships inside the app.
 *
 * The default is `native` inside the Electron shell (bundled Chromium) and
 * `external` everywhere else (headless Linux servers, plain node, CI), so
 * existing server installs behave exactly as before. Session migration between adapters is
 * deliberately unsupported: cookies are never copied across profile formats.
 * Each adapter signs in on its own profile, and the engine asks for login only
 * when that adapter's session is expired, revoked, or invalid.
 */

export type BrowserAdapterKind = "external" | "native"

/** Minimal navigation/session options shared by both adapters. */
export type SupplierBrowserOptions = {
  /** Supplier panel key, e.g. `meesho`, `flipkart`. Isolates the session/profile. */
  panelKey: string
  /** Directory that holds the external adapter's per-panel CDP profile. */
  profileDir: string
  /** Headless launch for the external adapter. The native adapter renders in-window. */
  headless?: boolean
  /** CDP/debug port for the external adapter. Ignored by the native adapter. */
  port?: number
}

/**
 * The surface marketplace automation needs from a supplier browser. It mirrors
 * the `BrowserRunner` methods the marketplace classes actually call, so the
 * existing `BrowserRunner` satisfies it structurally and no marketplace class
 * has to change to keep working.
 */
export type SupplierBrowserApi = {
  readonly profileDirectory: string
  connectToPage(port: number): Promise<void>
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  navigate(url: string): Promise<void>
  evaluate<T>(expression: string): Promise<T>
  captureScreenshot(outputPath: string): Promise<string>
  detectCaptchaOrOtp(): Promise<{ challengeDetected: boolean; reason?: string }>
  delay(ms?: number): Promise<void>
  humanType(selector: string, text: string): Promise<boolean>
  humanClick(selector: string): Promise<boolean>
  clickByTextIncludes(text: string): Promise<boolean>
  clickByExactText(text: string): Promise<boolean>
  clickVisibleLabel(text: string): Promise<boolean>
  clickLabelInDom(text: string): Promise<{ clicked: boolean; href: string }>
  uploadViaChooser(buttonText: string, filePath: string): Promise<boolean>
  setFileInputFiles(selector: string, filePaths: string[]): Promise<boolean>
  close(): Promise<void>
  /** Bring the panel on screen for manual steps. No-op when the adapter has no window to show. */
  showForManualStep?(): Promise<void>
}

/** An opened supplier browser: the automation surface plus teardown. */
export type SupplierBrowserHandle = {
  kind: BrowserAdapterKind
  browser: SupplierBrowserApi
  close(): Promise<void>
}

/** Default adapter: the bundled browser inside the desktop shell, the system browser everywhere else. Exported for tests. */
export function defaultAdapterKind(bundledBrowserAvailable: boolean): BrowserAdapterKind {
  return bundledBrowserAvailable ? "native" : "external"
}

export function resolveBrowserAdapterKind(): BrowserAdapterKind {
  const raw = String(process.env.BROWSER_ADAPTER || "").trim().toLowerCase()
  if (raw === "native") return "native"
  if (raw === "external") return "external"
  if (raw !== "" && raw !== "auto") {
    logger.warn(`Unknown BROWSER_ADAPTER="${raw}". Falling back to the default adapter.`)
  }
  // Unset (or "auto"): native inside the desktop app where bundled Chromium
  // exists, external on servers and plain node. Explicit "external" keeps the
  // system browser everywhere, e.g. headless Linux operation.
  return defaultAdapterKind(nativeBrowserAvailable())
}

/** True only inside the Electron shell (bundled Chromium available). */
export function nativeBrowserAvailable(): boolean {
  return Boolean((process as unknown as { versions?: Record<string, string> }).versions?.electron)
}

function assertBrowserRunnerSurface(runner: BrowserRunner): asserts runner is BrowserRunner & SupplierBrowserApi {
  // Structural check for reviewers: every method on the adapter surface exists.
  const missing = (
    [
      "connectToPage",
      "send",
      "navigate",
      "evaluate",
      "captureScreenshot",
      "detectCaptchaOrOtp",
      "delay",
      "humanType",
      "humanClick",
      "clickByTextIncludes",
      "clickByExactText",
      "clickVisibleLabel",
      "clickLabelInDom",
      "uploadViaChooser",
      "setFileInputFiles",
      "close",
    ] as const
  ).filter((name) => typeof (runner as unknown as Record<string, unknown>)[name] !== "function")
  if (missing.length > 0) {
    throw new Error(`BrowserRunner is missing adapter methods: ${missing.join(", ")}.`)
  }
}

async function openExternalBrowser(options: SupplierBrowserOptions): Promise<SupplierBrowserHandle> {
  const runner = new BrowserRunner()
  assertBrowserRunnerSurface(runner)
  const session = await runner.launch({
    profileDir: options.profileDir,
    headless: options.headless,
    port: options.port,
  })
  await runner.connectToPage(session.port)
  return {
    kind: "external",
    browser: runner,
    close: () => runner.close(),
  }
}

async function openNativeBrowser(options: SupplierBrowserOptions): Promise<SupplierBrowserHandle> {
  if (!nativeBrowserAvailable()) {
    throw new Error(
      "The native supplier browser needs the Electron desktop shell (bundled Chromium). " +
        "Run inside the packaged desktop app, or set BROWSER_ADAPTER=external " +
        "to drive the system browser instead.",
    )
  }
  // Dynamic import on purpose: the engine also runs headless on Linux servers
  // where Electron is not installed, and a static import would break startup.
  const native = await import("./native-browser-view.js")
  return native.openNativeSupplierBrowser(options)
}

/**
 * Open a supplier browser through the configured adapter. Defaults to the
 * bundled browser in the desktop app and the system browser everywhere else,
 * so existing server installs behave exactly as before.
 * Pass `headless: true` on servers; the native adapter ignores it and renders
 * in-window so an operator can complete OTP/CAPTCHA by hand.
 */
export async function openSupplierBrowser(options: SupplierBrowserOptions): Promise<SupplierBrowserHandle> {
  const kind = resolveBrowserAdapterKind()
  if (kind === "native") {
    // No silent fallback: an explicit native request that cannot be honoured
    // fails loudly. Substituting the external adapter would file claims under
    // a different browser profile and hide a broken install.
    return openNativeBrowser(options)
  }
  return openExternalBrowser(options)
}

/** Adapter name for diagnostics (`GET /api/v1/engine/info`, dashboard). */
export function describeBrowserAdapter(): string {
  const kind = resolveBrowserAdapterKind()
  if (kind === "native") return nativeBrowserAvailable() ? "native (WebContentsView)" : "native (requested, Electron missing)"
  return "external (system Chromium)"
}
