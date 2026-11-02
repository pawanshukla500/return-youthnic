import { BrowserRunner, findSystemBrowser } from "./browser-runner.js"
import { logger } from "./logger.js"

/**
 * Shared browser adapter for supplier-panel automation (Milestone 1: native browser foundation).
 *
 * Marketplace automation drives supplier portals through this interface instead of
 * constructing a concrete browser runner directly. Two adapters implement it:
 *
 * - `external` (default): the existing CDP-driven system Chromium/Edge runner
 *   (`BrowserRunner`). Used for headless Linux operation, CI, and as the
 *   compatibility fallback. Behaviour is byte-for-byte the current behaviour.
 * - `native`: the Electron `WebContentsView` adapter backed by the desktop app's
 *   bundled Chromium (`native-browser-view.ts`). Desktop-only, opt-in via
 *   `BROWSER_ADAPTER=native`. Keeps one isolated, persistent
 *   `persist:supplier-<panel>` session per marketplace account, so cookies and
 *   sign-in survive restarts and updates without touching external profiles.
 *
 * The default stays `external` until the native adapter is verified against live
 * panels; flipping the default without that verification would change what every
 * installed warehouse PC drives. Session migration between adapters is
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
}

/** An opened supplier browser: the automation surface plus teardown. */
export type SupplierBrowserHandle = {
  kind: BrowserAdapterKind
  browser: SupplierBrowserApi
  close(): Promise<void>
}

export function resolveBrowserAdapterKind(): BrowserAdapterKind {
  const raw = String(process.env.BROWSER_ADAPTER || "").trim().toLowerCase()
  if (raw === "native") return "native"
  if (raw === "external") return "external"
  if (raw === "" || raw === "auto") {
    // Auto keeps the current behaviour everywhere: the external system browser.
    // Native becomes the default only after it is verified against live panels.
    return "external"
  }
  logger.warn(`Unknown BROWSER_ADAPTER="${raw}". Using the external system browser.`)
  return "external"
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
      "BROWSER_ADAPTER=native needs the Electron desktop shell (bundled Chromium). " +
        "Unset BROWSER_ADAPTER to keep using the external system browser, " +
        "or run inside the packaged desktop app.",
    )
  }
  // Dynamic import on purpose: the engine also runs headless on Linux servers
  // where Electron is not installed, and a static import would break startup.
  const native = await import("./native-browser-view.js")
  return native.openNativeSupplierBrowser(options)
}

/**
 * Open a supplier browser through the configured adapter. Defaults to the
 * external system browser, so existing installs behave exactly as before.
 * Pass `headless: true` on servers; the native adapter ignores it and renders
 * in-window so an operator can complete OTP/CAPTCHA by hand.
 */
export async function openSupplierBrowser(options: SupplierBrowserOptions): Promise<SupplierBrowserHandle> {
  const kind = resolveBrowserAdapterKind()
  if (kind === "native") {
    try {
      return await openNativeBrowser(options)
    } catch (err) {
      // Fail-closed to a clear message, never to a guessed session: fall back
      // to the external adapter only when its own browser exists, otherwise
      // surface the native error (usually "run inside the desktop app").
      const fallback = findSystemBrowser()
      logger.warn(`Native supplier browser unavailable (${err instanceof Error ? err.message : err}).`)
      if (!fallback) throw err
      logger.warn("Falling back to the external system browser on its own profile.")
      return openExternalBrowser(options)
    }
  }
  return openExternalBrowser(options)
}

/** Adapter name for diagnostics (`GET /api/v1/engine/info`, dashboard). */
export function describeBrowserAdapter(): string {
  const kind = resolveBrowserAdapterKind()
  if (kind === "native") return nativeBrowserAvailable() ? "native (WebContentsView)" : "native (requested, Electron missing)"
  return "external (system Chromium)"
}
