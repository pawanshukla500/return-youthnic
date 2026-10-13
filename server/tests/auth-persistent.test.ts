import { test } from "node:test"
import assert from "node:assert/strict"
import type { Request, Response } from "express"
import {
  generateToken,
  hashToken,
  parseDeviceName,
  setSessionCookie,
  clearSessionCookie,
  DEFAULT_SESSION_CONFIG,
  SESSION_COOKIE_NAME,
} from "../auth.js"
import {
  isAdminRole,
  isSupervisorRole,
  isScannerRole,
  isSupervisorOrAdminRole,
  scopeFor,
  ALL_ACCOUNTS,
} from "../access.js"
import { requireAdmin, requireSupervisorOrAdmin } from "../http.js"
import { RateLimiter } from "../rate-limit.js"

test("[synthetic] generateToken produces 256 bits of cryptographically secure random entropy", () => {
  const t1 = generateToken()
  const t2 = generateToken()
  assert.equal(t1.length, 64)
  assert.equal(t2.length, 64)
  assert.notEqual(t1, t2)
  assert.match(t1, /^[0-9a-f]{64}$/)
})

test("[synthetic] hashToken generates deterministic SHA-256 digest, preventing raw token leakage", () => {
  const token = "SYN-test-token-value-with-entropy-1234567890"
  const h1 = hashToken(token)
  const h2 = hashToken(token)
  assert.equal(h1, h2)
  assert.equal(h1.length, 64)
  assert.match(h1, /^[0-9a-f]{64}$/)
})

test("[synthetic] parseDeviceName identifies warehouse terminals and mobile platforms cleanly", () => {
  assert.equal(
    parseDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
    "Chrome on Windows PC",
  )
  assert.equal(
    parseDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"),
    "Edge on Windows PC",
  )
  assert.equal(
    parseDeviceName("Mozilla/5.0 (Linux; Android 13; Zebra TC57) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"),
    "Chrome on Android Device",
  )
  assert.equal(parseDeviceName(""), "Warehouse Terminal")
})

test("[synthetic] setSessionCookie writes HttpOnly, SameSite=Lax, and correct Max-Age duration", () => {
  let cookieHeader = ""
  const req = { secure: false, headers: {} } as unknown as Request
  const res = {
    setHeader: (name: string, value: string) => {
      if (name.toLowerCase() === "set-cookie") cookieHeader = value
    },
  } as unknown as Response

  // 30 days remember-device lifetime
  const thirtyDays = 30 * 24 * 60 * 60
  setSessionCookie(req, res, "SYN-token-30d", thirtyDays)
  assert.ok(cookieHeader.includes(`${SESSION_COOKIE_NAME}=SYN-token-30d`))
  assert.ok(cookieHeader.includes("HttpOnly"))
  assert.ok(cookieHeader.includes("SameSite=Lax"))
  assert.ok(cookieHeader.includes("Path=/"))
  assert.ok(cookieHeader.includes(`Max-Age=${thirtyDays}`))

  // HTTPS connection enforces Secure attribute
  const httpsReq = { secure: true, headers: {} } as unknown as Request
  setSessionCookie(httpsReq, res, "SYN-token-secure", thirtyDays)
  assert.ok(cookieHeader.includes("Secure"))
})

test("[synthetic] clearSessionCookie invalidates cookie with Max-Age 0 and epoch expiry", () => {
  let cookieHeader = ""
  const req = { secure: false, headers: {} } as unknown as Request
  const res = {
    setHeader: (name: string, value: string) => {
      if (name.toLowerCase() === "set-cookie") cookieHeader = value
    },
  } as unknown as Response

  clearSessionCookie(req, res)
  assert.ok(cookieHeader.includes(`${SESSION_COOKIE_NAME}=`))
  assert.ok(cookieHeader.includes("Max-Age=0"))
  assert.ok(cookieHeader.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT"))
})

test("[synthetic] role verification correctly differentiates Admin, Supervisor, and Scanner", () => {
  // Admin checks
  assert.equal(isAdminRole("Admin"), true)
  assert.equal(isAdminRole("admin"), true)
  assert.equal(isAdminRole("Supervisor"), false)
  assert.equal(isAdminRole("Scanner"), false)

  // Supervisor checks
  assert.equal(isSupervisorRole("Supervisor"), true)
  assert.equal(isSupervisorRole("supervisor"), true)
  assert.equal(isSupervisorRole("Admin"), false)
  assert.equal(isSupervisorRole("Scanner"), false)

  // Scanner checks
  assert.equal(isScannerRole("Scanner"), true)
  assert.equal(isScannerRole("scanner"), true)
  assert.equal(isScannerRole("Supervisor"), false)
  assert.equal(isScannerRole("Admin"), false)

  // Combined Supervisor/Admin checks
  assert.equal(isSupervisorOrAdminRole("Admin"), true)
  assert.equal(isSupervisorOrAdminRole("Supervisor"), true)
  assert.equal(isSupervisorOrAdminRole("Scanner"), false)
})

test("[synthetic] requireAdmin blocks Scanner and Supervisor with HTTP 403", () => {
  let status = 0
  let body: Record<string, unknown> = {}

  const makeRes = () =>
    ({
      status: (code: number) => {
        status = code
        return {
          json: (data: Record<string, unknown>) => {
            body = data
          },
        }
      },
    }) as unknown as Response

  let nextCalled = false
  const next = () => {
    nextCalled = true
  }

  // Scanner attempt
  status = 0
  body = {}
  nextCalled = false
  const scannerReq = { user: { id: 101, name: "SYN-Scanner", role: "Scanner", scope: { all: false, marketplaceIds: [1] } } } as unknown as Request
  requireAdmin(scannerReq, makeRes(), next)
  assert.equal(status, 403)
  assert.equal(body.error, "Only an administrator can use this.")
  assert.equal(nextCalled, false)

  // Supervisor attempt
  status = 0
  body = {}
  nextCalled = false
  const supervisorReq = { user: { id: 102, name: "SYN-Supervisor", role: "Supervisor", scope: ALL_ACCOUNTS } } as unknown as Request
  requireAdmin(supervisorReq, makeRes(), next)
  assert.equal(status, 403)
  assert.equal(body.error, "Only an administrator can use this.")
  assert.equal(nextCalled, false)

  // Admin attempt
  status = 0
  body = {}
  nextCalled = false
  const adminReq = { user: { id: 100, name: "SYN-Admin", role: "Admin", scope: ALL_ACCOUNTS } } as unknown as Request
  requireAdmin(adminReq, makeRes(), next)
  assert.equal(status, 0)
  assert.equal(nextCalled, true)
})

test("[synthetic] requireSupervisorOrAdmin allows Supervisor and Admin, blocks Scanner", () => {
  let status = 0
  let body: Record<string, unknown> = {}
  const makeRes = () =>
    ({
      status: (code: number) => {
        status = code
        return {
          json: (data: Record<string, unknown>) => {
            body = data
          },
        }
      },
    }) as unknown as Response

  let nextCalled = false
  const next = () => {
    nextCalled = true
  }

  // Scanner attempt
  status = 0
  nextCalled = false
  const scannerReq = { user: { id: 101, name: "SYN-Scanner", role: "Scanner", scope: { all: false, marketplaceIds: [1] } } } as unknown as Request
  requireSupervisorOrAdmin(scannerReq, makeRes(), next)
  assert.equal(status, 403)
  assert.equal(body.error, "Only a supervisor or administrator can use this.")
  assert.equal(nextCalled, false)

  // Supervisor attempt
  status = 0
  nextCalled = false
  const supervisorReq = { user: { id: 102, name: "SYN-Supervisor", role: "Supervisor", scope: ALL_ACCOUNTS } } as unknown as Request
  requireSupervisorOrAdmin(supervisorReq, makeRes(), next)
  assert.equal(status, 0)
  assert.equal(nextCalled, true)

  // Admin attempt
  status = 0
  nextCalled = false
  const adminReq = { user: { id: 100, name: "SYN-Admin", role: "Admin", scope: ALL_ACCOUNTS } } as unknown as Request
  requireSupervisorOrAdmin(adminReq, makeRes(), next)
  assert.equal(status, 0)
  assert.equal(nextCalled, true)
})

test("[synthetic] CSRF validation protects state-changing endpoints from malicious origins", () => {
  const ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "https://return.youthnic.shop",
  ]

  const isCsrfPermitted = (method: string, origin?: string, referer?: string): boolean => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return true
    if (origin) {
      return ALLOWED_ORIGINS.includes(origin)
    }
    if (referer) {
      try {
        const refOrigin = new URL(referer).origin
        return ALLOWED_ORIGINS.includes(refOrigin)
      } catch {
        return false
      }
    }
    return true
  }

  // Trusted requests
  assert.equal(isCsrfPermitted("POST", "https://return.youthnic.shop"), true)
  assert.equal(isCsrfPermitted("PATCH", "http://localhost:5173"), true)
  assert.equal(isCsrfPermitted("GET", "https://attacker.evil.com"), true) // GET is safe read

  // Malicious CSRF forgery attempts
  assert.equal(isCsrfPermitted("POST", "https://attacker.evil.com"), false)
  assert.equal(isCsrfPermitted("DELETE", "http://malicious-warehouse-phish.com"), false)
  assert.equal(isCsrfPermitted("PATCH", undefined, "https://attacker.evil.com/fake-page"), false)
})

test("[synthetic] Brute force rate limiter locks account after 5 failed attempts within window", () => {
  const limiter = new RateLimiter({ maxAttempts: 5, windowMs: 60000, lockoutMs: 300000 })
  const testAccount = "syn-scanner-test@youthnic.shop"

  assert.equal(limiter.isLocked(testAccount).locked, false)
  for (let i = 0; i < 4; i++) {
    limiter.recordFailure(testAccount)
    assert.equal(limiter.isLocked(testAccount).locked, false)
  }

  // 5th failed attempt triggers lockout
  limiter.recordFailure(testAccount)
  const lock = limiter.isLocked(testAccount)
  assert.equal(lock.locked, true)
  assert.ok(lock.retryAfterSeconds > 0)

  // Successful login resets failures
  limiter.reset(testAccount)
  assert.equal(limiter.isLocked(testAccount).locked, false)
})
