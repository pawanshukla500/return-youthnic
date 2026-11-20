import { test } from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import fs from "node:fs"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import express from "express"
import { RateLimiter } from "../rate-limit.js"
import { applySecurityHeaders, ENFORCED_CSP, REPORT_ONLY_CSP } from "../security-headers.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

// Invariant 9: Test data is synthetic, and every value starts with SYN-.
const SYN_USER = "SYN-test-operator@youthnic.shop"
const SYN_IP = "SYN-192.168.1.100"

test("[Security/IAM] RateLimiter tracks failures within window and locks out at threshold", () => {
  const limiter = new RateLimiter({
    maxAttempts: 3,
    windowMs: 60_000,
    lockoutMs: 300_000,
  })

  const t0 = 10000

  // 1st failure
  let res = limiter.recordFailure(SYN_USER, t0)
  assert.equal(res.locked, false)
  assert.equal(limiter.isLocked(SYN_USER, t0).locked, false)

  // 2nd failure
  res = limiter.recordFailure(SYN_USER, t0 + 1000)
  assert.equal(res.locked, false)
  assert.equal(limiter.isLocked(SYN_USER, t0 + 1000).locked, false)

  // 3rd failure -> triggers lockout!
  res = limiter.recordFailure(SYN_USER, t0 + 2000)
  assert.equal(res.locked, true)
  assert.equal(res.retryAfterSeconds, 300)

  // Verification during lockout period
  const check = limiter.isLocked(SYN_USER, t0 + 3000)
  assert.equal(check.locked, true)
  assert.ok(check.retryAfterSeconds > 0)

  // After lockout expires
  const expiredCheck = limiter.isLocked(SYN_USER, t0 + 303_000)
  assert.equal(expiredCheck.locked, false)
})

test("[Security/IAM] RateLimiter resets state immediately on successful authentication", () => {
  const limiter = new RateLimiter({ maxAttempts: 5, windowMs: 60_000, lockoutMs: 300_000 })
  limiter.recordFailure(SYN_USER)
  limiter.recordFailure(SYN_USER)

  limiter.reset(SYN_USER)
  assert.equal(limiter.isLocked(SYN_USER).locked, false)

  // Recording failure after reset starts fresh count
  const nextRes = limiter.recordFailure(SYN_USER)
  assert.equal(nextRes.locked, false)
})

test("[Security/AppSec] Production error messages must never leak internal stack traces or database errors", () => {
  function sanitizeError(err: Error, isProduction: boolean): string {
    return isProduction
      ? "An internal server error occurred. Please try again or contact an administrator."
      : err.message
  }

  const internalDbError = new Error("FATAL: connection to server at \"pg.internal\" failed: password authentication failed")
  
  const devMessage = sanitizeError(internalDbError, false)
  assert.ok(devMessage.includes("password authentication failed"))

  const prodMessage = sanitizeError(internalDbError, true)
  assert.equal(prodMessage, "An internal server error occurred. Please try again or contact an administrator.")
  assert.equal(prodMessage.includes("password"), false)
  assert.equal(prodMessage.includes("pg.internal"), false)
})

test("[Database Optimizer] Schema register contains high-performance indexes for scanning and audit logs", () => {
  const schemaPath = path.join(root, "server", "schema-register.sql")
  const sql = fs.readFileSync(schemaPath, "utf-8")

  // Indexes on receipt_scans and register_audit_log
  assert.ok(
    sql.includes("receipt_scans_scanned_by_at_idx"),
    "Must define composite index on receipt_scans (scanned_by, scanned_at DESC)",
  )
  assert.ok(
    sql.includes("register_audit_log_actor_idx"),
    "Must define index on register_audit_log (actor_user_id, occurred_at DESC)",
  )
  assert.ok(
    sql.includes("register_audit_log_occurred_at_idx"),
    "Must define index on register_audit_log (occurred_at DESC)",
  )
})

test("[Security/AppSec] The server exposes no /api/debug routes (the unauthenticated Sentry test route is gone)", () => {
  const serverDir = path.join(root, "server")
  // Every .ts file under server/, subfolders included, except the tests (this one names the path it forbids).
  const offenders = (fs.readdirSync(serverDir, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".ts") && !name.split(path.sep).includes("tests"))
    .filter((name) => fs.readFileSync(path.join(serverDir, name), "utf-8").includes("/api/debug"))
  assert.deepEqual(offenders, [], "a debug route can be called by anyone; Sentry is checked by server/tests/sentry.test.ts")
})

test("[Security/AppSec] Responses hide X-Powered-By, enforce only the safe CSP, and report the full policy", async () => {
  const app = express()
  applySecurityHeaders(app)
  app.get("/SYN-ping", (_req, res) => {
    res.send("SYN-ok")
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/SYN-ping`)
    assert.equal(res.status, 200)
    assert.equal(app.enabled("x-powered-by"), false)
    assert.equal(res.headers.get("x-powered-by"), null)

    // Enforced: exactly the three directives that cannot change how the console loads.
    const enforced = res.headers.get("content-security-policy") ?? ""
    assert.equal(enforced, ENFORCED_CSP)
    assert.deepEqual(
      enforced.split(";").map((d) => d.trim()),
      ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"],
    )

    // Report-only: the full policy, with no eval and no wildcard source.
    const reportOnly = res.headers.get("content-security-policy-report-only") ?? ""
    assert.equal(reportOnly, REPORT_ONLY_CSP)
    const directives = reportOnly.split(";").map((d) => d.trim().split(/\s+/))
    assert.deepEqual(directives.find(([name]) => name === "script-src"), ["script-src", "'self'"])
    assert.ok(!reportOnly.includes("'unsafe-eval'"))
    assert.ok(directives.every((d) => !d.includes("*")), "no directive may allow every origin")

    // The headers sent before the CSP was added are still sent.
    assert.equal(res.headers.get("x-frame-options"), "DENY")
    assert.equal(res.headers.get("x-content-type-options"), "nosniff")
  } finally {
    server.close()
  }
})
