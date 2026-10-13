// Upload routes: the account's upload history, the template, the preview of one file, and its activation.
//
// /api/uploads/preview reads the file and stages it. It changes no lookup data. /api/uploads/import activates a staged
// file, and it checks everything again first: the owner, the age of the preview, the account scope, every blocker (see
// upload-policy.ts), and the confirmations. The preview is never trusted on its own.
//
// A staged file is removed before its commit starts, so the same preview cannot be activated twice. If the commit fails,
// the previous active lookup data stays, and the file has to be uploaded again.

import crypto from "node:crypto"
import type { Express, RequestHandler } from "express"
import multer from "multer"
import { accountCondition, allowsAccount, NO_ACCESS_MESSAGE, type AccountScope } from "./access.js"
import { getPool } from "./db.js"
import { formatRowCount, formatUploadLabel } from "./format.js"
import { commitLookupUpload, resolveProductSkus, type ProductSource } from "./lookup-import.js"
import { UNKNOWN_PARTNER_LABEL } from "./register-rules.js"
import { inspectLayout, isScannableRow, parseSpreadsheet, templateCsv, type ParsedRow } from "./sheets.js"
import { scopeOf, userOf } from "./http.js"
import { activationBlockers, canActivate, confirmationsNeeded, countPreview, type PreviewCounts } from "./upload-policy.js"

const PREVIEW_TTL_MS = 15 * 60 * 1000
const SAMPLE_LIMIT = 20
const WARNING_LIMIT = 10

type PreviewException = {
  line: number | null
  status: "pending" | "rejected" | "duplicate" | "cancelled"
  reasons: string[]
  trackingId: string
  sourceTrackingId: string
  orderId: string
  shipmentId: string
  quantity: number
  returnType: string
  carrier: string
  listingSku: string
}

function previewException(row: ParsedRow): PreviewException {
  return {
    line: row.sourceLineNo ?? null,
    status: row.duplicate ? "duplicate" : row.cancelled ? "cancelled" : row.valid ? "pending" : "rejected",
    reasons: row.error ? [row.error, ...row.pendingReasons] : row.pendingReasons,
    trackingId: row.trackingId,
    sourceTrackingId: row.csvTrackingId ?? row.raw?.reverse_leg_tracking_id ?? row.raw?.return_awb_no ?? "",
    orderId: row.orderId,
    shipmentId: row.displayOrderItemId ?? row.raw?.shipment_id ?? row.raw?.return_shipment_id ?? "",
    quantity: row.qty,
    returnType: row.returnTypeRaw ?? row.returnType,
    carrier: row.carrierValue ?? "",
    listingSku: row.channelListingId,
  }
}

type StagedUpload = {
  ownerId: number
  marketplaceId: number
  marketplace: string
  filename: string
  profileId: string
  rows: ParsedRow[]
  counts: PreviewCounts
  // Catalog image per listing SKU, and the source of each product SKU, found at preview time.
  images: Map<string, string>
  sources: Map<string, ProductSource>
  createdAt: number
}

const staged = new Map<string, StagedUpload>()

function forgetExpired(now: number): void {
  for (const [id, item] of staged) {
    if (now - item.createdAt > PREVIEW_TTL_MS) staged.delete(id)
  }
}

const uploadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

async function accountIdOf(name: string): Promise<number | null> {
  const result = await getPool().query("SELECT id FROM marketplaces WHERE name = $1", [name])
  const row = result.rows[0]
  return row ? Number(row.id) : null
}

// Names the accounts a file's rows belong to. An account the user cannot see is named only as "another account".
async function describeAccounts(names: string[], scope: AccountScope): Promise<string> {
  const labels: string[] = []
  for (const name of names) {
    const id = await accountIdOf(name)
    labels.push(id !== null && allowsAccount(scope, id) ? name : "another account")
  }
  return [...new Set(labels)].join(", ")
}

// Each warning is shown once, with a few samples. Unmapped listing SKUs are added as one line with a sample.
function warningSamples(rows: ParsedRow[], unmapped: string[]): string[] {
  const samples: string[] = []
  for (const row of rows) {
    for (const warning of row.warnings) {
      if (samples.length < WARNING_LIMIT && !samples.includes(warning)) samples.push(warning)
    }
  }
  if (unmapped.length && samples.length < WARNING_LIMIT) {
    samples.push(
      `${unmapped.length.toLocaleString("en-US")} listing SKU(s) not found in the product master or the OMSGuru master, e.g. ${unmapped.slice(0, 3).join(", ")}`,
    )
  }
  return samples
}

// Valid rows counted by the carrier the file or the verified link named. Unknown rows are counted as "Unknown / Pending
// Verification", never as a guess.
function partnerSummary(rows: ParsedRow[], partners: ReadonlyMap<ParsedRow, { name: string }> | undefined) {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!row.valid) continue
    const name = partners?.get(row)?.name || UNKNOWN_PARTNER_LABEL
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, rows: count }))
}

export function mountUploadRoutes(app: Express, requireUser: RequestHandler): void {
  // The history of uploads for the accounts the user can see.
  app.get("/api/uploads", requireUser, async (req, res, next) => {
    try {
      const params: unknown[] = []
      const condition = accountCondition(scopeOf(req), "b.marketplace_id", params)
      const result = await getPool().query(
        `SELECT b.id, b.filename, m.name AS marketplace, b.row_count, b.scannable_row_count, b.pending_row_count,
                b.rejected_row_count, b.uploaded_label, b.status, b.detected_format
         FROM upload_batches b
         JOIN marketplaces m ON m.id = b.marketplace_id
         WHERE ${condition}
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT 200`,
        params,
      )
      res.json({
        rows: result.rows.map((row) => ({
          id: Number(row.id),
          filename: String(row.filename),
          marketplace: String(row.marketplace),
          rowCount: formatRowCount(Number(row.row_count)),
          scannableRows: Number(row.scannable_row_count),
          pendingRows: Number(row.pending_row_count),
          rejectedRows: Number(row.rejected_row_count),
          uploadedAt: String(row.uploaded_label),
          status: String(row.status),
          format: String(row.detected_format || ""),
        })),
      })
    } catch (error) {
      next(error)
    }
  })

  app.get("/api/uploads/template", requireUser, (_req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8")
    res.setHeader("Content-Disposition", "attachment; filename=return-upload-template.csv")
    res.send(templateCsv())
  })

  // Reads and checks one file. Stages it for activation when it is not fatal. Changes no lookup data.
  app.post("/api/uploads/preview", requireUser, uploadFile.single("file"), async (req, res, next) => {
    try {
      const user = userOf(req)
      const scope = scopeOf(req)
      const file = req.file
      const marketplace = String(req.body?.marketplace || "").trim()
      if (!file) return res.status(400).json({ error: "Choose a CSV or XLSX file" })
      if (!marketplace || marketplace === "Select marketplace") {
        return res.status(400).json({ error: "Select a marketplace before importing" })
      }
      const accountId = await accountIdOf(marketplace)
      if (accountId === null) return res.status(400).json({ error: "Select a connected marketplace before importing" })
      if (!allowsAccount(scope, accountId)) return res.status(403).json({ error: NO_ACCESS_MESSAGE })

      const parsed = parseSpreadsheet(file.buffer, marketplace, file.originalname)
      const layout = inspectLayout(file.buffer, file.originalname, marketplace)

      // One account per file. A row for another account would change that account's lookup data, so the file is refused
      // before anything is staged.
      const otherAccounts = [
        ...new Set(
          parsed.rows
            .filter((row) => row.valid && row.marketplace && row.marketplace !== marketplace)
            .map((row) => row.marketplace),
        ),
      ]
      if (otherAccounts.length) {
        const named = await describeAccounts(otherAccounts, scope)
        return res.status(400).json({
          error: `This file has rows for ${named}, but ${marketplace} is selected. Upload one account per file.`,
        })
      }

      const counts = countPreview(parsed.rows)
      const mapping = parsed.fatal ? null : await resolveProductSkus(getPool(), parsed.rows, marketplace)
      const blockers = activationBlockers({ fatal: parsed.fatal, accountAllowed: true, counts })
      const confirmations = confirmationsNeeded(counts)
      const ready = canActivate({ blockers, counts })
      const exceptions = parsed.rows
        .filter((row) => !isScannableRow(row))
        .map(previewException)

      const now = Date.now()
      forgetExpired(now)
      let uploadId: string | null = null
      if (!parsed.fatal && mapping) {
        uploadId = crypto.randomUUID()
        staged.set(uploadId, {
          ownerId: user.id,
          marketplaceId: accountId,
          marketplace,
          filename: file.originalname,
          profileId: parsed.profileId,
          rows: parsed.rows,
          counts,
          images: mapping.images,
          sources: mapping.sources,
          createdAt: now,
        })
      }

      const activeCountResult = await getPool().query(
        "SELECT COUNT(*)::int AS count FROM expected_returns WHERE marketplace_id = $1 AND lookup_status = 'active'",
        [accountId],
      )
      const currentActiveRows = Number(activeCountResult.rows[0]?.count ?? 0)

      res.json({
        uploadId,
        filename: file.originalname,
        marketplace,
        profile: parsed.profileId,
        profileVersion: "1.0",
        headerRow: layout.headerRowIndex !== undefined ? layout.headerRowIndex + 1 : 1,
        currentActiveRows,
        fatal: parsed.fatal,
        headers: {
          found: layout.headers.filter((header) => header !== ""),
          missing: layout.missingRequired,
        },
        counts,
        blockers,
        confirmations,
        canActivate: ready,
        exceptions,
        errors: parsed.rows
          .filter((row) => !row.valid)
          .slice(0, SAMPLE_LIMIT)
          .map((row) => ({ line: row.sourceLineNo ?? null, message: row.error })),
        trackingCorrections: parsed.rows
          .filter((row) => row.trackingValidation === "mismatch_resolved" || row.trackingValidation === "mismatch_kept")
          .slice(0, SAMPLE_LIMIT)
          .map((row) => ({
            line: row.sourceLineNo ?? null,
            trackingId: row.trackingId,
            csvTrackingId: row.csvTrackingId ?? "",
            urlTrackingId: row.urlTrackingId ?? "",
            validation: row.trackingValidation ?? "",
          })),
        partners: partnerSummary(parsed.rows, mapping?.partners),
        productMapping: mapping
          ? {
              checked: mapping.checked,
              mappedRows: mapping.mappedRows,
              titledRows: mapping.titledRows,
              unmappedCount: mapping.unmapped.length,
              unmappedSample: mapping.unmapped.slice(0, 10),
              unmappedSkus: mapping.unmapped,
            }
          : null,
        warnings: warningSamples(parsed.rows, []),
        message: ready
          ? `${counts.scannableRows.toLocaleString("en-US")} rows ready to scan. ${(
              counts.pendingRows +
              counts.errorRows +
              counts.duplicateRows +
              counts.cancelledRows
            ).toLocaleString("en-US")} rows stay in history as exceptions. Activating replaces the active ${marketplace} lookup data. Scanned returns stay in the register.`
          : (blockers[0] ?? "This file cannot be activated."),
      })
    } catch (error) {
      next(error)
    }
  })

  // Activates a staged file. Pending, rejected, duplicate and cancelled rows were already excluded from lookup groups;
  // activation is refused when any fatal/no-scannable blocker remains, or when confirmation is required but missing.
  app.post("/api/uploads/import", requireUser, async (req, res, next) => {
    try {
      const user = userOf(req)
      const scope = scopeOf(req)
      const uploadId = String(req.body?.uploadId || "")
      const item = staged.get(uploadId)
      if (!item || item.ownerId !== user.id) {
        return res.status(400).json({ error: "Upload the file again before importing." })
      }
      if (Date.now() - item.createdAt > PREVIEW_TTL_MS) {
        staged.delete(uploadId)
        return res.status(400).json({ error: "That file preview expired. Upload it again." })
      }
      if (!allowsAccount(scope, item.marketplaceId)) return res.status(403).json({ error: NO_ACCESS_MESSAGE })

      const blockers = activationBlockers({ fatal: "", accountAllowed: true, counts: item.counts })
      if (!canActivate({ blockers, counts: item.counts })) {
        return res.status(409).json({ error: blockers[0] ?? "This file cannot be activated.", blockers })
      }
      const confirmations = confirmationsNeeded(item.counts)
      if (confirmations.length > 0 && req.body?.confirm !== true) {
        return res.status(409).json({ error: "Confirm the items listed before activating.", confirmations })
      }

      // Check if client requested streaming progress (SSE)
      const isStream = req.body?.stream === true || req.headers.accept?.includes("text/event-stream")
      if (isStream) {
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache, no-transform")
        res.setHeader("Connection", "keep-alive")
        res.flushHeaders?.()
      }

      // Taken before the commit, so the same preview cannot be activated twice.
      staged.delete(uploadId)
      const uploadedLabel = formatUploadLabel()

      const batchSize = Number(req.body?.batchSize) > 0 ? Number(req.body?.batchSize) : 500
      // If streaming, pause 1000ms between batches for visual clarity & DB safety as requested; otherwise 0 for instant tests
      const pauseMs = req.body?.pauseMs !== undefined ? Number(req.body?.pauseMs) : (isStream ? 1000 : 0)

      const result = await commitLookupUpload(getPool(), {
        marketplaceName: item.marketplace,
        filename: item.filename,
        uploadedBy: user.id,
        uploadedLabel,
        rows: item.rows,
        images: item.images,
        sources: item.sources,
        batchSize,
        pauseMs,
        onProgress: isStream
          ? async (event) => {
              res.write(`data: ${JSON.stringify(event)}\n\n`)
            }
          : undefined,
      })

      const responsePayload = {
        row: {
          id: result.batchId,
          filename: item.filename,
          marketplace: item.marketplace,
          rowCount: formatRowCount(item.counts.validRows),
          uploadedAt: uploadedLabel,
          status: result.pendingRows || result.rejectedRows ? "Imported with exceptions" : "Imported",
        },
        activatedRows: result.activatedRows,
        scannableRows: result.scannableRows,
        pendingRows: result.pendingRows,
        rejectedRows: result.rejectedRows,
        supersededRows: result.supersededRows,
        cancelledRows: result.cancelledRows,
        confirmed: confirmations,
      }

      if (isStream) {
        res.write(`data: ${JSON.stringify({ phase: "complete", percent: 100, result: responsePayload })}\n\n`)
        res.end()
      } else {
        res.json(responsePayload)
      }
    } catch (error) {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ phase: "error", error: error instanceof Error ? error.message : "Import failed" })}\n\n`)
        res.end()
      } else {
        next(error)
      }
    }
  })
}
