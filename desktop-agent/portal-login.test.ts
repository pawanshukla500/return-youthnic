import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { profileDirFor, readSessionSavedAt, sessionMarkerPath } from "./src/portal-login.ts"

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
