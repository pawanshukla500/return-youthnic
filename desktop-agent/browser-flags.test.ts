import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  browserSandboxArgs,
  isNoSandboxRequested,
  shouldDisableBrowserSandbox,
} from "./src/browser-flags.js"

/**
 * The browser loads untrusted supplier pages, so the sandbox is what keeps a
 * compromised page away from the profile folder and its session cookies. It used
 * to be disabled unconditionally, which is a CodeAnt finding on PR #35.
 */

describe("browser sandbox policy", () => {
  it("keeps the sandbox on by default on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
      const state = { platform, isRoot: false, noSandboxRequested: false }
      assert.equal(shouldDisableBrowserSandbox(state), false, `${platform} should be sandboxed`)
      assert.deepEqual(browserSandboxArgs(state), [], `${platform} should get no sandbox flag`)
    }
  })

  it("disables the sandbox only when BROWSER_NO_SANDBOX asks for it", () => {
    const state = { platform: "win32" as NodeJS.Platform, isRoot: false, noSandboxRequested: true }
    assert.equal(shouldDisableBrowserSandbox(state), true)
    assert.deepEqual(browserSandboxArgs(state), ["--no-sandbox"])
  })

  it("disables the sandbox as root on Linux, where Chromium refuses to start", () => {
    const state = { platform: "linux" as NodeJS.Platform, isRoot: true, noSandboxRequested: false }
    assert.equal(shouldDisableBrowserSandbox(state), true)
    assert.deepEqual(browserSandboxArgs(state), ["--no-sandbox"])
  })

  it("keeps the sandbox on for a non-root Linux container", () => {
    // The shipped image runs as the `node` user, so this is the container case.
    const state = { platform: "linux" as NodeJS.Platform, isRoot: false, noSandboxRequested: false }
    assert.equal(shouldDisableBrowserSandbox(state), false)
  })

  it("reads the opt-in only from a truthy value", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "Yes"]) {
      assert.equal(isNoSandboxRequested(value), true, `${value} should opt in`)
    }
    for (const value of [undefined, "", "0", "false", "no", "off", "maybe"]) {
      assert.equal(isNoSandboxRequested(value), false, `${String(value)} should not opt in`)
    }
  })
})
