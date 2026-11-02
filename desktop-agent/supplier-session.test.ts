// Session-location rules for the supplier browsers: external profiles keep
// their own marker, native partitions get a marker dir beside the profiles
// so a native marker can never be mistaken for an external profile.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  accountKey,
  profileDirFor,
  readSessionSavedAt,
  sessionMarkerPath,
  supplierSessionDir,
  writeSessionMarker,
} from "./src/supplier-session.ts"

test("external sessions keep the profile directory", () => {
  const root = path.join(os.tmpdir(), "SYN-supplier-session")
  assert.equal(supplierSessionDir(root, "Meesho", "external"), path.join(root, "profile-meesho"))
  assert.equal(supplierSessionDir(root, "Myntra VB", "external"), profileDirFor(root, "Myntra VB"))
})

test("native sessions use a marker dir beside the profiles", () => {
  const root = path.join(os.tmpdir(), "SYN-supplier-session")
  const dir = supplierSessionDir(root, "Meesho", "native")
  assert.equal(dir, path.join(root, "native-meesho"))
  assert.ok(!dir.startsWith("persist:"))
})

test("markers round-trip through the adapter-scoped dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-supplier-marker-"))
  assert.equal(readSessionSavedAt(dir), null)
  writeSessionMarker(dir, "SYN-Account")
  assert.match(readSessionSavedAt(dir) || "", /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(sessionMarkerPath(dir), path.join(dir, "return-app-session.json"))
  assert.equal(accountKey("Myntra EJ"), "myntra_ej")
})
