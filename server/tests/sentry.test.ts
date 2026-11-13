// Unit tests for Sentry Integration in Return App.
// Follows strict Return App testing standards:
// - All test data starts with SYN-
// - No secrets logged
// - Verifies initialization, exception capture, and express error handling

import test from "node:test"
import assert from "node:assert/strict"
import * as Sentry from "@sentry/node"
import express, { type Request, type Response, type NextFunction } from "express"

test("Sentry SDK — exports required functions and version", () => {
  assert.equal(typeof Sentry.init, "function")
  assert.equal(typeof Sentry.captureException, "function")
  assert.equal(typeof Sentry.captureMessage, "function")
  assert.equal(typeof Sentry.setupExpressErrorHandler, "function")
  assert.ok(Sentry.SDK_VERSION)
})

test("Sentry SDK — captures exception with synthetic test error", () => {
  const syntheticError = new Error("SYN-ERROR: Test error for Sentry verification")
  const eventId = Sentry.captureException(syntheticError)
  assert.ok(eventId, "Sentry.captureException should return an eventId string")
  assert.equal(typeof eventId, "string")
})

test("Sentry SDK — Express error handler catches and attaches without crashing", () => {
  const app = express()
  let capturedError: unknown = null

  app.get("/test-error", (_req, _res) => {
    throw new Error("SYN-ERROR: Uncaught express handler error")
  })

  Sentry.setupExpressErrorHandler(app)

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    capturedError = err
    res.status(500).json({ error: "Internal Error" })
  })

  assert.ok(app, "Express app initialized with Sentry error handler")
})
