// Administrator routes for the VB EXPORT product master (product_master). Every route needs the Admin role.
//
// /preview reads one file and reports what it holds. /import re-reads the same file and either merges/upserts (default)
// or replaces the whole master in one transaction. The file is parsed again on import, so a stale preview cannot decide
// what is stored. The image link in this file wins over the OMSGuru catalog image when a return file is activated
// (server/lookup-import.ts).

import crypto from "node:crypto"
import type { Express, RequestHandler } from "express"
import multer from "multer"
import { getPool } from "./db.js"
import { actorOf, requireAdmin, sendError } from "./http.js"
import {
  MASTER_STAGING_TTL_MS,
  inheritBlankMasterImages,
  inheritedImageCount,
  insertMasterRows,
  loadStoredMasterImages,
  markUnmappedListingSkusMapped,
  pasteBlankMasterImages,
  productMasterState,
  replaceProductMaster,
  requireStagedMasterImport,
  takeMasterBatch,
  upsertMasterRows,
  upsertProductMaster,
  getUnmappedListingSkusSummary,
  listUnmappedListingSkus,
  generateUnmappedSkusTemplateCsv,
  refreshUnmappedListingSkus,
  type StagedMasterImport,
} from "./product-master.js"
import { ServiceError, writeAudit } from "./register-service.js"
import { masterPreviewForRows, parseProductMaster, productMasterTemplateCsv } from "./sheets.js"

const uploadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

// Preview counts a blank Channel Image URL as present when that product SKU already has a link in this file or in
// product_master. Nothing is written.
async function previewWithInheritedImages(buffer: Buffer, filename: string, scope: string) {
  const parsed = parseProductMaster(buffer, filename, scope)
  if (parsed.fatal || !parsed.rows.length) return masterPreviewForRows(parsed)
  const donors = await loadStoredMasterImages(getPool(), parsed.rows.map((row) => row.masterSku))
  return masterPreviewForRows(parsed, inheritBlankMasterImages(parsed.rows, donors))
}

// The scope the loaded rows are stored under. Empty or "all" means every account. A named scope must be a real
// account, so a typo cannot silently store rows that never match a scan.
async function resolveScope(raw: unknown): Promise<string> {
  const name = String(raw ?? "").trim()
  if (!name || name.toLowerCase() === "all" || name.toLowerCase() === "all marketplaces") return ""
  const result = await getPool().query("SELECT 1 FROM marketplaces WHERE lower(name) = lower($1)", [name])
  if (!result.rows[0]) throw new ServiceError(400, "Choose a connected marketplace, or All marketplaces.")
  return name
}

// Staged product-master imports: parsed rows kept in memory for 15 minutes so large files can be committed
// 500 rows at a time. Keyed by UUID, owned by the administrator who started the import.
const stagedMasterImports = new Map<string, StagedMasterImport>()

function forgetExpiredMasterImports(now: number): void {
  for (const [id, item] of stagedMasterImports) {
    if (now - item.createdAt > MASTER_STAGING_TTL_MS) stagedMasterImports.delete(id)
  }
}

export function mountProductMasterRoutes(app: Express, requireUser: RequestHandler): void {
  // The product master as it stands, with a few sample rows. Read by the Admin screen on load.
  app.get("/api/admin/product-master", requireUser, requireAdmin, async (_req, res, next) => {
    try {
      res.json({ state: await productMasterState(getPool()) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // Header row only. An unchanged download has no SKUs, so it cannot replace the master.
  app.get("/api/admin/product-master/template", requireUser, requireAdmin, (_req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8")
    res.setHeader("Content-Disposition", 'attachment; filename="product-sku-master-template.csv"')
    res.send(productMasterTemplateCsv())
  })

  // What one file holds. Changes nothing.
  app.post(
    "/api/admin/product-master/preview",
    requireUser,
    requireAdmin,
    uploadFile.single("file"),
    async (req, res, next) => {
      try {
        const file = req.file
        if (!file) return res.status(400).json({ error: "Choose a CSV or XLSX file" })
        const scope = await resolveScope(req.body?.marketplace)
        res.json({
          preview: await previewWithInheritedImages(file.buffer, file.originalname, scope),
          filename: file.originalname,
          marketplace: scope,
        })
      } catch (error) {
        sendError(res, error, next)
      }
    },
  )

  // Imports or updates product master mappings.
  // mode="merge" (default): upserts rows preserving all existing mappings.
  // mode="replace": requires explicit confirm=true and replaces the entire master.
  app.post(
    "/api/admin/product-master/import",
    requireUser,
    requireAdmin,
    uploadFile.single("file"),
    async (req, res, next) => {
      try {
        const file = req.file
        if (!file) return res.status(400).json({ error: "Choose a CSV or XLSX file" })
        const mode = String(req.body?.mode || "merge").toLowerCase()
        const confirmed = req.body?.confirm === true || req.body?.confirm === "true"

        if (mode === "replace" && !confirmed) {
          return res.status(409).json({ error: "Confirm that this replaces the whole product master before loading." })
        }

        const scope = await resolveScope(req.body?.marketplace)
        const parsed = parseProductMaster(file.buffer, file.originalname, scope)
        if (parsed.fatal) return res.status(400).json({ error: parsed.fatal })

        const result = mode === "replace"
          ? await replaceProductMaster(getPool(), actorOf(req), parsed.rows, file.originalname)
          : await upsertProductMaster(getPool(), actorOf(req), parsed.rows, file.originalname)

        res.json({ result, state: await productMasterState(getPool()), mode })
      } catch (error) {
        sendError(res, error, next)
      }
    },
  )

  // Unmapped listing SKUs summary
  app.get("/api/admin/product-master/unmapped", requireUser, requireAdmin, async (_req, res, next) => {
    try {
      const summary = await getUnmappedListingSkusSummary(getPool())
      res.json({ unmapped: summary, summary })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // List unmapped listing SKUs with filtering and pagination
  app.get("/api/admin/product-master/unmapped/list", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const marketplace = req.query.marketplace ? String(req.query.marketplace) : undefined
      const search = req.query.search ? String(req.query.search) : undefined
      const status = req.query.status ? String(req.query.status) : undefined
      const page = req.query.page ? parseInt(String(req.query.page), 10) : 1
      const pageSize = req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : 25

      const result = await listUnmappedListingSkus(getPool(), {
        marketplace,
        search,
        status,
        page,
        pageSize,
      })
      res.json(result)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // Download missing listing SKUs formatted for Product Master upload
  app.get("/api/admin/product-master/unmapped/download", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const marketplace = req.query.marketplace ? String(req.query.marketplace) : undefined
      const csv = await generateUnmappedSkusTemplateCsv(getPool(), marketplace)
      const filename = marketplace && marketplace !== "all" && marketplace !== "All marketplaces"
        ? `unmapped-skus-${marketplace.toLowerCase().replace(/\s+/g, "-")}.csv`
        : "unmapped-listing-skus.csv"
      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      res.send(csv)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // Refresh and scan for unmapped SKUs across return items
  app.post("/api/admin/product-master/unmapped/refresh", requireUser, requireAdmin, async (_req, res, next) => {
    try {
      const count = await refreshUnmappedListingSkus(getPool())
      const summary = await getUnmappedListingSkusSummary(getPool())
      res.json({ count, unmapped: summary, summary })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // Stages one product-master file for batched import. Parses once and keeps the rows in memory for 15 minutes;
  // nothing is written yet. The preview is recomputed from the same buffer (double parse is deliberate), so a
  // stale client preview can never decide what is stored.
  // mode="merge" (default): upserts rows preserving all existing mappings.
  // mode="replace": requires explicit confirm=true and replaces the whole master across the batches.
  app.post(
    "/api/admin/product-master/import/start",
    requireUser,
    requireAdmin,
    uploadFile.single("file"),
    async (req, res, next) => {
      try {
        const file = req.file
        if (!file) return res.status(400).json({ error: "Choose a CSV or XLSX file" })
        const mode = String(req.body?.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge"
        const confirmed = req.body?.confirm === true || req.body?.confirm === "true"

        if (mode === "replace" && !confirmed) {
          return res.status(409).json({ error: "Confirm that this replaces the whole product master before loading." })
        }

        const scope = await resolveScope(req.body?.marketplace)
        const parsed = parseProductMaster(file.buffer, file.originalname, scope)
        if (parsed.fatal) return res.status(400).json({ error: parsed.fatal })
        if (!parsed.rows.length) {
          return res.status(400).json({ error: "No row has both a listing SKU and a product SKU. Nothing was loaded." })
        }

        const now = Date.now()
        forgetExpiredMasterImports(now)
        const uploadId = crypto.randomUUID()
        stagedMasterImports.set(uploadId, {
          rows: parsed.rows,
          filename: file.originalname,
          scope,
          mode,
          ownerId: actorOf(req).id,
          createdAt: now,
          processed: 0,
          inserted: 0,
          removed: 0,
          replaced: false,
          imagesFilled: 0,
        })

        res.json({
          uploadId,
          total: parsed.rows.length,
          filename: file.originalname,
          marketplace: scope,
          mode,
          preview: await previewWithInheritedImages(file.buffer, file.originalname, scope),
        })
      } catch (error) {
        sendError(res, error, next)
      }
    },
  )

  // Commits the next batch of a staged product-master import: at most 500 rows in one transaction, then one
  // commit. Merge mode upserts the chunk; replace mode DELETEs product_master once on the first batch
  // (tracked by the staged replaced flag) and then inserts each chunk. History tables are never touched.
  // Progress calls return {uploadId, processed, total, done, batchInserted}. The final call also writes ONE
  // audit row and returns {result, state}.
  app.post("/api/admin/product-master/import/batch", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const ownerId = actorOf(req).id
      const uploadId = String(req.body?.uploadId || "")
      const entry = requireStagedMasterImport(stagedMasterImports, uploadId, ownerId)
      const { chunk, nextProcessed } = takeMasterBatch(entry.rows, entry.processed, req.body?.limit)
      const total = entry.rows.length
      const isReplace = entry.mode === "replace"

      const client = await getPool().connect()
      let batchInserted = 0
      let removed = entry.removed
      let didReplace = false
      let workingChunk = chunk
      let inheritedRows: typeof entry.rows | null = null
      let filledFromInherit = 0
      let filledFromPaste = 0
      try {
        await client.query("BEGIN")
        if (isReplace && !entry.replaced) {
          const donors = await loadStoredMasterImages(client, entry.rows.map((row) => row.masterSku))
          const ready = inheritBlankMasterImages(entry.rows, donors)
          filledFromInherit = inheritedImageCount(entry.rows, ready)
          inheritedRows = ready
          workingChunk = ready.slice(entry.processed, entry.processed + chunk.length)
          const deleted = await client.query("DELETE FROM product_master")
          removed = deleted.rowCount ?? 0
          didReplace = true
        }
        batchInserted = isReplace ? await insertMasterRows(client, workingChunk) : await upsertMasterRows(client, workingChunk)
        filledFromPaste = await pasteBlankMasterImages(client, workingChunk.map((row) => row.masterSku))
        await markUnmappedListingSkusMapped(client)
        const done = nextProcessed >= total
        const imagesFilled = entry.imagesFilled + filledFromInherit + filledFromPaste
        if (done) {
          if (isReplace) {
            await writeAudit(client, ownerId, "product_master.replace", "product_master", "all", {
              filename: entry.filename,
              rows: total,
              removed,
              imagesFilled,
            })
          } else {
            await writeAudit(client, ownerId, "product_master.upsert", "product_master", "all", {
              filename: entry.filename,
              rows: total,
              affected: entry.inserted + batchInserted,
              imagesFilled,
            })
          }
        }
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }

      if (inheritedRows) entry.rows = inheritedRows
      entry.imagesFilled += filledFromInherit + filledFromPaste

      if (didReplace) {
        entry.removed = removed
        entry.replaced = true
      }
      entry.processed = nextProcessed
      entry.inserted += batchInserted

      const done = entry.processed >= total
      if (!done) {
        return res.json({ uploadId, processed: entry.processed, total, done: false, batchInserted })
      }
      const result = isReplace
        ? { inserted: entry.inserted, removed: entry.removed, imagesFilled: entry.imagesFilled }
        : { inserted: entry.inserted, imagesFilled: entry.imagesFilled }
      stagedMasterImports.delete(uploadId)
      res.json({
        uploadId,
        processed: entry.processed,
        total,
        done: true,
        batchInserted,
        result,
        state: await productMasterState(getPool()),
      })
    } catch (error) {
      sendError(res, error, next)
    }
  })
}
