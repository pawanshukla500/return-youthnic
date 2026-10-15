import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import bcrypt from "bcryptjs"
import cors from "cors"
import dotenv from "dotenv"
import express, { type NextFunction, type Request, type Response } from "express"
import multer from "multer"
import { scopeFor, type AccountScope } from "./access.js"
import {
  createDeviceSession,
  setSessionCookie,
  clearSessionCookie,
  extractSessionToken,
  parseCookies,
  SESSION_COOKIE_NAME,
  validateSessionToken,
  listActiveSessions,
  revokeSessionById,
  revokeAllSessionsForUser,
  getSessionConfig,
  updateSessionConfig,
} from "./auth.js"
import {
  getReportsConfig,
  updateReportsConfig,
  sendTestReport,
  runScheduledReports,
} from "./email-reports.js"
import { listRecentReturns, loadClaims, loadDashboard, mapReturn } from "./dashboard.js"
import { sendCatalogImage } from "./catalog-image.js"
import { initDatabase, getPool } from "./db.js"
import { formatCount, lastSignInLabel } from "./format.js"
import { requireAdmin } from "./http.js"
import { mountRegisterRoutes } from "./register-routes.js"
import { mountProductMasterRoutes } from "./product-master-routes.js"
import { mountShopifyRoutes } from "./shopify/routes.js"
import { syncShopifyReturns } from "./shopify/sync.js"
import { workspaceUi } from "./register-service.js"
import { mountUploadRoutes } from "./upload-routes.js"
import { mountScannerListRoutes } from "./scanner-list-routes.js"
import { loginRateLimiter, ipRateLimiter } from "./rate-limit.js"
import { handleLatestRelease, handleApkDownload } from "./mobile-release.js"
import { mountOmsguruRoutes } from "./omsguru-routes.js"
import { runScheduledOmsguruUpdate, getOmsguruConfig } from "./omsguru-daily.js"
import { isFirebaseConfigured } from "./firebase-storage.js"
import { mountPaymentRoutes } from "./payment/routes.js"
import { mountReturnReasonsRoutes } from "./return-reasons-routes.js"
import { runScheduledPaymentSync } from "./payment/sync.js"
import { closePaymentPool, paymentDatabaseUrl } from "./payment/db.js"
import { mountIronRoutes } from "./iron-routes.js"
import { mountClaimsRoutes } from "./claims-routes.js"
import { mountClaimAutomationRoutes } from "./claim-automation-routes.js"
import { attachLiveServer, closeLiveServer } from "./live.js"
import type { IncomingMessage } from "node:http"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
dotenv.config({ path: path.join(root, ".env") })

// One row of the signed-in user, as userSelect reads it. password_hash is used only to check a sign-in and is never
// sent to the browser (publicUser picks the fields).
type UserRow = {
  id: number
  initials: string
  name: string
  email: string
  role: string
  sidebar_label: string
  has_all_marketplaces: boolean
  can_receive_reports?: boolean
  marketplace_ids: number[]
  assigned_marketplaces: string
  scans_today: number
  status: string
  last_session_at: Date | null
  password_hash: string
}

// The request after requireUser: the profile row, plus the account scope every route of this request is limited to.
type SessionRequest = Request & {
  user: UserRow & { scope: AccountScope }
  sessionMetadata?: { sessionId?: number; tokenHash?: string; isRemembered?: boolean }
}

// Calendar days are Indian Standard Time, the timezone the scan screen already uses.
const TODAY_IST = "(now() AT TIME ZONE 'Asia/Kolkata')::date"
const SCAN_DAY_IST = "(rs.scanned_at AT TIME ZONE 'Asia/Kolkata')::date"

const userSelect = `
  u.id,
  u.initials,
  u.name,
  u.email,
  u.role,
  u.sidebar_label,
  u.status,
  u.password_hash,
  u.has_all_marketplaces,
  COALESCE(u.can_receive_reports, false) AS can_receive_reports,
  ARRAY(
    SELECT um.marketplace_id FROM user_marketplaces um WHERE um.user_id = u.id ORDER BY um.marketplace_id
  )::integer[] AS marketplace_ids,
  (
    SELECT GREATEST(
      (SELECT MAX(se.created_at) FROM sessions se WHERE se.user_id = u.id),
      (SELECT MAX(us.last_active_at) FROM user_sessions us WHERE us.user_id = u.id AND us.revoked_at IS NULL)
    )
  ) AS last_session_at,
  (
    SELECT COUNT(*)::int
    FROM receipt_scans rs
    WHERE rs.scanned_by = u.id AND ${SCAN_DAY_IST} = ${TODAY_IST}
  ) AS scans_today,
  CASE
    WHEN u.has_all_marketplaces THEN 'All marketplaces'
    ELSE COALESCE((
      SELECT string_agg(m.name, ', ' ORDER BY m.sort_order, m.id)
      FROM user_marketplaces um
      JOIN marketplaces m ON m.id = um.marketplace_id
      WHERE um.user_id = u.id
    ), '')
  END AS assigned_marketplaces
`

let ready = false
let dbMessage = "Add DATABASE_URL to the .env file and restart the server."

const app = express()
app.set("trust proxy", 1)

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "https://return.youthnic.shop",
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()) : []),
]

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true)
      } else {
        callback(null, false)
      }
    },
    credentials: true,
  }),
)
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
  res.setHeader("X-XSS-Protection", "1; mode=block")
  next()
})
app.use(express.json({ limit: "2mb" }))

// CSRF defense-in-depth: Reject state-changing mutations from untrusted origins
app.use((req, res, next) => {
  const method = req.method.toUpperCase()
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const origin = req.headers.origin
    if (origin) {
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return res.status(403).json({ error: "Cross-site request blocked (CSRF protection)" })
      }
    } else {
      const referer = req.headers.referer
      if (referer) {
        try {
          const refererOrigin = new URL(referer).origin
          if (!ALLOWED_ORIGINS.includes(refererOrigin)) {
            return res.status(403).json({ error: "Cross-site request blocked (CSRF protection)" })
          }
        } catch {
          return res.status(403).json({ error: "Invalid referer header" })
        }
      }
    }
  }
  next()
})

function scopeOfRow(row: UserRow): AccountScope {
  return scopeFor({
    role: row.role,
    hasAllMarketplaces: row.has_all_marketplaces,
    marketplaceIds: row.marketplace_ids ?? [],
  })
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    initials: user.initials,
    name: user.name,
    email: user.email,
    role: user.role,
    sidebarLabel: user.sidebar_label,
    assignedMarketplaces: user.assigned_marketplaces,
    scansToday: String(user.scans_today),
    status: user.status,
    lastActive: lastSignInLabel(user.last_session_at),
    canReceiveReports: Boolean(user.can_receive_reports),
  }
}

function requireDatabase(_req: Request, res: Response, next: NextFunction) {
  if (!ready) return res.status(503).json({ error: dbMessage })
  next()
}

// Loads the signed-in user from the session token (cookie or header) and attaches the account scope.
async function requireUser(req: Request, res: Response, next: NextFunction) {
  try {
    if (!ready) return res.status(503).json({ error: dbMessage })
    const token = extractSessionToken(req)
    if (!token) return res.status(401).json({ error: "Sign in required" })
    const validated = await validateSessionToken(getPool(), token, userSelect)
    if (!validated) return res.status(401).json({ error: "Sign in required or session expired" })
    const userRow = validated.user as UserRow
    ;(req as SessionRequest).user = { ...userRow, scope: scopeOfRow(userRow) }
    ;(req as SessionRequest).sessionMetadata = {
      sessionId: validated.sessionId,
      tokenHash: validated.tokenHash,
      isRemembered: validated.isRemembered,
    }
    next()
  } catch (error) {
    next(error)
  }
}

// The same session check as requireUser, for the WebSocket upgrade request of /api/live (server/live.ts). The browser
// sends its session cookie; the Android app sends its Authorization header.
async function authenticateUpgrade(req: IncomingMessage): Promise<{ userId: number; scope: AccountScope } | null> {
  if (!ready) return null
  const header = String(req.headers.authorization || "")
  let token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!token) {
    const cookies = parseCookies(req.headers.cookie)
    token = (cookies[SESSION_COOKIE_NAME] || cookies.return_token || "").trim()
  }
  if (!token) return null
  const validated = await validateSessionToken(getPool(), token, userSelect)
  if (!validated) return null
  const row = validated.user as UserRow
  return { userId: row.id, scope: scopeOfRow(row) }
}

// Administrator changes to configuration are written to the audit log, with the user who made them.
async function auditAdminChange(actorId: number, action: string, entityId: string, details: Record<string, unknown>) {
  await getPool().query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, 'admin_config', $3, $4::jsonb)`,
    [actorId, action, entityId, JSON.stringify(details)],
  )
}

// Brandfetch icon for a connected account. The client id stays on the server. Without it, the badge keeps its letter.
const BRAND_DOMAINS: Record<string, string> = {
  Amazon: "amazon.in",
  Flipkart: "flipkart.com",
  Meesho: "meesho.com",
  "Myntra VB": "myntra.com",
  "Myntra EJ": "myntra.com",
  Ajio: "ajio.com",
}

app.get("/api/brand-logo/:name", async (req, res) => {
  const domain = BRAND_DOMAINS[req.params.name]
  const clientId = process.env.BRANDFETCH_CLIENT_ID?.trim()
  if (!domain || !clientId) return res.status(404).end()
  const upstream = await fetch(
    `https://cdn.brandfetch.io/domain/${domain}/type/icon/w/128/h/128/fallback/lettermark?c=${encodeURIComponent(clientId)}`,
  )
  if (!upstream.ok) return res.status(404).end()
  const type = upstream.headers.get("content-type") || ""
  if (!type.startsWith("image/")) return res.status(404).end()
  res.setHeader("Content-Type", type)
  res.setHeader("Cache-Control", "public, max-age=86400")
  res.send(Buffer.from(await upstream.arrayBuffer()))
})

app.get("/api/catalog-image", requireDatabase, async (req, res, next) => {
  try {
    await sendCatalogImage(req, res, getPool())
  } catch (error) {
    next(error)
  }
})

app.get("/api/health", async (_req, res, next) => {
  try {
    if (!ready) {
      return res.status(503).json({ ok: false, database: "disconnected", message: dbMessage })
    }
    const result = await getPool().query("SELECT current_database() AS name")
    res.json({ ok: true, database: "connected", name: result.rows[0].name })
  } catch (error) {
    next(error)
  }
})

app.get("/api/app/latest", handleLatestRelease)
app.get("/download/return-scan.apk", handleApkDownload)

app.post("/api/auth/login", requireDatabase, async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase()
    const password = String(req.body?.password || "")
    const rememberDevice = Boolean(req.body?.rememberDevice)
    const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || ""
    const userAgent = req.headers["user-agent"] || ""

    const ipCheck = ipRateLimiter.isLocked(ipAddress)
    if (ipCheck.locked) {
      return res.status(429).json({
        error: `Too many login attempts from this network. Please wait ${ipCheck.retryAfterSeconds} seconds before trying again.`,
      })
    }

    const accountCheck = loginRateLimiter.isLocked(email)
    if (accountCheck.locked) {
      return res.status(429).json({
        error: `Too many failed login attempts for this account. Please wait ${accountCheck.retryAfterSeconds} seconds before trying again.`,
      })
    }

    const result = await getPool().query(
      `SELECT ${userSelect}
       FROM users u
       WHERE lower(u.email) = $1 OR lower(COALESCE(u.login_alias, '')) = $1`,
      [email],
    )
    const user = result.rows[0] as UserRow | undefined
    const matches = user ? await bcrypt.compare(password, user.password_hash) : false
    if (!user || !matches) {
      loginRateLimiter.recordFailure(email)
      ipRateLimiter.recordFailure(ipAddress)
      await getPool().query(
        `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'auth.login_failed', 'users', $2, $3::jsonb)`,
        [user?.id ?? null, String(user?.id ?? 0), JSON.stringify({ email, ipAddress, userAgent: userAgent.slice(0, 100) })],
      ).catch(() => undefined)
      return res.status(401).json({ error: "Incorrect email or password." })
    }
    if (String(user.status || "").toLowerCase() === "disabled") {
      return res.status(403).json({ error: "This account has been disabled. Contact an administrator." })
    }

    loginRateLimiter.reset(email)
    ipRateLimiter.reset(ipAddress)

    const session = await createDeviceSession(getPool(), user.id, {
      rememberDevice,
      userAgent,
      ipAddress,
    })

    setSessionCookie(req, res, session.token, session.maxAgeSeconds)

    await getPool().query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'auth.login', 'users', $2, $3::jsonb)`,
      [user.id, String(user.id), JSON.stringify({ rememberDevice, ipAddress, userAgent: userAgent.slice(0, 100) })],
    ).catch(() => undefined)

    const ui = await workspaceUi(getPool(), scopeOfRow(user))
    res.json({
      token: session.token,
      user: publicUser(user),
      claimsBadge: ui.claimsBadge,
      headerDate: ui.headerDate,
      expiresAt: session.expiresAt.toISOString(),
      rememberDevice,
    })
  } catch (error) {
    next(error)
  }
})

if (process.env.NODE_ENV !== "production") {
  app.get("/api/auth/dev-login", async (req, res) => {
    const token = String(req.query.token || "")
    if (token) {
      setSessionCookie(req, res, token, 30 * 24 * 3600)
      return res.redirect("http://localhost:5173/")
    }
    res.status(400).send("Token required")
  })
}

app.get("/api/auth/me", requireUser, async (req, res, next) => {
  try {
    const user = (req as SessionRequest).user
    const ui = await workspaceUi(getPool(), user.scope)
    res.json({
      user: publicUser(user),
      claimsBadge: ui.claimsBadge,
      headerDate: ui.headerDate,
    })
  } catch (error) {
    next(error)
  }
})

app.post("/api/auth/logout", requireUser, async (req, res, next) => {
  try {
    const token = extractSessionToken(req)
    if (token) {
      const meta = (req as SessionRequest).sessionMetadata
      if (meta?.sessionId) {
        await revokeSessionById(getPool(), meta.sessionId, (req as SessionRequest).user.id).catch(() => undefined)
      }
      await getPool().query("DELETE FROM sessions WHERE token = $1", [token]).catch(() => undefined)
    }
    clearSessionCookie(req, res)
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.get("/api/dashboard", requireUser, async (req, res, next) => {
  try {
    const scope = (req as SessionRequest).user.scope
    const [dashboard, recent] = await Promise.all([
      loadDashboard(getPool(), scope),
      listRecentReturns(getPool(), scope, 4),
    ])
    res.json({ ...dashboard, recent: recent.map(mapReturn) })
  } catch (error) {
    next(error)
  }
})

app.get("/api/claims", requireUser, async (req, res, next) => {
  try {
    res.json(await loadClaims(getPool(), (req as SessionRequest).user.scope))
  } catch (error) {
    next(error)
  }
})

// Upload routes (history, template, preview, activation) live in upload-routes.ts.
mountUploadRoutes(app, requireUser)
mountScannerListRoutes(app, requireUser)

// Scan, ticket, register, account and partner routes live in register-routes.ts.
mountRegisterRoutes(app, requireUser)

// The VB EXPORT product master (Admin-only) lives in product-master-routes.ts.
mountProductMasterRoutes(app, requireUser)

// Shopify real-time return and RTO routes live in shopify/routes.ts.
mountShopifyRoutes(app, requireUser)

// OMSGuru Daily Inventory Update & Firebase Storage routes live in omsguru-routes.ts.
mountOmsguruRoutes(app, requireUser)

// Payment & Sales Amount sync routes live in payment/routes.ts.
mountPaymentRoutes(app, requireUser)

// Return reason standardization & sizing intelligence routes live in return-reasons-routes.ts.
mountReturnReasonsRoutes(app, requireUser)

// Iron Send tracking, return analytics and the live sync cursor live in iron-routes.ts.
mountIronRoutes(app, requireUser)

// Claims foundation: claim lifecycle, evidence media, templates live in claims-routes.ts.
mountClaimsRoutes(app, requireUser)

// Claim automation: desktop agent sync, marketplace portal credentials, return lookup live in claim-automation-routes.ts.
mountClaimAutomationRoutes(app, requireUser)

// ---- Administrator pages. Every route here needs the Admin role. ----

app.get("/api/admin/users", requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const result = await getPool().query(`SELECT ${userSelect} FROM users u ORDER BY u.id`)
    res.json({
      users: result.rows.map((row) => ({
        id: row.id,
        initials: row.initials,
        name: row.name,
        email: row.email,
        role: row.role,
        marketplaces: row.assigned_marketplaces,
        scansToday: String(row.scans_today),
        status: row.status,
        lastActive: lastSignInLabel(row.last_session_at),
      })),
    })
  } catch (error) {
    next(error)
  }
})

app.post("/api/admin/users", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim()
    const email = String(req.body?.email || "").trim().toLowerCase()
    const password = String(req.body?.password || "")
    const roleInput = String(req.body?.role || "Scanner").trim()
    const alias = String(req.body?.alias || "").trim().toLowerCase() || null
    const allMarketplaces = Boolean(req.body?.allMarketplaces)
    const marketplaceIds = Array.isArray(req.body?.marketplaceIds) ? req.body.marketplaceIds.map(Number) : []

    if (!name || name.length < 2) {
      return res.status(400).json({ error: "Please provide a valid user name (at least 2 characters)." })
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." })
    }
    if (!password || password.length < 10) {
      return res.status(400).json({ error: "Password must be at least 10 characters long." })
    }

    let role = "Scanner"
    if (roleInput.toLowerCase() === "admin") role = "Admin"
    else if (roleInput.toLowerCase() === "supervisor") role = "Supervisor"
    else if (roleInput.toLowerCase() === "scanner") role = "Scanner"
    else if (roleInput.toLowerCase() === "inward") role = "Inward"

    const existing = await getPool().query(
      "SELECT id FROM users WHERE lower(email) = $1 OR ($2::text IS NOT NULL AND lower(login_alias) = $2)",
      [email, alias],
    )
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "A user with this email or alias already exists." })
    }

    const initials = name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("")

    const passwordHash = await bcrypt.hash(password, 10)
    const client = await getPool().connect()
    try {
      await client.query("BEGIN")
      const insertUserRes = await client.query<{ id: number }>(
        `INSERT INTO users (initials, name, email, login_alias, password_hash, role, sidebar_label, has_all_marketplaces, status)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'Active')
         RETURNING id`,
        [initials, name, email, alias, passwordHash, role, allMarketplaces],
      )
      const newUserId = insertUserRes.rows[0].id

      if (!allMarketplaces && marketplaceIds.length > 0) {
        for (const mid of marketplaceIds) {
          await client.query(
            "INSERT INTO user_marketplaces (user_id, marketplace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [newUserId, mid],
          )
        }
      }

      await auditAdminChange((req as SessionRequest).user.id, "admin.create_user", String(newUserId), {
        name,
        email,
        role,
        allMarketplaces,
      })

      await client.query("COMMIT")

      const userRowRes = await getPool().query(`SELECT ${userSelect} FROM users u WHERE u.id = $1`, [newUserId])
      const row = userRowRes.rows[0]
      res.status(201).json({
        user: {
          id: row.id,
          initials: row.initials,
          name: row.name,
          email: row.email,
          role: row.role,
          marketplaces: row.assigned_marketplaces,
          scansToday: String(row.scans_today),
          status: row.status,
          lastActive: lastSignInLabel(row.last_session_at),
        },
      })
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  } catch (error) {
    next(error)
  }
})

app.patch("/api/admin/users/:id/status", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.id)
    const status = String(req.body?.status || "").trim()
    if (!["Active", "Disabled"].includes(status)) {
      return res.status(400).json({ error: "Status must be 'Active' or 'Disabled'." })
    }

    if (targetUserId === (req as SessionRequest).user.id && status === "Disabled") {
      return res.status(400).json({ error: "You cannot disable your own administrator account." })
    }

    await getPool().query("UPDATE users SET status = $1 WHERE id = $2", [status, targetUserId])

    if (status === "Disabled") {
      await revokeAllSessionsForUser(getPool(), targetUserId, (req as SessionRequest).user.id)
    }

    await auditAdminChange((req as SessionRequest).user.id, "admin.update_user_status", String(targetUserId), {
      status,
    })

    res.json({ ok: true, status })
  } catch (error) {
    next(error)
  }
})

app.post("/api/admin/users/:id/reset-password", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.id)
    const newPassword = String(req.body?.password || "")
    if (!newPassword || newPassword.length < 10) {
      return res.status(400).json({ error: "Password must be at least 10 characters long." })
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)
    await getPool().query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, targetUserId])

    await revokeAllSessionsForUser(getPool(), targetUserId, (req as SessionRequest).user.id)

    await auditAdminChange((req as SessionRequest).user.id, "admin.reset_user_password", String(targetUserId), {})

    res.json({ ok: true, message: "Password updated and all existing sessions revoked." })
  } catch (error) {
    next(error)
  }
})

app.patch("/api/admin/users/:id/role", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.id)
    const roleInput = String(req.body?.role || "").trim()
    const allMarketplaces = Boolean(req.body?.allMarketplaces)
    const marketplaceIds = Array.isArray(req.body?.marketplaceIds) ? req.body.marketplaceIds.map(Number) : []

    let role = "Scanner"
    if (roleInput.toLowerCase() === "admin") role = "Admin"
    else if (roleInput.toLowerCase() === "supervisor") role = "Supervisor"
    else if (roleInput.toLowerCase() === "scanner") role = "Scanner"
    else if (roleInput.toLowerCase() === "inward") role = "Inward"

    const client = await getPool().connect()
    try {
      await client.query("BEGIN")
      await client.query(
        "UPDATE users SET role = $1, sidebar_label = $1, has_all_marketplaces = $2 WHERE id = $3",
        [role, allMarketplaces, targetUserId],
      )

      await client.query("DELETE FROM user_marketplaces WHERE user_id = $1", [targetUserId])
      if (!allMarketplaces && marketplaceIds.length > 0) {
        for (const mid of marketplaceIds) {
          await client.query(
            "INSERT INTO user_marketplaces (user_id, marketplace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [targetUserId, mid],
          )
        }
      }

      await client.query("COMMIT")

      await auditAdminChange((req as SessionRequest).user.id, "admin.update_user_role", String(targetUserId), {
        role,
        allMarketplaces,
      })

      res.json({ ok: true, role, allMarketplaces })
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  } catch (error) {
    next(error)
  }
})

// Missing-item sub-issues. Each option belongs to an issue category. Removing one only deactivates it, so the scans
// that used it keep their label.
app.get("/api/admin/issue-options", requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const result = await getPool().query(
      `SELECT id, label, category_code AS "categoryCode", claim_amount::float8 AS "claimAmount"
       FROM missing_component_options
       WHERE active = true
       ORDER BY sort_order, id`,
    )
    res.json({ options: result.rows })
  } catch (error) {
    next(error)
  }
})

app.post("/api/admin/issue-options", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const label = String(req.body?.label || "").trim()
    const categoryCode = String(req.body?.categoryCode || "missing_component").trim()
    if (!label) return res.status(400).json({ error: "Enter an option name" })
    if (label.length > 60) return res.status(400).json({ error: "The option name must be 60 characters or fewer" })
    const category = await getPool().query(
      "SELECT 1 FROM receipt_issue_categories WHERE code = $1 AND active AND allows_sub_issue",
      [categoryCode],
    )
    if (!category.rows[0]) return res.status(400).json({ error: "Choose a category that takes sub-issues" })
    const result = await getPool().query(
      `INSERT INTO missing_component_options (label, active, sort_order, category_code)
       VALUES ($1, true, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM missing_component_options), $2)
       RETURNING id, label, category_code AS "categoryCode", claim_amount::float8 AS "claimAmount"`,
      [label, categoryCode],
    )
    const option = result.rows[0]
    await auditAdminChange(
      (req as SessionRequest).user.id,
      "sub_issue.add",
      String(option.id),
      { label, categoryCode },
    )
    res.json({ option })
  } catch (error) {
    next(error)
  }
})

app.patch("/api/admin/issue-options/:id/claim-amount", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const amount = Number(req.body?.claimAmount)
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "That option does not exist." })
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
      return res.status(400).json({ error: "Enter a claim amount from 0 to 1000000." })
    }
    const result = await getPool().query(
      `UPDATE missing_component_options
       SET claim_amount = $1
       WHERE id = $2 AND active
       RETURNING id, label, category_code AS "categoryCode", claim_amount::float8 AS "claimAmount"`,
      [amount, id],
    )
    if (!result.rows[0]) return res.status(404).json({ error: "That option does not exist." })
    await auditAdminChange((req as SessionRequest).user.id, "sub_issue.claim_amount", String(id), {
      label: String(result.rows[0].label),
      claimAmount: amount,
    })
    res.json({ option: result.rows[0] })
  } catch (error) {
    next(error)
  }
})

app.delete("/api/admin/issue-options/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "That option does not exist." })
    const result = await getPool().query(
      "UPDATE missing_component_options SET active = false WHERE id = $1 AND active RETURNING label",
      [id],
    )
    if (result.rows[0]) {
      await auditAdminChange((req as SessionRequest).user.id, "sub_issue.deactivate", String(id), {
        label: String(result.rows[0].label),
      })
    }
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.get("/api/admin/accounts", requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const result = await getPool().query(`
      SELECT
        m.id,
        m.name,
        m.code,
        (
          SELECT COUNT(*)::int
          FROM expected_returns er
          WHERE er.marketplace_id = m.id AND er.lookup_status = 'active'
        ) AS active_lookup_count,
        (
          SELECT b.uploaded_label
          FROM upload_batches b
          WHERE b.marketplace_id = m.id
          ORDER BY b.created_at DESC
          LIMIT 1
        ) AS last_upload_label,
        (
          SELECT b.status
          FROM upload_batches b
          WHERE b.marketplace_id = m.id
          ORDER BY b.created_at DESC
          LIMIT 1
        ) AS last_upload_status,
        (
          SELECT b.pending_row_count
          FROM upload_batches b
          WHERE b.marketplace_id = m.id
          ORDER BY b.created_at DESC
          LIMIT 1
        ) AS last_pending_count,
        (
          SELECT b.rejected_row_count
          FROM upload_batches b
          WHERE b.marketplace_id = m.id
          ORDER BY b.created_at DESC
          LIMIT 1
        ) AS last_rejected_count,
        (
          SELECT b.created_at
          FROM upload_batches b
          WHERE b.marketplace_id = m.id
          ORDER BY b.created_at DESC
          LIMIT 1
        ) AS last_upload_time
      FROM marketplaces m
      ORDER BY m.sort_order, m.id
    `)

    res.json({
      accounts: result.rows.map((row) => {
        const activeCount = Number(row.active_lookup_count || 0)
        const lastStatus = String(row.last_upload_status || "")
        const pendingCount = Number(row.last_pending_count || 0)
        const rejectedCount = Number(row.last_rejected_count || 0)
        const hasExceptions = pendingCount > 0 || rejectedCount > 0

        let statusText = "No return data uploaded"
        let tone: "neutral" | "success" | "warning" | "danger" = "neutral"

        if (activeCount > 0) {
          if (hasExceptions) {
            statusText = "Import needs attention"
            tone = "warning"
          } else {
            statusText = "Active lookup available"
            tone = "success"
          }
        } else if (lastStatus === "Failed") {
          statusText = "Last upload failed"
          tone = "danger"
        } else if (row.last_upload_label) {
          statusText = "No return data uploaded"
          tone = "neutral"
        }

        const lastSyncedText = row.last_upload_label
          ? `Last upload ${row.last_upload_label}`
          : "No return data uploaded"

        return {
          id: row.id,
          name: row.name,
          code: row.code,
          activeLookupCount: activeCount,
          lastSynced: lastSyncedText,
          status: statusText,
          tone,
          canManage: true,
        }
      }),
    })
  } catch (error) {
    next(error)
  }
})

// Active device session management (Admin only)
app.get("/api/admin/sessions", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const meta = (req as SessionRequest).sessionMetadata
    const sessions = await listActiveSessions(getPool(), undefined, meta?.tokenHash)
    res.json({ sessions })
  } catch (error) {
    next(error)
  }
})

app.post("/api/admin/sessions/:id/revoke", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const sessionId = Number(req.params.id)
    if (!Number.isInteger(sessionId) || sessionId < 1) {
      return res.status(400).json({ error: "Invalid session ID" })
    }
    const success = await revokeSessionById(getPool(), sessionId, (req as SessionRequest).user.id)
    res.json({ ok: success })
  } catch (error) {
    next(error)
  }
})

app.post("/api/admin/users/:id/revoke-sessions", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.id)
    if (!Number.isInteger(targetUserId) || targetUserId < 1) {
      return res.status(400).json({ error: "Invalid user ID" })
    }
    const count = await revokeAllSessionsForUser(getPool(), targetUserId, (req as SessionRequest).user.id)
    res.json({ ok: true, revokedCount: count })
  } catch (error) {
    next(error)
  }
})

app.get("/api/admin/settings/sessions", requireUser, requireAdmin, async (_req, res, next) => {
  try {
    res.json({ config: await getSessionConfig(getPool()) })
  } catch (error) {
    next(error)
  }
})

app.post("/api/admin/settings/sessions", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const updated = await updateSessionConfig(getPool(), req.body || {}, (req as SessionRequest).user.id)
    res.json({ config: updated })
  } catch (error) {
    next(error)
  }
})

// Resend Operational Email Reports Configuration & Testing
app.get("/api/admin/reports/config", requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const config = await getReportsConfig(getPool())
    const historyRes = await getPool().query(
      `SELECT id, report_type, period_key, period_start, period_end, recipients, status, sent_at, attempts, last_error, created_at
       FROM scheduled_report_runs
       ORDER BY created_at DESC
       LIMIT 10`,
    )
    res.json({
      config,
      history: historyRes.rows.map((r) => ({
        id: Number(r.id),
        type: r.report_type,
        periodKey: r.period_key,
        recipients: r.recipients,
        status: r.status,
        sentAt: r.sent_at ? lastSignInLabel(r.sent_at) : null,
        error: r.last_error,
        createdAt: lastSignInLabel(r.created_at),
      })),
    })
  } catch (error) {
    next(error)
  }
})

app.post("/api/admin/reports/config", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const updated = await updateReportsConfig(getPool(), req.body || {}, (req as SessionRequest).user.id)
    res.json({ config: updated })
  } catch (error) {
    next(error)
  }
})

app.post("/api/admin/reports/send-test", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const reportType = req.body?.reportType === "weekly" ? "weekly" : "daily"
    const targetEmail = String(req.body?.targetEmail || (req as SessionRequest).user.email).trim()
    const result = await sendTestReport(getPool(), targetEmail, reportType, (req as SessionRequest).user.id)
    res.json(result)
  } catch (error) {
    next(error)
  }
})

app.patch("/api/admin/users/:id/reports", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const userId = Number(req.params.id)
    const canReceive = Boolean(req.body?.canReceiveReports)
    await getPool().query("UPDATE users SET can_receive_reports = $1 WHERE id = $2", [canReceive, userId])
    await auditAdminChange((req as SessionRequest).user.id, "user.toggle_reports", String(userId), { canReceive })
    res.json({ ok: true, canReceiveReports: canReceive })
  } catch (error) {
    next(error)
  }
})

app.get("/api/admin/system", requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const dbRes = await getPool().query(`
      SELECT
        current_database() AS name,
        (SELECT COUNT(*)::int FROM receipt_scans) AS receipts,
        (SELECT COUNT(*)::int FROM user_sessions WHERE revoked_at IS NULL AND expires_at > now()) AS active_sessions,
        (SELECT COUNT(*)::int FROM product_master) AS product_master_rows
    `)
    const row = dbRes.rows[0]
    const reportConfig = await getReportsConfig(getPool())

    res.json({
      items: [
        {
          title: "PostgreSQL Database",
          detail: `Connected to ${row.name} · ${formatCount(Number(row.receipts))} permanent scanned returns`,
          status: "Connected",
          tone: "success",
        },
        {
          title: "Product Catalog Master",
          detail: `${formatCount(Number(row.product_master_rows))} mapping rows active in database`,
          status: Number(row.product_master_rows) > 0 ? "Active" : "Empty",
          tone: Number(row.product_master_rows) > 0 ? "success" : "neutral",
        },
        {
          title: "Active Device Sessions",
          detail: `${formatCount(Number(row.active_sessions || 0))} warehouse & admin devices currently active`,
          status: "Secure",
          tone: "success",
        },
        {
          title: "Resend Email Reporting",
          detail: `Sender: ${reportConfig.sender} · Daily at ${reportConfig.dailyTime} IST · Weekly Mon at ${reportConfig.weeklyTime} IST`,
          status: reportConfig.dailyEnabled || reportConfig.weeklyEnabled ? "Scheduled" : "Disabled",
          tone: reportConfig.dailyEnabled || reportConfig.weeklyEnabled ? "success" : "neutral",
        },
        {
          title: "OMSGuru Daily Inventory Updates",
          detail: `Daily at ${(await getOmsguruConfig(getPool())).dailyTime} IST · Warehouse: ${(await getOmsguruConfig(getPool())).dropshipWarehouseId} · Firebase: ${isFirebaseConfigured() ? "Connected" : "Offline"}`,
          status: (await getOmsguruConfig(getPool())).dailyEnabled ? "Active" : "Disabled",
          tone: (await getOmsguruConfig(getPool())).dailyEnabled ? "success" : "neutral",
        },
        {
          title: "Sales & Payment Database (PAYMENT_DATABASE_URL)",
          detail: Boolean(paymentDatabaseUrl()) ? "Connected · Scheduled daily at 04:30 AM IST (twice-weekly check)" : "Not configured in .env",
          status: Boolean(paymentDatabaseUrl()) ? "Active" : "Disabled",
          tone: Boolean(paymentDatabaseUrl()) ? "success" : "neutral",
        },
      ],
    })
  } catch (error) {
    next(error)
  }
})

const publicDir = path.join(root, "public")
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { maxAge: "1h", etag: true }))
}

const dist = path.join(root, "dist")
if (fs.existsSync(dist)) {
  const assetsDir = path.join(dist, "assets")
  if (fs.existsSync(assetsDir)) {
    app.use(
      "/assets",
      express.static(assetsDir, {
        maxAge: "1y",
        immutable: true,
      }),
    )
  }
  app.use(
    express.static(dist, {
      maxAge: "1h",
      etag: true,
    }),
  )
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next()
    res.setHeader("Cache-Control", "no-cache")
    res.sendFile(path.join(dist, "index.html"))
  })
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File is larger than 25 MB" })
  }
  console.error(error)
  const isProd = process.env.NODE_ENV === "production"
  const message = isProd
    ? "An internal server error occurred. Please try again or contact an administrator."
    : error instanceof Error ? error.message : "Something went wrong. Try again."
  res.status(500).json({ error: message })
})

let schedulerInterval: NodeJS.Timeout | null = null
let shopifySyncInterval: NodeJS.Timeout | null = null
const port = Number(process.env.PORT || 3001)
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Return API listening on http://0.0.0.0:${port}`)
})

initDatabase()
  .then((result) => {
    ready = result.ok
    dbMessage = result.message
    console.log(result.ok ? "PostgreSQL connected. Workspace data is ready." : result.message)
    if (result.ok) {
      // Live updates over WebSocket (/api/live). Clients that cannot connect poll /api/sync/state instead.
      attachLiveServer(server, getPool(), authenticateUpgrade)

      // Background worker for idempotent Resend email reports, OMSGuru daily updates, and payment sync (checked every 60s)
      schedulerInterval = setInterval(() => {
        runScheduledReports(getPool()).catch((err) => console.error("[Report Scheduler Error]", err))
        runScheduledOmsguruUpdate(getPool()).catch((err) => console.error("[OMSGuru Scheduler Error]", err))
        runScheduledPaymentSync(getPool()).catch((err) => console.error("[Payment Sync Scheduler Error]", err))
      }, 60_000)

      // Background worker for real-time Shopify return & RTO ingestion (every 5 min)
      if (process.env.SHOPIFY_DATABASE_URL?.trim()) {
        syncShopifyReturns(getPool()).catch((err) =>
          console.error("[Shopify Initial Sync Error]", err instanceof Error ? err.message : err),
        )
        shopifySyncInterval = setInterval(() => {
          syncShopifyReturns(getPool()).catch((err) =>
            console.error("[Shopify Sync Error]", err instanceof Error ? err.message : err),
          )
        }, 300_000)
      }
    }
  })
  .catch((error: unknown) => {
    ready = false
    dbMessage = error instanceof Error ? error.message : "Database connection failed"
    console.error("PostgreSQL connection failed:", dbMessage)
  })

function handleGracefulShutdown(signal: string) {
  console.log(`Received ${signal}. Gracefully stopping server and closing resources...`)
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
  if (shopifySyncInterval) {
    clearInterval(shopifySyncInterval)
    shopifySyncInterval = null
  }
  closeLiveServer()
  server.close(() => {
    console.log("HTTP server closed.")
    closePaymentPool().catch((err) => console.error("Error closing payment pool:", err))
    getPool()
      .end()
      .then(() => {
        console.log("PostgreSQL pool drained cleanly. Exiting.")
        process.exit(0)
      })
      .catch((err) => {
        console.error("Error draining database pool:", err)
        process.exit(1)
      })
  })
}

process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"))
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"))

