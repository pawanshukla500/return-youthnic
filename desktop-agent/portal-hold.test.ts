// Checks for the portal-browser hold flow against the shared adapter surface:
// a held browser survives the worker teardown and closes on demand with no
// real browser involved.

import test from "node:test"
import assert from "node:assert/strict"
import { closePortalLoginBrowser, holdPortalBrowser } from "./src/portal-login.ts"
import type { SupplierBrowserApi } from "./src/browser-adapter.ts"

function fakeBrowser(): SupplierBrowserApi & { closed: boolean } {
  const state = {
    closed: false,
    profileDirectory: "syn-profile",
    connectToPage: async () => undefined,
    send: async () => undefined,
    navigate: async () => undefined,
    evaluate: async <T,>() => undefined as T,
    captureScreenshot: async (p: string) => p,
    detectCaptchaOrOtp: async () => ({ challengeDetected: false }),
    delay: async () => undefined,
    humanType: async () => true,
    humanClick: async () => true,
    clickByTextIncludes: async () => true,
    clickByExactText: async () => true,
    clickVisibleLabel: async () => true,
    clickLabelInDom: async () => ({ clicked: true, href: "" }),
    uploadViaChooser: async () => true,
    setFileInputFiles: async () => true,
    close: async () => {
      state.closed = true
    },
  }
  return state
}

test("holding and closing goes through the adapter surface", async () => {
  assert.equal(holdPortalBrowser(), false)
  const browser = fakeBrowser()
  assert.equal(holdPortalBrowser(browser), true)
  assert.equal(holdPortalBrowser(), true)
  await closePortalLoginBrowser()
  assert.equal(browser.closed, true)
  assert.equal(holdPortalBrowser(), false)
  await closePortalLoginBrowser()
})
