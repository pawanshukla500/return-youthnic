// Administrator routes for the VB EXPORT product master (product_master). Every route needs the Admin role.
//
// /preview reads one file and reports what it holds. /import re-reads the same file and either merges/upserts (default)
// or replaces the whole master in one transaction. The file is parsed again on import, so a stale preview cannot decide
// what is stored. The image link in this file wins over the OMSGuru catalog image when a return file is activated
// (server/lookup-import.ts).

import type { Express, RequestHandler } from "express"
import multer from "multer"
import { getPool } from "./db.js"
import { actorOf, requireAdmin, sendError } from "./http.js"
import {
  productMasterState,
  replaceProductMaster,
  upsertProductMaster,
  getUnmappedListingSkusSummary,
  listUnmappedListingSkus,
  generateUnmappedSkusTemplateCsv,
  refreshUnmappedListingSkus,
} from "./product-master.js"
import { ServiceError } from "./register-service.js"
import { parseProductMaster, previewProductMaster, productMasterTemplateCsv } from "./sheets.js"

const uploadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

// The scope the loaded rows are stored under. Empty or "all" means every account. A named scope must be a real
// account, so a typo cannot silently store rows that never match a scan.
async function resolveScope(raw: unknown): Promise<string> {
  const name = String(raw ?? "").trim()
  if (!name || name.toLowerCase() === "all" || name.toLowerCase() === "all marketplaces") return ""
  const result = await getPool().query("SELECT 1 FROM marketplaces WHERE lower(name) = lower($1)", [name])
  if (!result.rows[0]) throw new ServiceError(400, "Choose a connected marketplace, or All marketplaces.")
  return name
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
          preview: previewProductMaster(file.buffer, file.originalname, scope),
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
}
