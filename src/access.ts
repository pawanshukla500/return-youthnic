import type { SessionUser } from "./types"

// The same rule as the server (server/access.ts): the role "Admin", in any letter case. This only decides what the screen
// shows. The server refuses every administrator request from anyone else, whatever the screen does.
export function isAdminUser(user: Pick<SessionUser, "role">): boolean {
  return String(user.role || "").trim().toLowerCase() === "admin"
}

export function isSupervisorUser(user: Pick<SessionUser, "role">): boolean {
  return String(user.role || "").trim().toLowerCase() === "supervisor"
}

export function isScannerUser(user: Pick<SessionUser, "role">): boolean {
  return String(user.role || "").trim().toLowerCase() === "scanner"
}

export function isSupervisorOrAdminUser(user: Pick<SessionUser, "role">): boolean {
  const r = String(user.role || "").trim().toLowerCase()
  return r === "admin" || r === "supervisor"
}
