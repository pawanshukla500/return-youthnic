// Authentication, persistent device sessions, and access control for the Return App.
//
// Follows agency identity engineering standards:
// - Cryptographically secure token generation (32 bytes entropy).
// - Tokens are stored only as SHA-256 hashes in the database, never raw.
// - Supports both HttpOnly SameSite=Lax cookies and Authorization Bearer headers.
// - Configurable absolute duration (up to 30 days for remembered warehouse devices) and idle timeouts.
// - Instant server-side revocation by session ID or by user ID.
// - Device metadata tracking (device name, IP, User-Agent, last active timestamp).
// - Fallback to legacy sessions table ensures zero lockout during upgrades.

import crypto from "node:crypto"
import type { Request, Response } from "express"
import type pg from "pg"
import { scopeFor, type AccountScope } from "./access.js"
import { lastSignInLabel } from "./format.js"

export const SESSION_COOKIE_NAME = "return_session"

export type SessionConfig = {
  rememberDurationDays: number
  rememberIdleDays: number
  standardDurationHours: number
  standardIdleHours: number
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  rememberDurationDays: 30,
  rememberIdleDays: 7,
  standardDurationHours: 24,
  standardIdleHours: 4,
}

export type DeviceSession = {
  id: number
  userId: number
  userName: string
  userEmail: string
  userRole: string
  deviceName: string
  userAgent: string
  ipAddress: string
  isRemembered: boolean
  createdAt: string
  lastActiveAt: string
  expiresAt: string
  idleExpiresAt: string
  isCurrent?: boolean
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex")
}

// Friendly device name extractor from User-Agent
export function parseDeviceName(userAgent: string): string {
  if (!userAgent) return "Warehouse Terminal"
  const ua = userAgent.toLowerCase()
  let os = "Device"
  if (ua.includes("windows")) os = "Windows PC"
  else if (ua.includes("android")) os = "Android Device"
  else if (ua.includes("iphone") || ua.includes("ipad")) os = "iOS Device"
  else if (ua.includes("macintosh") || ua.includes("mac os")) os = "Mac"
  else if (ua.includes("linux")) os = "Linux PC"

  let browser = "Browser"
  if (ua.includes("edg/")) browser = "Edge"
  else if (ua.includes("chrome") && !ua.includes("edg/")) browser = "Chrome"
  else if (ua.includes("firefox")) browser = "Firefox"
  else if (ua.includes("safari") && !ua.includes("chrome")) browser = "Safari"

  return `${browser} on ${os}`
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result
  const pairs = header.split(";")
  for (const pair of pairs) {
    const idx = pair.indexOf("=")
    if (idx < 0) continue
    const key = pair.slice(0, idx).trim()
    const val = pair.slice(idx + 1).trim()
    if (key) result[key] = decodeURIComponent(val)
  }
  return result
}

export async function getSessionConfig(db: pg.Pool): Promise<SessionConfig> {
  try {
    const result = await db.query(
      "SELECT setting_value FROM app_system_settings WHERE setting_key = 'session_config'",
    )
    if (result.rows[0]?.setting_value) {
      const stored = result.rows[0].setting_value as Partial<SessionConfig>
      return {
        rememberDurationDays: Math.min(Math.max(Number(stored.rememberDurationDays) || 30, 1), 60),
        rememberIdleDays: Math.min(Math.max(Number(stored.rememberIdleDays) || 7, 1), 30),
        standardDurationHours: Math.min(Math.max(Number(stored.standardDurationHours) || 24, 1), 72),
        standardIdleHours: Math.min(Math.max(Number(stored.standardIdleHours) || 4, 1), 24),
      }
    }
  } catch {
    // If table doesn't exist yet, return defaults
  }
  return DEFAULT_SESSION_CONFIG
}

export async function updateSessionConfig(
  db: pg.Pool,
  config: Partial<SessionConfig>,
  actorUserId: number,
): Promise<SessionConfig> {
  const current = await getSessionConfig(db)
  const updated: SessionConfig = {
    rememberDurationDays: Math.min(Math.max(Number(config.rememberDurationDays ?? current.rememberDurationDays), 1), 60),
    rememberIdleDays: Math.min(Math.max(Number(config.rememberIdleDays ?? current.rememberIdleDays), 1), 30),
    standardDurationHours: Math.min(Math.max(Number(config.standardDurationHours ?? current.standardDurationHours), 1), 72),
    standardIdleHours: Math.min(Math.max(Number(config.standardIdleHours ?? current.standardIdleHours), 1), 24),
  }

  await db.query(
    `INSERT INTO app_system_settings (setting_key, setting_value, updated_at, updated_by)
     VALUES ('session_config', $1::jsonb, now(), $2)
     ON CONFLICT (setting_key) DO UPDATE
     SET setting_value = EXCLUDED.setting_value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(updated), actorUserId],
  )

  await db.query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'system.update_session_config', 'session_config', 'default', $2::jsonb)`,
    [actorUserId, JSON.stringify(updated)],
  )

  return updated
}

export type CreateSessionResult = {
  token: string
  expiresAt: Date
  maxAgeSeconds: number
  sessionId: number
}

export async function createDeviceSession(
  db: pg.Pool,
  userId: number,
  options: {
    rememberDevice: boolean
    userAgent?: string
    ipAddress?: string
  },
): Promise<CreateSessionResult> {
  const config = await getSessionConfig(db)
  const token = generateToken()
  const tokenHash = hashToken(token)

  const isRemembered = Boolean(options.rememberDevice)
  const now = new Date()

  // Durations
  const absoluteMs = isRemembered
    ? config.rememberDurationDays * 24 * 60 * 60 * 1000
    : config.standardDurationHours * 60 * 60 * 1000

  const idleMs = isRemembered
    ? config.rememberIdleDays * 24 * 60 * 60 * 1000
    : config.standardIdleHours * 60 * 60 * 1000

  const expiresAt = new Date(now.getTime() + absoluteMs)
  const idleExpiresAt = new Date(now.getTime() + idleMs)
  const maxAgeSeconds = Math.floor(absoluteMs / 1000)

  const userAgent = (options.userAgent || "").slice(0, 500)
  const deviceName = parseDeviceName(userAgent)
  const ipAddress = (options.ipAddress || "").slice(0, 100)

  // Insert into user_sessions
  const sessionResult = await db.query(
    `INSERT INTO user_sessions
      (user_id, token_hash, device_name, user_agent, ip_address, is_remembered, created_at, last_active_at, expires_at, idle_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9)
     RETURNING id`,
    [userId, tokenHash, deviceName, userAgent, ipAddress, isRemembered, now, expiresAt, idleExpiresAt],
  )

  const sessionId = Number(sessionResult.rows[0].id)

  // Zero plaintext tokens in PostgreSQL: tokens are hashed via SHA-256 in user_sessions.
  // The raw token is exclusively held in the client's secure HttpOnly cookie.

  return {
    token,
    expiresAt,
    maxAgeSeconds,
    sessionId,
  }
}

export function setSessionCookie(
  req: Request,
  res: Response,
  token: string,
  maxAgeSeconds: number,
): void {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production"
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (isHttps) cookieParts.push("Secure")

  res.setHeader("Set-Cookie", cookieParts.join("; "))
}

export function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production"
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ]
  if (isHttps) cookieParts.push("Secure")

  res.setHeader("Set-Cookie", cookieParts.join("; "))
}

export function extractSessionToken(req: Request): string {
  // Check authorization header first
  const header = req.header("authorization") || ""
  if (header.startsWith("Bearer ")) {
    const raw = header.slice(7).trim()
    if (raw) return raw
  }

  // Check HttpOnly session cookie
  const cookies = parseCookies(req.headers.cookie)
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME].trim()
  }

  // Check fallback token cookie
  if (cookies.return_token) {
    return cookies.return_token.trim()
  }

  return ""
}

export type ValidatedSession = {
  sessionId?: number
  tokenHash?: string
  userId: number
  isRemembered: boolean
  user: {
    id: number
    initials: string
    name: string
    email: string
    role: string
    sidebar_label: string
    has_all_marketplaces: boolean
    scans_today: string | number
    status: string
    last_session_at: string | Date | null
    marketplace_ids: number[]
    assigned_marketplaces: string
  }
}

export async function validateSessionToken(
  db: pg.Pool,
  token: string,
  userSelectQuery: string,
): Promise<ValidatedSession | null> {
  if (!token || token.length < 16) return null
  const tokenHash = hashToken(token)

  // 1. Try finding in user_sessions
  try {
    const sessionRes = await db.query(
      `SELECT
         s.id AS session_id,
         s.user_id,
         s.is_remembered,
         s.expires_at,
         s.idle_expires_at,
         s.last_active_at,
         s.revoked_at,
         u.status AS user_status,
         ${userSelectQuery}
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [tokenHash],
    )

    if (sessionRes.rows[0]) {
      const row = sessionRes.rows[0]
      const now = new Date()

      // Check revoked
      if (row.revoked_at) return null

      // Check user account status
      if (String(row.user_status || "").toLowerCase() === "disabled") return null

      // Check absolute expiration
      if (new Date(row.expires_at) < now) return null

      // Check idle expiration
      if (new Date(row.idle_expires_at) < now) return null

      // Sliding idle expiration renewal: extend idle timestamp if more than 5 minutes since last update
      const lastActive = new Date(row.last_active_at)
      if (now.getTime() - lastActive.getTime() > 5 * 60 * 1000) {
        const config = await getSessionConfig(db)
        const idleMs = row.is_remembered
          ? config.rememberIdleDays * 24 * 60 * 60 * 1000
          : config.standardIdleHours * 60 * 60 * 1000
        const newIdle = new Date(now.getTime() + idleMs)

        // Asynchronous fire-and-forget update to keep latency minimal
        db.query(
          "UPDATE user_sessions SET last_active_at = $1, idle_expires_at = $2 WHERE id = $3",
          [now, newIdle, row.session_id],
        ).catch(() => undefined)
      }

      return {
        sessionId: Number(row.session_id),
        tokenHash,
        userId: Number(row.user_id),
        isRemembered: Boolean(row.is_remembered),
        user: row as any,
      }
    }
  } catch {
    // If user_sessions table does not exist or errors, fall through to legacy table
  }

  // 2. Fallback to legacy sessions table
  try {
    const legacyRes = await db.query(
      `SELECT ${userSelectQuery}
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1`,
      [token],
    )
    if (legacyRes.rows[0]) {
      const row = legacyRes.rows[0]
      if (String(row.status || "").toLowerCase() === "disabled") return null
      return {
        userId: Number(row.id),
        isRemembered: false,
        user: row as any,
      }
    }
  } catch {
    return null
  }

  return null
}

export async function revokeSessionById(
  db: pg.Pool,
  sessionId: number,
  actorUserId: number,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE user_sessions
     SET revoked_at = now(), revoked_by = $1
     WHERE id = $2 AND revoked_at IS NULL
     RETURNING user_id, device_name`,
    [actorUserId, sessionId],
  )
  if (result.rows[0]) {
    await db.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'session.revoke', 'user_sessions', $2, $3::jsonb)`,
      [actorUserId, String(sessionId), JSON.stringify({ userId: result.rows[0].user_id, deviceName: result.rows[0].device_name })],
    )
    return true
  }
  return false
}

export async function revokeAllSessionsForUser(
  db: pg.Pool,
  targetUserId: number,
  actorUserId: number,
): Promise<number> {
  const result = await db.query(
    `UPDATE user_sessions
     SET revoked_at = now(), revoked_by = $1
     WHERE user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [actorUserId, targetUserId],
  )

  // Also clear legacy sessions
  try {
    await db.query("DELETE FROM sessions WHERE user_id = $1", [targetUserId])
  } catch {
    // Ignore legacy delete errors
  }

  await db.query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'session.revoke_all_user', 'users', $2, $3::jsonb)`,
    [actorUserId, String(targetUserId), JSON.stringify({ revokedCount: result.rowCount })],
  )

  return result.rowCount ?? 0
}

export async function listActiveSessions(
  db: pg.Pool,
  userId?: number,
  currentTokenHash?: string,
): Promise<DeviceSession[]> {
  try {
    const params: unknown[] = []
    let userFilter = ""
    if (userId) {
      params.push(userId)
      userFilter = "AND s.user_id = $1"
    }

    const query = `
      SELECT
        s.id,
        s.user_id,
        u.name AS user_name,
        u.email AS user_email,
        u.role AS user_role,
        s.device_name,
        s.user_agent,
        s.ip_address,
        s.is_remembered,
        s.created_at,
        s.last_active_at,
        s.expires_at,
        s.idle_expires_at,
        s.token_hash
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.idle_expires_at > now()
        ${userFilter}
      ORDER BY s.last_active_at DESC
      LIMIT 100
    `

    const res = await db.query(query, params)
    return res.rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      userName: String(row.user_name),
      userEmail: String(row.user_email),
      userRole: String(row.user_role),
      deviceName: String(row.device_name),
      userAgent: String(row.user_agent),
      ipAddress: String(row.ip_address),
      isRemembered: Boolean(row.is_remembered),
      createdAt: lastSignInLabel(row.created_at),
      lastActiveAt: lastSignInLabel(row.last_active_at),
      expiresAt: new Date(row.expires_at).toISOString(),
      idleExpiresAt: new Date(row.idle_expires_at).toISOString(),
      isCurrent: currentTokenHash ? row.token_hash === currentTokenHash : false,
    }))
  } catch {
    return []
  }
}
