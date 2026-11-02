import fs from "node:fs"
import path from "node:path"

/**
 * Supplier-session locations shared by the login, status and worker code.
 *
 * Two browser adapters keep two different kinds of sessions, so the
 * on-disk marker that says "this panel signed in at <time>" must be
 * scoped by adapter as well as by marketplace account:
 *
 * - external: the system-Chromium profile directory
 *   `<userDataDir>/profile-<account>` (cookies live there).
 * - native: the Electron partition `persist:supplier-<panel>` owns the
 *   cookies, which is not a filesystem path. Markers live in
 *   `<userDataDir>/native-<panel>` instead, so a native marker can never
 *   be mistaken for an external profile and vice versa.
 *
 * The marker is only ever written after the marketplace session itself
 * verified signed-in (`loggedIn()` in portal-login.ts); status readers
 * report the marker, and Test Login re-verifies against the live panel.
 */

export function accountKey(accountName: string): string {
  return accountName.toLowerCase().replace(/[^a-z0-9]/g, "_") || "unknown"
}

/** Filesystem directory of the external adapter's per-account CDP profile. */
export function profileDirFor(userDataDir: string, marketplace: string): string {
  return path.join(userDataDir, `profile-${accountKey(marketplace)}`)
}

/**
 * Directory that holds the `return-app-session.json` marker for an account
 * under the currently selected adapter. Native markers live beside — never
 * inside — the external profiles.
 */
export function supplierSessionDir(userDataDir: string, accountName: string, adapterKind: "external" | "native"): string {
  if (adapterKind === "native") return path.join(userDataDir, `native-${accountKey(accountName)}`)
  return profileDirFor(userDataDir, accountName)
}

export function sessionMarkerPath(sessionDir: string): string {
  return path.join(sessionDir, "return-app-session.json")
}

export function readSessionSavedAt(sessionDir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionMarkerPath(sessionDir), "utf8")) as { savedAt?: string }
    return parsed.savedAt || null
  } catch {
    return null
  }
}

export function writeSessionMarker(sessionDir: string, accountName: string): void {
  if (!sessionDir) return
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(
    sessionMarkerPath(sessionDir),
    JSON.stringify({ accountName, savedAt: new Date().toISOString() }),
    "utf8",
  )
}
