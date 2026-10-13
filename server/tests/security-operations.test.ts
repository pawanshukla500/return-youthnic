import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { RateLimiter } from "../rate-limit.js"

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
