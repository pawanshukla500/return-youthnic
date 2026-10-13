// Express API routes for OMSGuru Daily Inventory Updates & Firebase Storage integration.
// Follows strict Return App invariants:
// - All data read/written respects authenticated user sessions
// - Configuration mutation strictly requires Admin role
// - Full audit logging for manual generation, config updates, and email dispatches

import type { Express, Request, Response, NextFunction } from "express"
import type pg from "pg"
import { getPool } from "./db.js"
import { requireAdmin } from "./http.js"
import {
  getOmsguruConfig,
  updateOmsguruConfig,
  generateOmsguruDailyUpdate,
  sendOmsguruDailyEmail,
  calculateGoodReturnsForDay,
  pruneOldOmsguruFiles,
  type SkuUpdateItem,
} from "./omsguru-daily.js"
import { isFirebaseConfigured } from "./firebase-storage.js"
import { getIstDateParts } from "./email-reports.js"

type SessionRequest = Request & {
  user: {
    id: number
    role: string
    name: string
    email: string
  }
}

export function mountOmsguruRoutes(
  app: Express,
  requireUser: (req: Request, res: Response, next: NextFunction) => void,
) {
  // GET /api/omsguru/config - Fetch current OMSGuru automation configuration
  app.get("/api/omsguru/config", requireUser, async (_req, res, next) => {
    try {
      const db = getPool()
      const config = await getOmsguruConfig(db)
      res.json({
        config,
        firebaseConfigured: isFirebaseConfigured(),
        currentTimeIst: getIstDateParts().timeStr,
        currentDateIst: getIstDateParts().dateStr,
      })
    } catch (error) {
      next(error)
    }
  })

  // POST /api/omsguru/config - Update OMSGuru automation settings (Admin only)
  app.post("/api/omsguru/config", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const db = getPool()
      const actorUserId = (req as SessionRequest).user.id
      const updated = await updateOmsguruConfig(db, req.body || {}, actorUserId)
      res.json({ config: updated, ok: true })
    } catch (error) {
      next(error)
    }
  })

  // GET /api/omsguru/today-preview - Real-time preview of good return items received today
  app.get("/api/omsguru/today-preview", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const dateStr = typeof req.query.date === "string" && req.query.date.trim()
        ? req.query.date.trim()
        : getIstDateParts().dateStr
      const preview = await calculateGoodReturnsForDay(db, dateStr)
      res.json({
        date: dateStr,
        ...preview,
      })
    } catch (error) {
      next(error)
    }
  })

  // GET /api/omsguru/daily - Paginated history of generated OMSGuru inventory updates
  app.get("/api/omsguru/daily", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "20"), 10) || 20))
      const offset = (page - 1) * pageSize

      const dateFilter = typeof req.query.date === "string" ? req.query.date.trim() : ""
      const search = typeof req.query.search === "string" ? req.query.search.trim() : ""

      const whereClauses: string[] = []
      const params: any[] = []

      if (dateFilter) {
        params.push(dateFilter)
        whereClauses.push(`update_date = $${params.length}`)
      }

      if (search) {
        params.push(`%${search}%`)
        whereClauses.push(`(request_id ILIKE $${params.length} OR file_name ILIKE $${params.length})`)
      }

      const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : ""

      // Count total matching records
      const countRes = await db.query(`SELECT COUNT(*)::int AS count FROM omsguru_daily_inventory_updates ${whereSql}`, params)
      const totalCount = countRes.rows[0]?.count || 0

      // Fetch paginated rows
      const limitParam = params.length + 1
      const offsetParam = params.length + 2
      const queryParams = [...params, pageSize, offset]

      const rowsRes = await db.query(
        `SELECT
           id,
           request_id,
           update_date,
           dropship_warehouse_id,
           total_skus,
           total_qty,
           file_name,
           storage_path,
           storage_url,
           email_sent,
           email_sent_at,
           email_recipients,
           email_cc,
           generated_by,
           created_at
         FROM omsguru_daily_inventory_updates
         ${whereSql}
         ORDER BY update_date DESC, created_at DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        queryParams,
      )

      // Summary stats
      const istDate = getIstDateParts().dateStr
      const todayPreview = await calculateGoodReturnsForDay(db, istDate).catch(() => ({ totalSkus: 0, totalQty: 0, skus: [] }))
      const config = await getOmsguruConfig(db)

      res.json({
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
        updates: rowsRes.rows.map((r) => ({
          id: Number(r.id),
          requestId: String(r.request_id),
          updateDate: String(r.update_date).slice(0, 10),
          dropshipWarehouseId: String(r.dropship_warehouse_id),
          totalSkus: Number(r.total_skus),
          totalQty: Number(r.total_qty),
          fileName: String(r.file_name),
          storagePath: String(r.storage_path),
          storageUrl: String(r.storage_url),
          emailSent: Boolean(r.email_sent),
          emailSentAt: r.email_sent_at ? new Date(r.email_sent_at).toISOString() : null,
          emailRecipients: r.email_recipients || [],
          emailCc: r.email_cc || [],
          generatedBy: r.generated_by ? Number(r.generated_by) : null,
          createdAt: new Date(r.created_at).toISOString(),
        })),
        summary: {
          todayDate: istDate,
          todayPendingUnits: todayPreview.totalQty,
          todayPendingSkus: todayPreview.totalSkus,
          scheduledTime: config.dailyTime,
          scheduledEnabled: config.dailyEnabled,
          warehouseId: config.dropshipWarehouseId,
          firebaseActive: isFirebaseConfigured(),
        },
      })
    } catch (error) {
      next(error)
    }
  })

  // GET /api/omsguru/daily/:id - Full details of a single generated update including SKU breakdown
  app.get("/api/omsguru/daily/:id", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid update ID" })
      }

      const rowRes = await db.query(
        "SELECT * FROM omsguru_daily_inventory_updates WHERE id = $1",
        [id],
      )
      const r = rowRes.rows[0]
      if (!r) {
        return res.status(404).json({ error: "OMSGuru update record not found" })
      }

      res.json({
        update: {
          id: Number(r.id),
          requestId: String(r.request_id),
          updateDate: String(r.update_date).slice(0, 10),
          dropshipWarehouseId: String(r.dropship_warehouse_id),
          totalSkus: Number(r.total_skus),
          totalQty: Number(r.total_qty),
          csvContent: String(r.csv_content),
          fileName: String(r.file_name),
          storagePath: String(r.storage_path),
          storageUrl: String(r.storage_url),
          emailSent: Boolean(r.email_sent),
          emailSentAt: r.email_sent_at ? new Date(r.email_sent_at).toISOString() : null,
          emailRecipients: r.email_recipients || [],
          emailCc: r.email_cc || [],
          skuBreakdown: (r.sku_breakdown as SkuUpdateItem[]) || [],
          generatedBy: r.generated_by ? Number(r.generated_by) : null,
          createdAt: new Date(r.created_at).toISOString(),
        },
      })
    } catch (error) {
      next(error)
    }
  })

  // GET /api/omsguru/daily/:id/download - Direct CSV download formatted for OMSGuru
  app.get("/api/omsguru/daily/:id/download", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid update ID" })
      }

      const rowRes = await db.query(
        "SELECT csv_content, file_name, request_id FROM omsguru_daily_inventory_updates WHERE id = $1",
        [id],
      )
      const r = rowRes.rows[0]
      if (!r) {
        return res.status(404).json({ error: "OMSGuru update record not found" })
      }

      const csvContent = String(r.csv_content || "")
      // Explicit exact filename required by user: UpdateInStockQtyAnd_orLastPurchasePrice.csv
      const downloadFilename = "UpdateInStockQtyAnd_orLastPurchasePrice.csv"

      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename="${downloadFilename}"`)
      res.setHeader("X-OMSGuru-Request-Id", String(r.request_id))
      res.status(200).send(csvContent)
    } catch (error) {
      next(error)
    }
  })

  // POST /api/omsguru/daily/generate - Manual trigger to build & upload daily file now
  app.post("/api/omsguru/daily/generate", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const actorUserId = (req as SessionRequest).user.id
      const targetDate = typeof req.body?.targetDate === "string" && req.body.targetDate.trim()
        ? req.body.targetDate.trim()
        : getIstDateParts().dateStr
      const warehouseId = typeof req.body?.warehouseId === "string" && req.body.warehouseId.trim()
        ? req.body.warehouseId.trim()
        : undefined

      const record = await generateOmsguruDailyUpdate(db, {
        targetDate,
        warehouseId,
        actorUserId,
      })

      // Send email if requested
      const sendEmailNow = Boolean(req.body?.sendEmail)
      let emailResult = null
      if (sendEmailNow) {
        emailResult = await sendOmsguruDailyEmail(db, record.id, { force: true })
      }

      res.status(201).json({
        ok: true,
        update: record,
        emailResult,
      })
    } catch (error) {
      next(error)
    }
  })

  // POST /api/omsguru/daily/:id/send - Send or re-send update email via Resend
  app.post("/api/omsguru/daily/:id/send", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid update ID" })
      }

      const result = await sendOmsguruDailyEmail(db, id, { force: true })
      res.json({ ok: true, result })
    } catch (error) {
      next(error)
    }
  })

  // POST /api/omsguru/prune - Prune files older than 180 days (Admin only)
  app.post("/api/omsguru/prune", requireUser, requireAdmin, async (_req, res, next) => {
    try {
      const db = getPool()
      const config = await getOmsguruConfig(db)
      const pruned = await pruneOldOmsguruFiles(db, config.retentionDays)
      res.json({ ok: true, prunedCount: pruned, retentionDays: config.retentionDays })
    } catch (error) {
      next(error)
    }
  })
}
