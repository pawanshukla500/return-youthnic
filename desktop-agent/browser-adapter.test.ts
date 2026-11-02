// Checks for the shared supplier-browser adapter: kind resolution, the safe
// default (external system browser), graceful behaviour outside Electron, and
// the guarantee that the existing BrowserRunner satisfies the adapter surface
// (so current marketplace automation keeps working unchanged).

import test from "node:test"
import assert from "node:assert/strict"
import {
  describeBrowserAdapter,
  nativeBrowserAvailable,
  openSupplierBrowser,
  resolveBrowserAdapterKind,
  type SupplierBrowserApi,
} from "./src/browser-adapter.ts"
import { BrowserRunner } from "./src/browser-runner.ts"
import { isMarketplaceSupported } from "./src/marketplaces/registry.ts"

function withEnv(name: string, value: string | undefined, work: () => void): void {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    work()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test("the default adapter is the external system browser", () => {
  withEnv("BROWSER_ADAPTER", undefined, () => {
    assert.equal(resolveBrowserAdapterKind(), "external")
  })
  withEnv("BROWSER_ADAPTER", "", () => {
    assert.equal(resolveBrowserAdapterKind(), "external")
  })
  withEnv("BROWSER_ADAPTER", "auto", () => {
    assert.equal(resolveBrowserAdapterKind(), "external")
  })
})

test("explicit adapter selection is honoured; unknown values fall back safely", () => {
  withEnv("BROWSER_ADAPTER", "external", () => {
    assert.equal(resolveBrowserAdapterKind(), "external")
  })
  withEnv("BROWSER_ADAPTER", "NATIVE", () => {
    assert.equal(resolveBrowserAdapterKind(), "native")
  })
  withEnv("BROWSER_ADAPTER", "chromium-cdp", () => {
    assert.equal(resolveBrowserAdapterKind(), "external")
  })
})

test("the native adapter is unavailable outside the Electron shell", () => {
  assert.equal(nativeBrowserAvailable(), false)
  assert.match(describeBrowserAdapter(), /external/)
})

test("the existing BrowserRunner satisfies the adapter surface", () => {
  // Compile-time structural check: if BrowserRunner stops matching
  // SupplierBrowserApi this assignment fails typecheck.
  const runner: SupplierBrowserApi = new BrowserRunner() as SupplierBrowserApi
  assert.ok(runner)
  for (const method of [
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
  ] as const) {
    assert.equal(typeof runner[method], "function", `${method} must exist on the adapter surface`)
  }
})

test("requesting native outside Electron fails loudly, never substitutes a session", async () => {
  // Hermetic: the Electron check throws before any browser process spawns, so
  // no profile is touched and no claim can be filed under the wrong session.
  await withEnvAsync("BROWSER_ADAPTER", "native", async () => {
    await assert.rejects(
      () => openSupplierBrowser({ panelKey: "meesho", profileDir: "/tmp/syn-profile" }),
      /Electron/,
    )
  })
})

test("marketplace support pre-check matches the automation registry", () => {
  for (const name of ["Meesho", "FLIPKART Seller", "amazon", "Myntra VB", "ajio"]) {
    assert.equal(isMarketplaceSupported(name), true, name)
  }
  assert.equal(isMarketplaceSupported("Unknown Marketplace"), false)
  assert.equal(isMarketplaceSupported(""), false)
})

async function withEnvAsync(name: string, value: string | undefined, work: () => Promise<void>): Promise<void> {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await work()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}
