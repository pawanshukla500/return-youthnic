import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { profileDirFor, readSessionSavedAt, sessionMarkerPath, supplierSessionDir } from "./src/supplier-session.ts"
import { isPortalLoggedIn, secretFromEnvironment } from "./src/portal-login.ts"

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
