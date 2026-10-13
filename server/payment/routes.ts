import type { Express, RequestHandler } from "express"
import { getPool } from "../db.js"
import { requireAdmin, sendError } from "../http.js"
import { getPaymentSyncStatus, syncPaymentAmounts } from "./sync.js"
import { testPaymentConnection } from "./db.js"

export function mountPaymentRoutes(app: Express, requireUser: RequestHandler): void {
  /**
   * GET /api/payment/status
   * Returns current sync status, pending scans count, and last run summary.
   */
  app.get("/api/payment/status", requireUser, async (_req, res, next) => {
    try {
      const db = getPool()
      const status = await getPaymentSyncStatus(db)
      res.json({ ok: true, ...status })
    } catch (err: unknown) {
      sendError(res, err, next)
    }
  })

  /**
   * GET /api/payment/test
   * Tests connectivity to the external Payment/Sales Database (Admin only).
   */
  app.get("/api/payment/test", requireUser, requireAdmin, async (_req, res, next) => {
    try {
      const result = await testPaymentConnection()
      res.json(result)
    } catch (err: unknown) {
      sendError(res, err, next)
    }
  })

  /**
   * GET /api/payment/runs
   * Returns recent sync run records for audit and diagnostics.
   */
  app.get("/api/payment/runs", requireUser, async (_req, res, next) => {
    try {
      const db = getPool()
      const runs = await db.query(
        `SELECT id, started_at, completed_at, status, trigger_type, scans_checked, scans_matched, scans_updated, total_amount_synced, error_message, summary
         FROM payment_sync_runs
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      res.json({
        ok: true,
        runs: runs.rows.map((r) => ({
          id: Number(r.id),
          startedAt: new Date(r.started_at).toISOString(),
          completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
          status: r.status,
          triggerType: r.trigger_type,
          checked: Number(r.scans_checked),
          matched: Number(r.scans_matched),
          updated: Number(r.scans_updated),
          totalAmount: Number(r.total_amount_synced || 0),
          errorMessage: r.error_message,
          summary: r.summary,
        })),
      })
    } catch (err: unknown) {
      sendError(res, err, next)
    }
  })

  /**
   * POST /api/payment/sync
   * Triggers an immediate manual payment amount sync (Admin only).
   */
  app.post("/api/payment/sync", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const db = getPool()
      const forceAll = req.body?.forceAll === true
      const result = await syncPaymentAmounts(db, { forceAll, trigger: "manual" })
      res.json({ ok: result.ran && result.status === "success", ...result })
    } catch (err: unknown) {
      sendError(res, err, next)
    }
  })
}
