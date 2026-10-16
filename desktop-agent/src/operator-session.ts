import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadAgentConfig } from "./config.js"

export type OperatorProfile = {
  name: string
  email: string
  role: string
}

type StoredSession = OperatorProfile & {
  token: string
}

function sessionFile(): string {
  return path.join(os.homedir(), ".taskflow-claim-agent", "operator-session.json")
}

function readStored(): StoredSession | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(), "utf8")) as StoredSession
    if (!parsed?.token) return null
    return parsed
  } catch {
    return null
  }
}

function writeStored(session: StoredSession): void {
  const file = sessionFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(session), { encoding: "utf8" })
}

export function operatorAuthorization(): string | null {
  const stored = readStored()
  if (!stored?.token) return null
  return `Bearer ${stored.token}`
}

export function clearOperatorSession(): void {
  try {
    fs.unlinkSync(sessionFile())
  } catch {
    // Already signed out.
  }
}

function profileOf(user: { name?: string; email?: string; role?: string }): OperatorProfile {
  return {
    name: String(user.name || "Operator"),
    email: String(user.email || ""),
    role: String(user.role || ""),
  }
}

function backendOrigin(): string {
  return loadAgentConfig().backendUrl.replace(/\/$/, "")
}

async function fetchProfile(token: string): Promise<OperatorProfile | null> {
  const res = await fetch(`${backendOrigin()}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const data = (await res.json()) as { user?: { name?: string; email?: string; role?: string } }
  if (!data.user) return null
  return profileOf(data.user)
}

// A saved sign-in lets the claim bot keep working across restarts of this desktop app.
// An expired token is cleared. A network drop keeps the saved sign-in so a short outage does not stop the bot.
export async function currentOperator(): Promise<OperatorProfile | null> {
  const stored = readStored()
  if (!stored) return null
  try {
    const profile = await fetchProfile(stored.token)
    if (!profile) {
      clearOperatorSession()
      return null
    }
    writeStored({ token: stored.token, ...profile })
    return profile
  } catch {
    return profileOf(stored)
  }
}

export async function loginOperator(
  email: string,
  password: string,
): Promise<{ ok: true; user: OperatorProfile } | { ok: false; status: number; message: string }> {
  const trimmed = email.trim().toLowerCase()
  if (!trimmed || !password) {
    return { ok: false, status: 400, message: "Email and password are required." }
  }

  let res: Response
  try {
    res = await fetch(`${backendOrigin()}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: trimmed, password, rememberDevice: true }),
    })
  } catch {
    return { ok: false, status: 503, message: "Cannot reach the Return App server. Check the internet connection." }
  }

  const data = (await res.json().catch(() => ({}))) as {
    token?: string
    error?: string
    user?: { name?: string; email?: string; role?: string }
  }
  if (!res.ok || !data.token || !data.user) {
    return { ok: false, status: res.status || 401, message: data.error || "Sign-in failed." }
  }

  const user = profileOf(data.user)
  writeStored({ token: data.token, ...user })
  return { ok: true, user }
}

export async function operatorFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const stored = readStored()
  if (!stored?.token) {
    throw new Error("Sign in on the claim bot before setting up a supplier login.")
  }
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${stored.token}`)
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  return fetch(`${backendOrigin()}${pathname}`, { ...init, headers })
}

export async function logoutOperator(): Promise<void> {
  const stored = readStored()
  if (stored?.token) {
    await fetch(`${backendOrigin()}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stored.token}` },
    }).catch(() => undefined)
  }
  clearOperatorSession()
}
