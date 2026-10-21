/**
 * Chromium sandbox policy.
 *
 * The browser drives untrusted supplier pages, so the renderer sandbox is the
 * main thing standing between a hostile page and the profile folder, which holds
 * the supplier session cookies. Passing `--no-sandbox` unconditionally, as the
 * runner used to, hands a compromised page the ability to run code as the engine
 * user and read those cookies.
 *
 * It stays off (sandboxed) unless one of two narrow cases applies:
 *
 *   - `BROWSER_NO_SANDBOX=1` asks for it explicitly. Needed on container hosts
 *     whose seccomp profile blocks the user namespaces the sandbox uses.
 *   - The engine runs as root on Linux, where Chromium refuses to start at all
 *     without the flag. The shipped container runs as the `node` user, so this
 *     does not apply to it.
 *
 * Kept pure so the policy can be tested without launching a browser.
 */

export type BrowserSandboxState = {
  platform: NodeJS.Platform
  /** Running as uid 0. Always false on Windows, which has no getuid(). */
  isRoot: boolean
  /** BROWSER_NO_SANDBOX was set to a truthy value. */
  noSandboxRequested: boolean
}

/** Whether the truthy form of BROWSER_NO_SANDBOX is set. */
export function isNoSandboxRequested(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

/** True when the sandbox must be disabled for the browser to work. */
export function shouldDisableBrowserSandbox(state: BrowserSandboxState): boolean {
  if (state.noSandboxRequested) return true
  // Chromium prints "Running as root without --no-sandbox is not supported" and
  // exits, so a root Linux process has no choice.
  return state.platform === "linux" && state.isRoot
}

/** The sandbox flags to append to the browser command line. */
export function browserSandboxArgs(state: BrowserSandboxState): string[] {
  return shouldDisableBrowserSandbox(state) ? ["--no-sandbox"] : []
}

/** Read the policy inputs from the current process. */
export function currentBrowserSandboxState(): BrowserSandboxState {
  const getuid = process.getuid
  return {
    platform: process.platform,
    isRoot: typeof getuid === "function" && getuid.call(process) === 0,
    noSandboxRequested: isNoSandboxRequested(process.env.BROWSER_NO_SANDBOX),
  }
}
