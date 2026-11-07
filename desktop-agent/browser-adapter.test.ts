// Checks for the shared supplier-browser adapter: kind resolution, the shell-aware
// default (bundled browser in Electron, system browser elsewhere), graceful behaviour
// outside Electron, and the guarantee that the existing BrowserRunner satisfies the
// adapter surface (so current marketplace automation keeps working unchanged).

import test from "node:test"
import assert from "node:assert/strict"
import {
  describeBrowserAdapter,
  defaultAdapterKind,
  nativeBrowserAvailable,
  openSupplierBrowser,
  resolveBrowserAdapterKind,
  type SupplierBrowserApi,
} from "./src/browser-adapter.ts"
import { BrowserRunner } from "./src/browser-runner.ts"
import { isMarketplaceSupported } from "./src/marketplaces/registry.ts"
import { STANDARD_CHROME_USER_AGENT, configureSupplierSessionHeaders } from "./src/native-browser-view.ts"

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

test("the default adapter outside the desktop shell is the system browser", () => {
  // This file runs in plain node (no Electron versions), so the default stays
  // external here. Inside the packaged app the same unset value resolves to
  // the bundled browser (see defaultAdapterKind below).
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

test("the default follows the shell: bundled browser in Electron, system browser elsewhere", () => {
  assert.equal(defaultAdapterKind(true), "native")
  assert.equal(defaultAdapterKind(false), "external")
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

test("STANDARD_CHROME_USER_AGENT adheres to genuine Chrome headers without automation flags", () => {
  const chromeMajor = process.versions?.chrome ? process.versions.chrome.split(".")[0] : "131"
  assert.match(STANDARD_CHROME_USER_AGENT, /Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/)
  assert.match(STANDARD_CHROME_USER_AGENT, /AppleWebKit\/537\.36/)
  assert.match(STANDARD_CHROME_USER_AGENT, new RegExp(`Chrome\\/${chromeMajor}\\.0\\.0\\.0 Safari\\/537\\.36`))
  assert.doesNotMatch(STANDARD_CHROME_USER_AGENT, /HeadlessChrome/)
  assert.doesNotMatch(STANDARD_CHROME_USER_AGENT, /Electron/)
})

type HeaderListener = (
  details: { requestHeaders: Record<string, string>; url: string },
  callback: (res: { requestHeaders: Record<string, string> }) => void,
) => void

test("configureSupplierSessionHeaders injects Sec-CH-UA client hints on session", () => {
  let appliedUa: string | null = null
  let interceptedListener: HeaderListener | null = null

  const mockSession = {
    setUserAgent(ua: string) {
      appliedUa = ua
    },
    webRequest: {
      onBeforeSendHeaders(_filter: unknown, listener: HeaderListener) {
        interceptedListener = listener
      },
    },
  }

  configureSupplierSessionHeaders(mockSession)
  assert.equal(appliedUa, STANDARD_CHROME_USER_AGENT)
  assert.ok(interceptedListener)

  // Test intercepting a Meesho request
  let callbackResult: { requestHeaders: Record<string, string> } | null = null
  const fn: HeaderListener = interceptedListener!
  fn(
    {
      url: "https://supplier.meesho.com/panel/v3/new/root/login",
      requestHeaders: { "User-Agent": STANDARD_CHROME_USER_AGENT },
    },
    (res: { requestHeaders: Record<string, string> }) => {
      callbackResult = res
    },
  )

  assert.ok(callbackResult)
  const chromeMajor = process.versions?.chrome ? process.versions.chrome.split(".")[0] : "131"
  const headers = (callbackResult as { requestHeaders: Record<string, string> }).requestHeaders
  assert.equal(headers["sec-ch-ua"], `"Google Chrome";v="${chromeMajor}", "Chromium";v="${chromeMajor}", "Not_A Brand";v="24"`)
  assert.equal(headers["sec-ch-ua-mobile"], "?0")
  assert.equal(headers["sec-ch-ua-platform"], '"Windows"')
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
