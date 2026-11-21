// HTTP routes for the claims foundation.
//
//  GET    /api/claims/queue              the claims queue (scoped, with filters)
//  GET    /api/claims/:id                one claim with media and status history
//  POST   /api/claims                    create a claim (duplicate prevention, immutable scan linkage)
//  PATCH  /api/claims/:id/status         update claim status (audited)
//  POST   /api/claims/:id/media/upload   validate and upload one evidence file to Firebase (streamed via a temp file)
//  GET    /api/claims/:id/media/:mediaId secure scoped file retrieval (streams from Firebase with Range/206, no public link)
//  PATCH  /api/claims/:id/media/:mediaId  deactivate media (soft delete, audited)
//  GET    /api/claims/templates          list claim templates (scoped, any signed-in user)
//  POST   /api/admin/claims/templates     create a template (Admin only)
//  PATCH  /api/admin/claims/templates/:id update a template (Admin only)
//  POST   /api/admin/claims/templates/:id/fields  add a field to a template (Admin only)
//  PATCH  /api/admin/claims/template-fields/:id/deactivate  deactivate a field (Admin only)
//
// Every route passes the signed-in user's account scope, so the restriction is applied in SQL.
// Admin routes require requireAdmin. No direct public media links are returned.

import path from "node:path"
import type { Express, RequestHandler } from "express"
import * as XLSX from "xlsx"
import { uploadFileToFirebaseStorage } from "./firebase-storage.js"
import { evidenceUpload, removeEvidenceTempFile, sendStoredEvidence, type EvidenceTempFile } from "./evidence-stream.js"
import { getPool } from "./db.js"
import { publishChange } from "./live.js"
import { actorOf, requireAdmin, requireSupervisorOrAdmin, scopeOf, sendError } from "./http.js"
import {
  addClaimMedia,
  addTemplateField,
  createClaim,
  createClaimTemplate,
  deactivateClaimMedia,
  deactivateTemplateField,
  evidenceContentError,
  getClaim,
  getClaimMediaMeta,
  getClaimTemplate,
  isEvidenceStorageConfigured,
  listClaimTemplates,
  listClaims,
  prepareClaimMediaUpload,
  searchClaimScans,
  updateClaimStatus,
  updateClaimTemplate,
} from "./claims-service.js"
import { ServiceError } from "./register-service.js"
import { getMeeshoClaimDraft } from "./meesho-claims.js"
import { createOrQueueAutomationJob } from "./claim-automation-service.js"

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function optionalNumber(value: unknown): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}

function safeSheetValue(value: string | number): string | number {
  if (typeof value !== "string") return value
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

function claimFilters(q: Record<string, unknown>) {
  return {
    status: text(q.status) || undefined,
    marketplaceId: positiveId(q.marketplaceId),
    search: text(q.search).slice(0, 80),
    dateFrom: text(q.dateFrom),
    dateTo: text(q.dateTo),
  }
}

const uploadEvidence = evidenceUpload()

function fileExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return /^[.][a-z0-9]{1,8}$/.test(ext) ? ext : ""
}

export function mountClaimsRoutes(app: Express, requireUser: RequestHandler): void {
  // ---- Claims queue and detail (any signed-in user, scoped) ----

  app.get("/api/claims/queue", requireUser, async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>
      res.json(
        await listClaims(getPool(), scopeOf(req), {
          ...claimFilters(q),
          page: positiveId(q.page) || 1,
          pageSize: positiveId(q.pageSize) || 25,
        }),
      )
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/claims/export", requireUser, async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>
      const format = text(q.format).toLowerCase() || "csv"
      if (!["csv", "xlsx"].includes(format)) throw new ServiceError(400, "The export format is csv or xlsx.")
      const result = await listClaims(getPool(), scopeOf(req), {
        ...claimFilters(q),
        page: 1,
        pageSize: 50_000,
        maxPageSize: 50_000,
      })
      if (Number(result.total) > result.rows.length) {
        throw new ServiceError(413, "This export exceeds 50,000 claims. Narrow the date or marketplace filters and try again.")
      }
      const headers = [
        "Claim ID", "Marketplace", "Created", "AWB", "Order ID", "Reason", "Status",
        "Claim Amount", "Approved Amount", "Paid Amount", "Payout Reference", "Payout Date",
      ]
      const rows = result.rows.map((row) => [
        row.id, row.marketplace, row.createdAt, row.trackingId, row.orderId, row.claimReason, row.status,
        row.claimAmount, row.approvedAmount, row.paidAmount, row.payoutReference, row.payoutDate,
      ].map(safeSheetValue))
      if (format === "xlsx") {
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Claims")
        const output = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        res.setHeader("Content-Disposition", 'attachment; filename="claim-reconciliation.xlsx"')
        res.send(output)
        return
      }
      const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`
      const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      res.setHeader("Content-Disposition", 'attachment; filename="claim-reconciliation.csv"')
      res.send(`\uFEFF${csv}`)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/claims/templates", requireUser, async (req, res, next) => {
    try {
      res.json({ templates: await listClaimTemplates(getPool(), scopeOf(req)) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/claims/scan-search", requireUser, async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>
      res.json({
        rows: await searchClaimScans(
          getPool(),
          scopeOf(req),
          text(q.search).slice(0, 100),
          positiveId(q.marketplaceId),
        ),
      })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/claims/meesho/draft/:scanId", requireUser, async (req, res, next) => {
    try {
      const scanId = positiveId(req.params.scanId)
      if (!scanId) throw new ServiceError(404, "Meesho scanned return not found.")
      res.json({ draft: await getMeeshoClaimDraft(getPool(), scopeOf(req), scanId) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/claims/:id(\\d+)", requireUser, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) return next()
      res.json({ claim: await getClaim(getPool(), scopeOf(req), id) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/claims", requireUser, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const result = await createClaim(getPool(), actorOf(req), scopeOf(req), {
        receiptScanId: Number(body.receiptScanId),
        claimReason: text(body.claimReason),
        claimTitle: text(body.claimTitle),
        claimDescription: text(body.claimDescription),
        remarks: text(body.remarks),
        claimTemplateId: positiveId(body.claimTemplateId),
        marketplaceIssueCode: text(body.marketplaceIssueCode),
        packetState: text(body.packetState),
      })
      let jobId: number | null = null
      try {
        jobId = await createOrQueueAutomationJob(getPool(), result.id)
      } catch (err) {
        console.warn("[claims-create] createOrQueueAutomationJob warning:", err)
      }
      publishChange({ kind: "claim.updated", marketplaceId: result.marketplaceId, actorId: actorOf(req).id })
      res.status(201).json(jobId ? { claim: result, jobId } : { claim: result })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/claims/:id(\\d+)/status", requireUser, requireSupervisorOrAdmin, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) return next()
      const body = (req.body ?? {}) as Record<string, unknown>
      const result = await updateClaimStatus(getPool(), actorOf(req), scopeOf(req), id, {
        status: text(body.status),
        reason: text(body.reason),
        approvedAmount: optionalNumber(body.approvedAmount),
        paidAmount: optionalNumber(body.paidAmount),
        payoutReference: text(body.payoutReference),
        payoutDate: text(body.payoutDate),
      })
      if (result.status === "ready_for_claim" || result.status === "reclaim") {
        try {
          // Requeue when returning from waiting_for_approval (prior job is "prepared") or reopening via reclaim;
          // active stages ("queued", "approved", "downloading_media", etc.) are preserved without duplicating.
          await createOrQueueAutomationJob(getPool(), result.id, { requeueReopened: true })
        } catch (err) {
          console.warn("[claims-status] createOrQueueAutomationJob warning:", err)
        }
      }
      publishChange({ kind: "claim.updated", marketplaceId: result.marketplaceId, actorId: actorOf(req).id })
      res.json(result)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // ---- Claim media ----

  app.post("/api/claims/:id(\\d+)/media/upload", requireUser, uploadEvidence, async (req, res, next) => {
    const file = req.file as EvidenceTempFile | undefined
    try {
      const id = positiveId(req.params.id)
      if (!id) return next()
      if (!file) throw new ServiceError(400, "Choose an evidence file to upload.")
      if (!isEvidenceStorageConfigured()) {
        throw new ServiceError(503, "Evidence storage is not configured. Set up Firebase credentials before uploading evidence.")
      }
      const contentHash = file.contentHash
      const target = await prepareClaimMediaUpload(getPool(), scopeOf(req), id, {
        fieldKey: text(req.body?.fieldKey),
        contentHash,
        mimeType: file.mimetype,
        extension: fileExtension(file.originalname),
        sizeBytes: file.size,
      })
      if (target.duplicateMediaId) {
        res.json({ id: target.duplicateMediaId, duplicate: true })
        return
      }
      const contentError = evidenceContentError(target.fieldType, file.head)
      if (contentError) throw new ServiceError(400, contentError)
      const uploaded = await uploadFileToFirebaseStorage(target.objectPath, file.path, file.mimetype)
      const result = await addClaimMedia(getPool(), actorOf(req), scopeOf(req), id, {
        fieldKey: text(req.body?.fieldKey),
        storageObjectPath: target.objectPath,
        contentHash,
        sizeBytes: uploaded.size || file.size,
        mimeType: file.mimetype,
        originalFilename: file.originalname,
        capturedAt: text(req.body?.capturedAt) || null,
      })
      try {
        await createOrQueueAutomationJob(getPool(), id)
      } catch (err) {
        console.warn("[claims-media] createOrQueueAutomationJob warning:", err)
      }
      publishChange({ kind: "claim.updated", marketplaceId: result.marketplaceId, actorId: actorOf(req).id })
      res.status(201).json(result)
    } catch (error) {
      sendError(res, error, next)
    } finally {
      removeEvidenceTempFile(file)
    }
  })

  // Secure scoped file retrieval: streams the file from Firebase Storage, passing a Range request through
  // (206) so the console's video player can seek. No direct public link.
  app.get("/api/claims/:id(\\d+)/media/:mediaId(\\d+)", requireUser, async (req, res, next) => {
    try {
      const claimId = positiveId(req.params.id)
      const mediaId = positiveId(req.params.mediaId)
      if (!claimId || !mediaId) return next()

      const meta = await getClaimMediaMeta(getPool(), scopeOf(req), claimId, mediaId)

      if (!isEvidenceStorageConfigured()) {
        throw new ServiceError(503, "Evidence storage is not configured. Set up Firebase credentials to retrieve media.")
      }

      await sendStoredEvidence(req, res, meta)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/claims/:id(\\d+)/media/:mediaId(\\d+)/deactivate", requireUser, async (req, res, next) => {
    try {
      const claimId = positiveId(req.params.id)
      const mediaId = positiveId(req.params.mediaId)
      if (!claimId || !mediaId) return next()
      const result = await deactivateClaimMedia(getPool(), actorOf(req), scopeOf(req), claimId, mediaId)
      publishChange({ kind: "claim.updated", marketplaceId: result.marketplaceId, actorId: actorOf(req).id })
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // ---- Admin: claim template management ----

  app.post("/api/admin/claims/templates", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const template = await createClaimTemplate(getPool(), actorOf(req), {
        marketplaceId: positiveId(body.marketplaceId),
        name: text(body.name),
        description: text(body.description),
      })
      res.status(201).json({ template })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/admin/claims/templates/:id", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Claim template not found.")
      const body = (req.body ?? {}) as Record<string, unknown>
      const template = await updateClaimTemplate(getPool(), actorOf(req), id, {
        name: typeof body.name === "string" ? body.name : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      })
      res.json({ template })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/admin/claims/templates/:id/fields", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Claim template not found.")
      const body = (req.body ?? {}) as Record<string, unknown>
      const field = await addTemplateField(getPool(), actorOf(req), id, {
        fieldKey: text(body.fieldKey),
        fieldLabel: text(body.fieldLabel),
        fieldType: text(body.fieldType) || "image",
        required: body.required !== false,
        minCount: body.minCount === undefined ? 1 : Number(body.minCount),
        maxCount: body.maxCount === undefined ? 10 : Number(body.maxCount),
        maxFileSizeMb: body.maxFileSizeMb === undefined ? 25 : Number(body.maxFileSizeMb),
      })
      res.status(201).json({ field })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/admin/claims/template-fields/:id/deactivate", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Template field not found.")
      await deactivateTemplateField(getPool(), actorOf(req), id)
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })
}
