import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { clearSessionMarker, profileDirFor, readSessionSavedAt, sessionMarkerPath, supplierSessionDir, writeSessionMarker } from "./src/supplier-session.ts"
import { completePortalLogin, isPortalLoggedIn, portalLoginSavePayload, requireApprovalBeforeSubmitForMarketplace, secretFromEnvironment, type PortalLoginRow } from "./src/portal-login.ts"

test("marketplace profile folders stay stable for saved cookies", () => {
  const root = path.join(os.tmpdir(), "return-app-profiles")
  assert.equal(profileDirFor(root, "Meesho"), path.join(root, "profile-meesho"))
  assert.equal(profileDirFor(root, "Myntra VB"), path.join(root, "profile-myntra_vb"))
})

test("a saved supplier session is read back from the profile folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "return-app-session-"))
  assert.equal(readSessionSavedAt(dir), null)
  fs.writeFileSync(sessionMarkerPath(dir), JSON.stringify({ accountName: "Meesho", savedAt: "2026-10-16T12:00:00.000Z" }))
  assert.equal(readSessionSavedAt(dir), "2026-10-16T12:00:00.000Z")
})

test("isPortalLoggedIn correctly recognizes Meesho supplier panel states", () => {
  // Logged-in Meesho experiences
  assert.equal(
    isPortalLoggedIn("Meesho", "https://supplier.meesho.com/experience/yqcue/home", "Orders and Returns", false),
    true,
    "should identify /experience/ route as logged in"
  )
  assert.equal(
    isPortalLoggedIn("Meesho", "https://supplier.meesho.com/growth/support", "Support Tickets", false),
    true,
    "should identify /growth/ route as logged in"
  )
  assert.equal(
    isPortalLoggedIn("Meesho", "https://supplier.meesho.com/panel/v3/new/home", "", false),
    true,
    "should identify /panel/v3/new/ route as logged in"
  )
  assert.equal(
    isPortalLoggedIn("Meesho", "https://supplier.meesho.com/dashboard", "Welcome back seller! Pending Orders: 5", false),
    true,
    "should identify welcome text as logged in"
  )

  // Unauthenticated / login page states
  assert.equal(
    isPortalLoggedIn("Meesho", "https://supplier.meesho.com/help", "Customer Support and Returns policy", false),
    false,
    "should reject generic support or returns text outside authenticated panel"
  )
  assert.equal(
    isPortalLoggedIn("Meesho", "https://supplier.meesho.com/panel/v3/new/root/login", "Welcome back", false),
    false,
    "should reject login page even if text says Welcome back"
  )
  assert.equal(
    isPortalLoggedIn("Meesho", "https://supplier.meesho.com/experience/yqcue/home", "", true),
    false,
    "should reject if password input is present"
  )
})

test("isPortalLoggedIn handles non-Meesho generic portals", () => {
  const longText = "A".repeat(100)
  assert.equal(
    isPortalLoggedIn("Flipkart", "https://seller.flipkart.com/index.html", longText, false),
    true
  )
  assert.equal(
    isPortalLoggedIn("Flipkart", "https://seller.flipkart.com/login", longText, false),
    false
  )
  assert.equal(
    isPortalLoggedIn("Flipkart", "https://seller.flipkart.com/dashboard", longText, true),
    false
  )
})

test("secretFromEnvironment resolves Meesho credentials when environment variables are set", () => {
  const envKeys = [
    "MEESHOID",
    "MEESHO_ID",
    "MEESHO_USERNAME",
    "MEESHO_PWD",
    "MEESHO_PASSWORD",
    "MEESHO_PASS",
  ] as const
  const originalEnv: Record<string, string | undefined> = {}
  for (const key of envKeys) {
    originalEnv[key] = process.env[key]
  }

  try {
    for (const key of envKeys) {
      delete process.env[key]
    }

    assert.equal(secretFromEnvironment("Meesho"), null)

    process.env.MEESHOID = "seller@example.com"
    process.env.MEESHO_PWD = "secretpassword"
    const resolved = secretFromEnvironment("Meesho")
    assert.ok(resolved)
    assert.equal(resolved?.username, "seller@example.com")
    assert.equal(resolved?.password, "secretpassword")
    assert.equal(resolved?.portalUrl, "https://supplier.meesho.com/panel/v3/new/root/login")

    // Non-meesho marketplace returns null
    assert.equal(secretFromEnvironment("Amazon"), null)
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key]
      } else {
        delete process.env[key]
      }
    }
  }
})

test("Meesho login save enables full-auto; other panels keep approval", () => {
  const row = (accountName: string): PortalLoginRow => ({
    id: 7,
    marketplaceId: 3,
    marketplaceName: accountName,
    accountName,
    portalUrl: "https://supplier.meesho.com/panel/v3/new/root/login",
    usernameMasked: "SY-***",
    requireApprovalBeforeSubmit: true,
    sessionSavedAt: null,
  })
  assert.equal(requireApprovalBeforeSubmitForMarketplace("Meesho"), false)
  assert.equal(requireApprovalBeforeSubmitForMarketplace("SYN-Meesho VB Exports"), false)
  assert.equal(requireApprovalBeforeSubmitForMarketplace("Flipkart"), true)
  const meesho = portalLoginSavePayload(row("Meesho"), "SYN-user", "SYN-pass")
  assert.equal(meesho.requireApprovalBeforeSubmit, false)
  assert.equal(meesho.automationMode, "autonomous")
  const flipkart = portalLoginSavePayload(row("Flipkart"), "SYN-user", "SYN-pass")
  assert.equal(flipkart.requireApprovalBeforeSubmit, true)
  assert.equal(flipkart.automationMode, "assisted")
})

test("secretFromEnvironment respects alias fallback precedence for Meesho credentials", () => {
  const envKeys = [
    "MEESHOID",
    "MEESHO_ID",
    "MEESHO_USERNAME",
    "MEESHO_PWD",
    "MEESHO_PASSWORD",
    "MEESHO_PASS",
  ] as const
  const originalEnv: Record<string, string | undefined> = {}
  for (const key of envKeys) {
    originalEnv[key] = process.env[key]
  }

  try {
    for (const key of envKeys) {
      delete process.env[key]
    }

    // Set fallback aliases
    process.env.MEESHO_USERNAME = "user_fallback@example.com"
    process.env.MEESHO_PASS = "pass_fallback"
    let resolved = secretFromEnvironment("Meesho")
    assert.equal(resolved?.username, "user_fallback@example.com")
    assert.equal(resolved?.password, "pass_fallback")

    // Primary alias MEESHO_ID takes precedence over MEESHO_USERNAME
    process.env.MEESHO_ID = "user_id@example.com"
    process.env.MEESHO_PASSWORD = "pass_password"
    resolved = secretFromEnvironment("Meesho")
    assert.equal(resolved?.username, "user_id@example.com")
    assert.equal(resolved?.password, "pass_password")

    // MEESHOID takes precedence over MEESHO_ID
    process.env.MEESHOID = "user_root@example.com"
    process.env.MEESHO_PWD = "pass_root"
    resolved = secretFromEnvironment("Meesho")
    assert.equal(resolved?.username, "user_root@example.com")
    assert.equal(resolved?.password, "pass_root")
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key]
      } else {
        delete process.env[key]
      }
    }
  }
})

test("clearSessionMarker clears expired session markers cleanly and tolerates missing markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-session-clear-"))
  assert.equal(clearSessionMarker(dir), false)
  writeSessionMarker(dir, "Meesho")
  assert.ok(readSessionSavedAt(dir))
  assert.equal(clearSessionMarker(dir), true)
  assert.equal(readSessionSavedAt(dir), null)
})

test("isPortalLoggedIn rejects Meesho OTP and registration routes", () => {
  assert.equal(isPortalLoggedIn("Meesho", "https://supplier.meesho.com/panel/v3/new/root/otp", "Enter OTP", false), false)
  assert.equal(isPortalLoggedIn("Meesho", "https://supplier.meesho.com/panel/v3/new/root/register", "Register", false), false)
})

test("portalLoginSavePayload omits empty secrets when upgrading Meesho to autonomous and upgrades v2 portal URL", () => {
  const legacyRow: PortalLoginRow = {
    id: 9,
    marketplaceId: 3,
    marketplaceName: "Meesho",
    accountName: "Meesho",
    portalUrl: "https://supplier.meesho.com/panel/v2/new/returns/claims",
    usernameMasked: "SY-***",
    requireApprovalBeforeSubmit: true,
    sessionSavedAt: null,
  }
  const upgraded = portalLoginSavePayload(legacyRow)
  assert.equal(upgraded.portalUrl, "https://supplier.meesho.com/panel/v3/new/root/login")
  assert.equal(upgraded.automationMode, "autonomous")
  assert.equal(upgraded.requireApprovalBeforeSubmit, false)
  assert.equal("username" in upgraded, false)
  assert.equal("password" in upgraded, false)
})

test("completePortalLogin fails fast on expired session when failFastOnManualPrompt is true and clears stale marker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-failfast-"))
  writeSessionMarker(dir, "Meesho")
  let shownManual = false
  const stubBrowser: any = {
    profileDirectory: dir,
    async navigate() {},
    async evaluate(script: string) {
      if (script.includes("isPortalLoggedIn")) return false
      if (script.includes("#loginbutton")) return false
      if (script.includes('input[type="password"]')) return true
      return false
    },
    async humanClick() { return true },
    async humanType() { return true },
    async detectCaptchaOrOtp() { return { challengeDetected: false } },
    async showForManualStep() { shownManual = true },
    async delay() {},
    async close() {},
  }
  const origNow = Date.now
  let fakeNow = 10_000
  Date.now = () => {
    fakeNow += 2000
    return fakeNow
  }
  try {
    const res = await completePortalLogin(stubBrowser, {
      marketplace: "Meesho",
      portalUrl: "https://supplier.meesho.com/panel/v3/new/root/login",
      username: "",
      password: "",
      failFastOnManualPrompt: true,
      waitMs: 60000,
      sessionDir: dir,
    })
    assert.equal(res.ok, false)
    assert.equal(res.loginRequired, true)
    assert.equal(shownManual, true)
    assert.equal(readSessionSavedAt(dir), null, "stale session marker must be removed on expiry")
  } finally {
    Date.now = origNow
  }
})
