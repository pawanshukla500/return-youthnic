// Express routes for Return Reason Standardization & Garment Sizing Intelligence.
// Adheres strictly to project invariants:
// - Rule 1: Account scope applied to every data query.
// - Rule 2: requireAdmin on configuration and trigger mutations.
// - Rule 8: Zero secrets exposed.

import type { Application, Request, Response, RequestHandler } from "express"
import { getPool } from "./db.js"
import { requireAdmin } from "./http.js"
import {
  getWeeklyReasonSummary,
  getTopSellerFaultSKUs,
  getGarmentSizeDigest,
  syncCanonicalReturnReasons,
} from "./return-reasons.js"
import { sendWeeklyReasonsReport } from "./return-reasons-report.js"

type SessionUser = {
  id: number
  role: string
  scope: import("./access.js").AccountScope
}

type SessionRequest = Request & {
  user: SessionUser
}

function parseDateParam(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined
  const trimmed = val.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined
}

export function mountReturnReasonsRoutes(app: Application, requireUser: RequestHandler): void {
  const pool = getPool()

  // 1. Return reasons overview: metrics, canonical categories, marketplace breakdown
  app.get("/api/reports/return-reasons/overview", requireUser, async (req: Request, res: Response) => {
    try {
      const scope = (req as SessionRequest).user.scope
      const dateFrom = parseDateParam(req.query.dateFrom)
      const dateTo = parseDateParam(req.query.dateTo)

      const summary = await getWeeklyReasonSummary(pool, scope, dateFrom, dateTo)
      res.json({ ok: true, summary })
    } catch (err: unknown) {
      console.error("[ReturnReasons API] Failed to fetch overview:", err)
      res.status(500).json({ error: "Failed to load return reason overview" })
    }
  })

  // 2. Seller fault deep-dive: top SKUs where mistake happened from our side
  app.get("/api/reports/return-reasons/seller-faults", requireUser, async (req: Request, res: Response) => {
    try {
      const scope = (req as SessionRequest).user.scope
      const dateFrom = parseDateParam(req.query.dateFrom)
      const dateTo = parseDateParam(req.query.dateTo)
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100)

      const skus = await getTopSellerFaultSKUs(pool, scope, dateFrom, dateTo, limit)
      res.json({ ok: true, skus })
    } catch (err: unknown) {
      console.error("[ReturnReasons API] Failed to fetch seller fault SKUs:", err)
      res.status(500).json({ error: "Failed to load seller fault analysis" })
    }
  })

  // 3. Garment sizing intelligence digest: which size has this issue?
  app.get("/api/reports/return-reasons/size-digest", requireUser, async (req: Request, res: Response) => {
    try {
      const scope = (req as SessionRequest).user.scope
      const dateFrom = parseDateParam(req.query.dateFrom)
      const dateTo = parseDateParam(req.query.dateTo)
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 25), 100)

      const sizeDigest = await getGarmentSizeDigest(pool, scope, dateFrom, dateTo, limit)
      res.json({ ok: true, sizeDigest })
    } catch (err: unknown) {
      console.error("[ReturnReasons API] Failed to fetch size digest:", err)
      res.status(500).json({ error: "Failed to load garment sizing digest" })
    }
  })

  // 4. Centralized raw marketplace mappings dictionary
  app.get("/api/reports/return-reasons/mappings", requireUser, async (_req: Request, res: Response) => {
    try {
      const query = `
        SELECT
          mrm.id,
          mrm.marketplace,
          mrm.raw_reason,
          mrm.canonical_code,
          crr.label AS canonical_label,
          crr.department,
          crr.is_seller_fault,
          crr.is_size_issue,
          crr.severity,
          crr.action_recommendation
        FROM marketplace_reason_mappings mrm
        JOIN canonical_return_reasons crr ON crr.category_code = mrm.canonical_code
        ORDER BY mrm.marketplace, mrm.raw_reason
      `
      const result = await pool.query(query)
      res.json({ ok: true, mappings: result.rows })
    } catch (err: unknown) {
      console.error("[ReturnReasons API] Failed to fetch mappings:", err)
      res.status(500).json({ error: "Failed to load return reason mappings" })
    }
  })

  // 5. Admin backfill & sync trigger
  app.post("/api/reports/return-reasons/sync", requireUser, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await syncCanonicalReturnReasons(pool)
      res.json({ ok: true, ...result })
    } catch (err: unknown) {
      console.error("[ReturnReasons API] Failed to sync return reasons:", err)
      res.status(500).json({ error: "Failed to sync return reasons" })
    }
  })

  // 6. Admin on-demand weekly email digest sender
  app.post("/api/reports/return-reasons/send-digest", requireUser, requireAdmin, async (req: Request, res: Response) => {
    try {
      const sessionReq = req as SessionRequest
      const recipients = Array.isArray(req.body?.recipients)
        ? req.body.recipients.map((e: unknown) => String(e).trim()).filter(Boolean)
        : undefined

      const result = await sendWeeklyReasonsReport(pool, recipients, sessionReq.user.id)
      res.json({ ok: true, ...result })
    } catch (err: unknown) {
      console.error("[ReturnReasons API] Failed to send weekly digest email:", err)
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to send weekly email digest" })
    }
  })
}
