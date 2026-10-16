// HTTP routes for Iron Send tracking, return analytics and the live sync cursor.
//
//  GET   /api/iron                 the Iron Send list and its Pending / Received / Overdue figures (any signed-in user)
//  GET   /api/iron/:id             one record with every receive entry
//  POST  /api/iron/:id/receive     the Inward Team records ironed units that came back (Inward or Admin only)
//  GET   /api/iron/batches         Iron Send batches (state=open|partial|overdue|received|all, search)
//  POST  /api/iron/batches         the Return Team makes a batch from pending lines (not the Inward Team)
//  GET   /api/iron/batches/:id     one batch with its lines; /download?format=xlsx|csv for the khaata challan sheet
//  PATCH /api/iron/batches/:id     khaata, challan number, notes (audited)
//  POST  /api/iron/batches/:id/receive   the Inward Team receives every pending unit of the batch (manual)
//  PATCH /api/admin/iron/settings  the overdue setting (Admin only)
//  GET   /api/reports/analytics    size, SKU, marketplace, date and reason figures; format=csv for a file
//  GET   /api/sync/state           the sync cursor, for clients that poll instead of holding a WebSocket
//
// Every route passes the signed-in user's account scope, so the restriction is applied in SQL.

import type { Express, RequestHandler } from "express"
import { analyticsCsv, loadAnalytics } from "./analytics.js"
import { getPool } from "./db.js"
import { actorOf, requireAdmin, scopeOf, sendError, userOf } from "./http.js"
import {
  createIronBatch,
  getIronBatch,
  getIronRecord,
  ironBatchCsv,
  ironBatchXlsx,
  ironLocationOf,
  ironRecordAccount,
  ironSummary,
  listIronBatches,
  listIronRecords,
  receiveIron,
  receiveIronBatch,
  setOverdueDays,
  updateIronBatch,
} from "./iron.js"
import { currentCursor, liveClientCount, publishChange } from "./live.js"
import { ServiceError } from "./register-service.js"

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function mountIronRoutes(app: Express, requireUser: RequestHandler): void {
  app.get("/api/iron", requireUser, async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>
      res.json(
        await listIronRecords(getPool(), scopeOf(req), {
          state: text(q.state) || "open",
          marketplaceId: positiveId(q.marketplaceId),
          batchId: positiveId(q.batchId),
          search: text(q.search).slice(0, 80),
          dateFrom: text(q.dateFrom),
          dateTo: text(q.dateTo),
        }),
      )
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/iron/batches", requireUser, async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>
      res.json({ batches: await listIronBatches(getPool(), scopeOf(req), { state: text(q.state) || "open", search: text(q.search).slice(0, 80) }) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/iron/batches", requireUser, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const user = userOf(req)
      const recordIds = Array.isArray(body.recordIds) ? body.recordIds.map(Number) : null
      const result = await createIronBatch(getPool(), { ...actorOf(req), role: user.role }, scopeOf(req), {
        recordIds,
        location: ironLocationOf(body.location),
        khaataName: text(body.khaataName),
        challanNo: text(body.challanNo),
        expectedDays: Number(body.expectedDays ?? 3),
        notes: text(body.notes),
        clientKey: text(body.clientKey) || null,
      })
      res.json(result)
      if (!result.replayed) publishChange({ kind: "iron.batch", marketplaceId: null, actorId: user.id })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/iron/batches/:id/download", requireUser, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Iron batch not found")
      const { batch, rows } = await getIronBatch(getPool(), scopeOf(req), id)
      if (text((req.query as Record<string, unknown>).format) === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8")
        res.setHeader("Content-Disposition", `attachment; filename="${batch.batchNo}.csv"`)
        res.send(`\uFEFF${ironBatchCsv(batch, rows)}`)
        return
      }
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      res.setHeader("Content-Disposition", `attachment; filename="${batch.batchNo}.xlsx"`)
      res.send(ironBatchXlsx(batch, rows))
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/iron/batches/:id", requireUser, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Iron batch not found")
      res.json(await getIronBatch(getPool(), scopeOf(req), id))
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/iron/batches/:id", requireUser, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Iron batch not found")
      const body = (req.body ?? {}) as Record<string, unknown>
      const user = userOf(req)
      const batch = await updateIronBatch(getPool(), { ...actorOf(req), role: user.role }, scopeOf(req), id, {
        khaataName: typeof body.khaataName === "string" ? body.khaataName : undefined,
        challanNo: typeof body.challanNo === "string" ? body.challanNo : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
      })
      res.json({ batch })
      publishChange({ kind: "iron.batch", marketplaceId: null, actorId: user.id })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/iron/batches/:id/receive", requireUser, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Iron batch not found")
      const body = (req.body ?? {}) as Record<string, unknown>
      const user = userOf(req)
      const result = await receiveIronBatch(getPool(), { ...actorOf(req), role: user.role }, scopeOf(req), id, {
        notes: text(body.notes),
        clientKey: text(body.clientKey) || null,
      })
      res.json(result)
      if (result.unitsReceived > 0) publishChange({ kind: "iron.received", marketplaceId: null, actorId: user.id })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/iron/summary", requireUser, async (req, res, next) => {
    try {
      res.json(await ironSummary(getPool(), scopeOf(req), positiveId((req.query as Record<string, unknown>).marketplaceId)))
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/iron/:id", requireUser, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Iron Send record not found")
      res.json({ record: await getIronRecord(getPool(), scopeOf(req), id) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/iron/:id/receive", requireUser, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Iron Send record not found")
      const body = (req.body ?? {}) as Record<string, unknown>
      const user = userOf(req)
      const result = await receiveIron(getPool(), { ...actorOf(req), role: user.role }, scopeOf(req), {
        recordId: id,
        qty: Number(body.qty),
        notes: text(body.notes),
        clientKey: text(body.clientKey) || null,
      })
      res.json(result)
      if (!result.replayed) {
        publishChange({ kind: "iron.received", marketplaceId: await ironRecordAccount(getPool(), id), actorId: user.id })
      }
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/admin/iron/settings", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const days = Number(((req.body ?? {}) as Record<string, unknown>).overdueAfterDays)
      const saved = await setOverdueDays(getPool(), actorOf(req), days)
      res.json({ overdueAfterDays: saved })
      publishChange({ kind: "iron.settings", marketplaceId: null, actorId: actorOf(req).id })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/reports/analytics", requireUser, async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>
      const scope = scopeOf(req)
      const marketplaceId = positiveId(q.marketplaceId)
      const iron = await ironSummary(getPool(), scope, marketplaceId)
      const report = await loadAnalytics(
        getPool(),
        scope,
        { dateFrom: text(q.dateFrom), dateTo: text(q.dateTo), marketplaceId, categoryCode: text(q.category) },
        { iron: { pending: iron.units.pending, overdue: iron.units.overdue } },
      )
      if (text(q.format) === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8")
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="return-analytics-${report.filters.dateFrom}-to-${report.filters.dateTo}.csv"`,
        )
        res.send(`﻿${analyticsCsv(report)}`)
        return
      }
      res.json({ ...report, iron })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/sync/state", requireUser, async (_req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store")
      res.json({ cursor: await currentCursor(getPool()), serverTime: new Date().toISOString(), liveClients: liveClientCount() })
    } catch (error) {
      sendError(res, error, next)
    }
  })
}
