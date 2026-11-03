// API routes for Return Tracking, Monthly Return Data Ingestion,
// Physical Reconciliation, and SPF Claim Eligibility.
//
// Rule 1: Account scope on every query. Every route checks the signed-in user's
// assigned marketplaces and binds the parameter.

import type { Express, RequestHandler } from "express"
import multer from "multer"
import { allowsAccount, NO_ACCESS_MESSAGE } from "./access.js"
import { getPool } from "./db.js"
import { scopeOf, userOf } from "./http.js"
import { publishChange } from "./live.js"
import {
  fileSpfClaimFromTracking,
  getReturnTrackingList,
  getReturnTrackingSummary,
  ingestReturnTrackingRecords,
  parseMyntraReturnsCsv,
  type ReturnTrackingFilters,
} from "./return-tracking.js"

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
})

export function mountReturnTrackingRoutes(app: Express, requireUser: RequestHandler): void {
  // Helper: resolve user's allowed marketplace numeric IDs
  async function resolveAllowedMarketplaceIds(req: Parameters<RequestHandler>[0]): Promise<number[]> {
    const scope = scopeOf(req)
    if (scope.all) {
      const all = await getPool().query("SELECT id FROM marketplaces ORDER BY id")
      return all.rows.map((r: any) => Number(r.id))
    }
    return scope.marketplaceIds
  }

  // 1. Query Return Tracking records with pagination, filters, and summary metrics
  app.get("/api/returns/tracking", requireUser, async (req, res, next) => {
    try {
      const allowedIds = await resolveAllowedMarketplaceIds(req)
      const query = req.query as Record<string, string | undefined>

      const filters: ReturnTrackingFilters = {
        marketplaceId: query.marketplaceId,
        status: query.status,
        search: query.search,
        returnType: query.returnType,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        page: query.page ? parseInt(query.page, 10) : 1,
        limit: query.limit ? parseInt(query.limit, 10) : 50,
        sortKey: query.sortKey || "date",
        sortDir: query.sortDir === "asc" ? "asc" : "desc",
      }

      const result = await getReturnTrackingList(getPool(), allowedIds, filters)
      res.json(result)
    } catch (error) {
      next(error)
    }
  })

  // 2. Summary stats only
  app.get("/api/returns/tracking/summary", requireUser, async (req, res, next) => {
    try {
      const allowedIds = await resolveAllowedMarketplaceIds(req)
      const mktId = req.query.marketplaceId ? parseInt(String(req.query.marketplaceId), 10) : undefined
      const summary = await getReturnTrackingSummary(getPool(), allowedIds, mktId)
      res.json(summary)
    } catch (error) {
      next(error)
    }
  })

  // 3. Upload Monthly / Period Return Created Data CSV
  app.post(
    "/api/returns/tracking/upload",
    requireUser,
    uploadMemory.single("file"),
    async (req, res, next) => {
      try {
        const file = req.file
        if (!file) {
          return res.status(400).json({ error: "Please select a return report CSV file to upload." })
        }

        const scope = scopeOf(req)
        const content = file.buffer.toString("utf8")
        const parsed = parseMyntraReturnsCsv(content)

        if (parsed.warnings.length && !parsed.records.length) {
          return res.status(400).json({
            error: parsed.warnings[0] || "Could not parse return report. Ensure valid CSV headers.",
          })
        }

        // Determine target marketplace ID: explicit choice or auto-detect from seller_id
        let targetMarketplaceId: number | null = null
        const reqMkt = String(req.body?.marketplaceId || "").trim()

        if (reqMkt && reqMkt !== "auto" && !isNaN(Number(reqMkt))) {
          targetMarketplaceId = Number(reqMkt)
        } else {
          // Auto-detect based on seller_id in file
          if (parsed.detectedSellerId === "45833") {
            const mktRow = await getPool().query(
              "SELECT id FROM marketplaces WHERE name ILIKE '%EJ%' OR name ILIKE '%45833%' LIMIT 1",
            )
            if (mktRow.rows[0]) targetMarketplaceId = Number(mktRow.rows[0].id)
          } else if (parsed.detectedSellerId === "10708") {
            const mktRow = await getPool().query(
              "SELECT id FROM marketplaces WHERE (name ILIKE '%VB%' AND name ILIKE '%Myntra%') OR name ILIKE '%10708%' LIMIT 1",
            )
            if (mktRow.rows[0]) targetMarketplaceId = Number(mktRow.rows[0].id)
          }
        }

        if (!targetMarketplaceId) {
          // Fallback to first available Myntra account or first permitted account
          const fallback = await getPool().query(
            "SELECT id FROM marketplaces WHERE name ILIKE '%Myntra%' ORDER BY id LIMIT 1",
          )
          targetMarketplaceId = fallback.rows[0] ? Number(fallback.rows[0].id) : null
        }

        if (!targetMarketplaceId) {
          return res.status(400).json({
            error: "Could not determine target marketplace account. Please select an account explicitly.",
          })
        }

        // Rule 1: check account permission
        if (!allowsAccount(scope, targetMarketplaceId)) {
          return res.status(403).json({ error: NO_ACCESS_MESSAGE })
        }

        const mktNameRes = await getPool().query("SELECT name FROM marketplaces WHERE id = $1", [
          targetMarketplaceId,
        ])
        const marketplaceName = mktNameRes.rows[0]?.name || "Myntra"

        const ingestResult = await ingestReturnTrackingRecords(
          getPool(),
          targetMarketplaceId,
          parsed.records,
        )

        publishChange({ kind: "upload.activated", marketplaceId: targetMarketplaceId })

        res.json({
          success: true,
          marketplaceId: targetMarketplaceId,
          marketplaceName,
          detectedSellerId: parsed.detectedSellerId,
          totalRowsParsed: parsed.records.length,
          inserted: ingestResult.inserted,
          matchedScans: ingestResult.matchedScans,
          summary: ingestResult.summary,
          warnings: parsed.warnings.slice(0, 5),
        })
      } catch (error) {
        next(error)
      }
    },
  )

  // 4. 1-Click File SPF Claim from Tracking Record
  app.post("/api/returns/tracking/claim", requireUser, async (req, res, next) => {
    try {
      const user = userOf(req)
      const scope = scopeOf(req)
      const trackingRecordId = parseInt(String(req.body?.trackingRecordId), 10)
      const reason = String(req.body?.reason || "").trim()

      if (isNaN(trackingRecordId)) {
        return res.status(400).json({ error: "Invalid trackingRecordId" })
      }

      // Check record and account authorization
      const checkRes = await getPool().query(
        "SELECT marketplace_id FROM return_tracking_records WHERE id = $1",
        [trackingRecordId],
      )
      if (!checkRes.rows.length) {
        return res.status(404).json({ error: "Return tracking record not found" })
      }

      const mktId = Number(checkRes.rows[0].marketplace_id)
      if (!allowsAccount(scope, mktId)) {
        return res.status(403).json({ error: NO_ACCESS_MESSAGE })
      }

      const claimResult = await fileSpfClaimFromTracking(
        getPool(),
        trackingRecordId,
        user.id,
        reason,
      )

      publishChange({ kind: "claim.updated", marketplaceId: mktId, actorId: user.id })

      res.json({
        success: true,
        claimId: claimResult.claimId,
        trackingRecordId: claimResult.trackingRecordId,
      })
    } catch (error) {
      next(error)
    }
  })

  // 5. CSV Export of Filtered Records
  app.get("/api/returns/tracking/export", requireUser, async (req, res, next) => {
    try {
      const allowedIds = await resolveAllowedMarketplaceIds(req)
      const query = req.query as Record<string, string | undefined>

      const filters: ReturnTrackingFilters = {
        marketplaceId: query.marketplaceId,
        status: query.status,
        search: query.search,
        returnType: query.returnType,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        page: 1,
        limit: 10000, // Export up to 10k rows
        sortKey: query.sortKey || "date",
        sortDir: query.sortDir === "asc" ? "asc" : "desc",
      }

      const { records } = await getReturnTrackingList(getPool(), allowedIds, filters)

      // CSV Header
      const csvHeaders = [
        "Effective Date",
        "Age (Days)",
        "Marketplace",
        "Seller ID",
        "Return Type",
        "Tracking ID (AWB)",
        "Forward AWB",
        "Return AWB",
        "Order ID",
        "Order Line ID",
        "SKU",
        "Myntra SKU",
        "Quantity",
        "Portal Status",
        "Portal Sub-Status",
        "Physically Received",
        "Physical Scan Date",
        "Physical Outcome",
        "Claim Eligibility Status",
        "Claim Filing Deadline",
        "Claim Ticket Code",
      ]

      const escapeCell = (val: unknown): string => {
        if (val === null || val === undefined) return '""'
        const s = String(val).replace(/"/g, '""')
        // Prepend single quote if cell starts with formula characters
        if (/^[=+\-@]/.test(s)) return `"'${s}"`
        return `"${s}"`
      }

      const rows: string[] = [csvHeaders.map(escapeCell).join(",")]

      for (const r of records) {
        rows.push(
          [
            r.effectiveReturnDate,
            r.ageDays,
            r.marketplaceName,
            r.sellerId,
            r.returnType,
            r.trackingId,
            r.forwardTrackingNumber,
            r.returnTrackingNumber,
            r.orderId,
            r.orderLineId,
            r.sku,
            r.myntraSkuCode,
            r.quantity,
            r.portalStatus,
            r.portalSubStatus,
            r.isPhysicallyReceived ? "YES" : "NO",
            r.physicalScannedAt || "",
            r.physicalOutcome || "",
            r.claimEligibilityStatus,
            r.claimFilingDeadline || "",
            r.claimTicketCode || "",
          ]
            .map(escapeCell)
            .join(","),
        )
      }

      const csvContent = rows.join("\r\n")
      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename=return-tracking-${new Date().toISOString().slice(0, 10)}.csv`)
      res.send(csvContent)
    } catch (error) {
      next(error)
    }
  })
}
