import type { Express, RequestHandler } from "express"
import { getPool } from "../db.js"
import { scopeOf, sendError } from "../http.js"
import { checkShopifyConnection } from "./db.js"
import { syncShopifyReturns } from "./sync.js"
import {
  getShopifyMetrics,
  getShopifyRecords,
  exportShopifyCsv,
  type ShopifyRecordFilters,
} from "./service.js"

export function mountShopifyRoutes(app: Express, requireUser: RequestHandler): void {
  // 1. Connection status & sync health
  app.get("/api/shopify/status", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const conn = await checkShopifyConnection()
      const market = await db.query<{ id: number; last_synced_label: string }>(
        `SELECT id, last_synced_label FROM marketplaces WHERE name = 'Shopify' LIMIT 1`,
      )
      const marketplaceId = market.rows[0]?.id ?? 0
      const lastSyncedLabel = market.rows[0]?.last_synced_label || "Not synced yet"

      const activeRes = await db.query<{ count: string }>(
        `SELECT count(*)::text as count FROM expected_returns WHERE marketplace_id = $1 AND lookup_status = 'active'`,
        [marketplaceId],
      )

      res.json({
        configured: Boolean(process.env.SHOPIFY_DATABASE_URL?.trim()),
        connected: conn.ok,
        message: conn.message,
        orderCount: conn.orderCount,
        lastSyncedLabel,
        totalActiveScannable: Number(activeRes.rows[0]?.count ?? 0),
      })
    } catch (err) {
      next(err)
    }
  })

  // 2. Trigger on-demand sync (strictly READ-ONLY on Shopify db)
  app.post("/api/shopify/sync", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const result = await syncShopifyReturns(db)
      res.json(result)
    } catch (err) {
      sendError(res, err, next)
    }
  })

  // 3. Shopify Metrics: Formula Created - Received = Pending, Return/RTO breakdown, Daily stats
  app.get("/api/shopify/metrics", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const scope = scopeOf(req)
      const metrics = await getShopifyMetrics(db, scope)
      res.json(metrics)
    } catch (err) {
      sendError(res, err, next)
    }
  })

  // 4. Detailed returns/RTO listing with tab filters, search, and pagination
  app.get("/api/shopify/records", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const scope = scopeOf(req)
      const { tab, q, from, to, limit, offset } = req.query
      const filters: ShopifyRecordFilters = {
        tab:
          typeof tab === "string" && ["all", "pending", "received", "returns", "rtos"].includes(tab)
            ? (tab as any)
            : "all",
        search: typeof q === "string" ? q : undefined,
        dateFrom: typeof from === "string" ? from : undefined,
        dateTo: typeof to === "string" ? to : undefined,
        limit: limit ? Number(limit) : 50,
        offset: offset ? Number(offset) : 0,
      }
      const data = await getShopifyRecords(db, filters, scope)
      res.json(data)
    } catch (err) {
      sendError(res, err, next)
    }
  })

  // 5. CSV Export of returns and RTO report
  app.get("/api/shopify/export", requireUser, async (req, res, next) => {
    try {
      const db = getPool()
      const scope = scopeOf(req)
      const { tab, q, from, to } = req.query
      const filters: ShopifyRecordFilters = {
        tab:
          typeof tab === "string" && ["all", "pending", "received", "returns", "rtos"].includes(tab)
            ? (tab as any)
            : "all",
        search: typeof q === "string" ? q : undefined,
        dateFrom: typeof from === "string" ? from : undefined,
        dateTo: typeof to === "string" ? to : undefined,
      }
      const csv = await exportShopifyCsv(db, filters, scope)
      const dateStr = new Date().toISOString().slice(0, 10)
      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="shopify-returns-rto-${filters.tab || "all"}-${dateStr}.csv"`,
      )
      res.send(csv)
    } catch (err) {
      sendError(res, err, next)
    }
  })
}
