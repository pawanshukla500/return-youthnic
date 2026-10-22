// VMS catalogue inspection and sync into product_master.
//
// The VMS database is a read-only catalogue source: every query goes through
// queryVmsReadOnly (server/vms/db.ts), which refuses write-shaped SQL and runs
// inside BEGIN READ ONLY. Nothing in this module can edit or delete VMS data.
//
// Supports:
//   - omsguru_listings: channel listing SKU, linked product master SKU, category, image & marketplace scope
//   - sku_images: high-resolution catalog photos (especially for Amazon and multi-channel listings)
//   - sku_photos: legacy/existing photo catalogue
//
// Mapping rule (same spirit as the file-header rule): column names are taken
// from the inspected VMS schema only — never guessed. Run the probe first:
//   npm run sync:vms-catalog -- --probe

import type pg from "pg"
import { isVmsConfigured, queryVmsReadOnly } from "./db.js"

export type VmsTableInfo = {
  schema: string
  table: string
  estimatedRows: number
  columns: { name: string; type: string }[]
}

export type VmsProbeResult = {
  ok: boolean
  database: string
  tables: VmsTableInfo[]
  error?: string
}

export type VmsListingRow = {
  listingSku: string
  masterSku: string
  category: string
  imageUrl: string
  marketplace: string
}

export type VmsImageRow = {
  sku: string
  imageUrl: string
  marketplace: string
}

export type VmsCatalogueRow = {
  sku: string
  imageUrl: string
  marketplace: string
}

export type VmsCatalogueSample = {
  table: string
  rows: number
  withImage: number
  withoutImage: number
  blankSku: number
  marketplaces: { marketplace: string; rows: number }[]
  sample: { sku: string; title: string; imageHost: string; marketplace: string; masterSku?: string; category?: string }[]
  hasListingsTable?: boolean
  listingsSample?: { listingSku: string; masterSku: string; category: string; imageHost: string; marketplace: string }[]
}

// Keep an http(s) image link, else blank. A present-but-invalid link is left
// blank, never repaired — the same rule the product-master file load follows.
export function cleanVmsImageUrl(raw: unknown): string {
  const value = String(raw ?? "").trim()
  if (!/^https?:\/\//i.test(value)) return ""
  if (value.length > 500) return ""
  if (/^(https?:\/\/[^/]*@|https?:\/\/\d+\.\d+\.\d+\.\d+)/i.test(value)) return ""
  try {
    const parsed = new URL(value)
    if (!parsed.hostname) return ""
  } catch {
    return ""
  }
  return value
}

export function cleanVmsSku(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, 120)
}

export function cleanVmsCategory(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 100)
}

// Canonical marketplace mapping: Amazon, Flipkart, Meesho, Myntra VB, Myntra EJ, Ajio, Shopify, or 'all'.
export function normalizeVmsMarketplace(raw: unknown): string {
  const value = String(raw ?? "").trim()
  if (!value) return "all"
  const lower = value.toLowerCase().replace(/[-_]+/g, " ")
  if (lower.includes("myntra vb")) return "Myntra VB"
  if (lower.includes("myntra ej")) return "Myntra EJ"
  if (lower.includes("myntra")) return "all" // ambiguous between VB and EJ
  if (lower.includes("amazon")) return "Amazon"
  if (lower.includes("flipkart")) return "Flipkart"
  if (lower.includes("meesho")) return "Meesho"
  if (lower.includes("ajio")) return "Ajio"
  if (lower.includes("shopify")) return "Shopify"
  if (lower === "all" || lower === "global") return "all"
  return value.slice(0, 40)
}

export function pickVmsColumn(available: string[], candidates: string[]): string | null {
  const map = new Map(available.map((c) => [c.toLowerCase(), c]))
  for (const candidate of candidates) {
    const match = map.get(candidate.toLowerCase())
    if (match) return match
  }
  return null
}

// Lists user tables with their columns and estimated row counts. Read-only:
// information_schema + pg_class estimates only, no table data is read.
export async function probeVmsCatalogue(): Promise<VmsProbeResult> {
  if (!isVmsConfigured()) {
    return { ok: false, database: "", tables: [], error: "VMS_DATABASE_URL is not configured." }
  }
  try {
    const tables = await queryVmsReadOnly<{ schema: string; table: string; estimated_rows: string }>(
      `SELECT t.table_schema AS schema, t.table_name AS table,
              (SELECT c.reltuples::bigint FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = t.table_schema AND c.relname = t.table_name) AS estimated_rows
       FROM information_schema.tables t
       WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
         AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_schema, t.table_name`,
    )
    const result: VmsTableInfo[] = []
    for (const entry of tables.rows) {
      const columns = await queryVmsReadOnly<{ name: string; type: string }>(
        `SELECT column_name AS name, data_type AS type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [entry.schema, entry.table],
      )
      result.push({
        schema: String(entry.schema),
        table: String(entry.table),
        estimatedRows: Number(entry.estimated_rows ?? 0),
        columns: columns.rows.map((col) => ({ name: String(col.name), type: String(col.type) })),
      })
    }
    return { ok: true, database: "connected", tables: result }
  } catch {
    // Static message: driver errors can embed the host, which is never printed.
    return { ok: false, database: "", tables: [], error: "Could not read the VMS schema." }
  }
}

// Deduplicates listing mappings: (marketplace, lower(listingSku)), keeping first with image/category.
export function dedupeVmsMappings(rows: VmsListingRow[]): VmsListingRow[] {
  const byKey = new Map<string, VmsListingRow>()
  for (const row of rows) {
    if (!row.listingSku || !row.masterSku) continue
    const key = `${row.marketplace.toLowerCase()}|${row.listingSku.toLowerCase()}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...row })
    } else {
      if (!existing.imageUrl && row.imageUrl) {
        existing.imageUrl = row.imageUrl
      }
      if (!existing.category && row.category) {
        existing.category = row.category
      }
    }
  }
  return [...byKey.values()]
}

// One deterministic image per distinct SKU (lower-cased key, first row wins).
// Pure, so the dedup rule is unit-tested without a database.
export function dedupeVmsRows(rows: VmsCatalogueRow[]): Map<string, string> {
  const bySku = new Map<string, string>()
  for (const row of rows) {
    if (!row.imageUrl) continue
    const key = row.sku.toLowerCase()
    if (!bySku.has(key)) bySku.set(key, row.imageUrl)
  }
  return bySku
}

// Parameterized batch inserter for product_master mappings from omsguru_listings.
// Pure SQL builder, unit-tested without a database.
export function buildMappingInsertChunks(
  rows: VmsListingRow[],
  chunkSize = 500,
): { sql: string; values: unknown[] }[] {
  const chunks: { sql: string; values: unknown[] }[] = []
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize)
    const values: unknown[] = []
    const groups = chunk.map((r) => {
      const base = values.length
      values.push(
        r.marketplace,
        r.listingSku,
        r.masterSku,
        r.category || null,
        r.imageUrl || "",
      )
      return `($${base + 1}::text, $${base + 2}::text, $${base + 3}::text, $${base + 4}::text, NULL::numeric, NULL::numeric, $${base + 5}::text, now())`
    })
    chunks.push({
      sql: `INSERT INTO product_master (marketplace, listing_sku, master_sku, category, cogs, weight_slab, image_url, updated_at)
         VALUES ${groups.join(", ")}
         ON CONFLICT (marketplace, listing_sku) DO UPDATE SET
           master_sku = CASE WHEN btrim(COALESCE(product_master.master_sku, '')) = '' THEN EXCLUDED.master_sku ELSE product_master.master_sku END,
           category = COALESCE(NULLIF(EXCLUDED.category, ''), product_master.category),
           image_url = CASE WHEN btrim(COALESCE(product_master.image_url, '')) = '' AND EXCLUDED.image_url <> '' THEN EXCLUDED.image_url ELSE product_master.image_url END,
           updated_at = now()`,
      values,
    })
  }
  return chunks
}

// One UPDATE chunk per call: fills blank product_master image links matched by
// listing SKU (case-insensitive). Pure SQL builder, unit-tested without a database.
export function buildFillChunks(
  imageByKey: Map<string, string>,
  chunkSize = 500,
): { sql: string; values: unknown[] }[] {
  const keys = [...imageByKey.keys()]
  const chunks: { sql: string; values: unknown[] }[] = []
  for (let start = 0; start < keys.length; start += chunkSize) {
    const chunk = keys.slice(start, start + chunkSize)
    const values: unknown[] = []
    const groups = chunk.map((key) => {
      const base = values.length
      values.push(key, imageByKey.get(key))
      return `($${base + 1}::text, $${base + 2}::text)`
    })
    chunks.push({
      sql: `UPDATE product_master pm
         SET image_url = staged.image_url, updated_at = now()
         FROM (VALUES ${groups.join(", ")}) AS staged(sku, image_url)
         WHERE LOWER(pm.listing_sku) = staged.sku
           AND COALESCE(pm.image_url, '') = ''`,
      values,
    })
  }
  return chunks
}

export type VmsDryRun = {
  vmsRows: number
  vmsUsable: number
  vmsMappings: number
  mappingsToInsert: number
  matchedListings: number
  blankImagesFilled: number
  alreadyHaveImage: number
  vmsOnly: number
  masterRows: number
  masterImageless: number
}

export type VmsApplyResult = VmsDryRun & {
  imagesFilled: number
  mappingsCreated: number
  runId: number
}

// Reads channel listing SKUs, master SKUs, categories and image URLs from VMS omsguru_listings.
// Strictly read-only; dynamically adapts to the exact columns present in VMS.
export async function readVmsListings(): Promise<VmsListingRow[]> {
  try {
    const checkTable = await queryVmsReadOnly<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
           AND table_name = 'omsguru_listings'
       ) AS exists`,
    )
    if (!checkTable.rows[0]?.exists) return []

    const colsRes = await queryVmsReadOnly<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'omsguru_listings'`,
    )
    const cols = colsRes.rows.map((r) => r.column_name)
    const listingCol = pickVmsColumn(cols, [
      "channel_sku",
      "listing_sku",
      "sku_name",
      "channel_listing_sku_code",
      "channel_listing_sku",
      "channel_listing_id",
      "sku",
      "item_sku_code",
    ])
    const masterCol = pickVmsColumn(cols, [
      "master_sku",
      "product_sku",
      "sku_code",
      "product_sku_code",
      "product_skucode",
      "parent_sku",
      "oms_sku_code",
    ])
    if (!listingCol || !masterCol) return []

    const catCol = pickVmsColumn(cols, ["category", "product_category", "category_name"])
    const imgCol = pickVmsColumn(cols, ["image_url", "image_link", "image", "photo_url", "view_photo"])
    const mpCol = pickVmsColumn(cols, ["marketplace", "channel_name", "channel", "channel_company_name", "account"])

    const selectParts = [
      `COALESCE(btrim(${listingCol}::text), '') AS listing_sku`,
      `COALESCE(btrim(${masterCol}::text), '') AS master_sku`,
      catCol ? `COALESCE(btrim(${catCol}::text), '') AS category` : `''::text AS category`,
      imgCol ? `COALESCE(btrim(${imgCol}::text), '') AS image_url` : `''::text AS image_url`,
      mpCol ? `COALESCE(btrim(${mpCol}::text), '') AS marketplace` : `''::text AS marketplace`,
    ]

    const sql = `SELECT ${selectParts.join(", ")} FROM omsguru_listings WHERE ${listingCol} IS NOT NULL AND btrim(${listingCol}::text) <> '' AND ${masterCol} IS NOT NULL AND btrim(${masterCol}::text) <> ''`
    const res = await queryVmsReadOnly<{
      listing_sku: string
      master_sku: string
      category: string
      image_url: string
      marketplace: string
    }>(sql)

    const list: VmsListingRow[] = []
    for (const r of res.rows) {
      const listingSku = cleanVmsSku(r.listing_sku)
      const masterSku = cleanVmsSku(r.master_sku)
      if (!listingSku || !masterSku) continue
      list.push({
        listingSku,
        masterSku,
        category: cleanVmsCategory(r.category),
        imageUrl: cleanVmsImageUrl(r.image_url),
        marketplace: normalizeVmsMarketplace(r.marketplace),
      })
    }
    return dedupeVmsMappings(list)
  } catch {
    return []
  }
}

// Reads high-resolution images from VMS sku_images table (useful for Amazon and other marketplaces).
export async function readVmsSkuImages(): Promise<VmsImageRow[]> {
  try {
    const checkTable = await queryVmsReadOnly<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
           AND table_name = 'sku_images'
       ) AS exists`,
    )
    if (!checkTable.rows[0]?.exists) return []

    const colsRes = await queryVmsReadOnly<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'sku_images'`,
    )
    const cols = colsRes.rows.map((r) => r.column_name)
    const skuCol = pickVmsColumn(cols, [
      "sku",
      "listing_sku",
      "sku_code",
      "channel_sku",
      "item_sku_code",
    ])
    const imgCol = pickVmsColumn(cols, [
      "image_url",
      "image_link",
      "image",
      "photo_url",
      "url",
    ])
    if (!skuCol || !imgCol) return []

    const mpCol = pickVmsColumn(cols, ["marketplace", "channel_name", "channel"])
    const selectParts = [
      `COALESCE(btrim(${skuCol}::text), '') AS sku`,
      `COALESCE(btrim(${imgCol}::text), '') AS image_url`,
      mpCol ? `COALESCE(btrim(${mpCol}::text), '') AS marketplace` : `''::text AS marketplace`,
    ]

    const sql = `SELECT ${selectParts.join(", ")} FROM sku_images WHERE ${skuCol} IS NOT NULL AND btrim(${skuCol}::text) <> '' AND ${imgCol} IS NOT NULL AND btrim(${imgCol}::text) <> ''`
    const res = await queryVmsReadOnly<{
      sku: string
      image_url: string
      marketplace: string
    }>(sql)

    const list: VmsImageRow[] = []
    for (const r of res.rows) {
      const sku = cleanVmsSku(r.sku)
      const imageUrl = cleanVmsImageUrl(r.image_url)
      if (!sku || !imageUrl) continue
      list.push({
        sku,
        imageUrl,
        marketplace: normalizeVmsMarketplace(r.marketplace),
      })
    }
    return list
  } catch {
    return []
  }
}

// Reads all catalogue images from VMS (combines sku_photos, sku_images, and omsguru_listings).
export async function readVmsCatalogue(): Promise<VmsCatalogueRow[]> {
  const rows: VmsCatalogueRow[] = []

  // 1. Existing sku_photos (backwards-compatible)
  try {
    const result = await queryVmsReadOnly<{ sku: string; image_url: string; marketplace: string }>(
      `SELECT sku, COALESCE(image_url, '') AS image_url, COALESCE(marketplace, '') AS marketplace
       FROM sku_photos
       ORDER BY sku`,
    )
    for (const entry of result.rows) {
      const sku = cleanVmsSku(entry.sku)
      if (!sku) continue
      rows.push({
        sku,
        imageUrl: cleanVmsImageUrl(entry.image_url),
        marketplace: normalizeVmsMarketplace(entry.marketplace),
      })
    }
  } catch {
    // sku_photos table might not exist in this environment
  }

  // 2. sku_images (e.g. Amazon marketplace images)
  const skuImages = await readVmsSkuImages()
  for (const img of skuImages) {
    rows.push({
      sku: img.sku,
      imageUrl: img.imageUrl,
      marketplace: img.marketplace,
    })
  }

  // 3. Images from omsguru_listings
  const listings = await readVmsListings()
  for (const l of listings) {
    if (l.imageUrl) {
      rows.push({
        sku: l.listingSku,
        imageUrl: l.imageUrl,
        marketplace: l.marketplace,
      })
    }
  }

  return rows
}

// Compares the VMS catalogue against local product_master without writing anything.
export async function dryRunVmsCatalogue(db: pg.Pool): Promise<VmsDryRun> {
  const listings = await readVmsListings()
  const dedupedMappings = dedupeVmsMappings(listings)
  const vmsRows = await readVmsCatalogue()
  const bySku = dedupeVmsRows(vmsRows)

  const master = await db.query<{ rows: string; imageless: string }>(
    `SELECT COUNT(*)::text AS rows,
            COUNT(*) FILTER (WHERE COALESCE(image_url, '') = '')::text AS imageless
     FROM product_master`,
  )

  let mappingsToInsert = 0
  if (dedupedMappings.length) {
    const existingMappings = await db.query<{ marketplace: string; listing_sku: string }>(
      `SELECT LOWER(marketplace) AS marketplace, LOWER(listing_sku) AS listing_sku
       FROM product_master`,
    )
    const existingSet = new Set(
      existingMappings.rows.map((r) => `${r.marketplace}|${r.listing_sku}`),
    )
    for (const m of dedupedMappings) {
      if (!existingSet.has(`${m.marketplace.toLowerCase()}|${m.listingSku.toLowerCase()}`)) {
        mappingsToInsert++
      }
    }
  }

  const keys = [...bySku.keys()]
  let matched = 0
  let blank = 0
  if (keys.length) {
    const found = await db.query<{ listing_sku: string; image_url: string }>(
      `SELECT listing_sku, COALESCE(image_url, '') AS image_url
       FROM product_master WHERE LOWER(listing_sku) = ANY($1::text[])`,
      [keys],
    )
    const seen = new Set<string>()
    for (const entry of found.rows) {
      const key = String(entry.listing_sku).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      matched++
      if (!entry.image_url) blank++
    }
  }

  return {
    vmsRows: vmsRows.length + listings.length,
    vmsUsable: bySku.size,
    vmsMappings: dedupedMappings.length,
    mappingsToInsert,
    matchedListings: matched,
    blankImagesFilled: blank,
    alreadyHaveImage: matched - blank,
    vmsOnly: bySku.size - matched,
    masterRows: Number(master.rows[0]?.rows ?? 0),
    masterImageless: Number(master.rows[0]?.imageless ?? 0),
  }
}

// Synchronizes VMS catalogue into product_master:
// 1. Inserts new channel listing -> master SKU mappings from omsguru_listings.
// 2. Fills blank image links using sku_images and sku_photos.
// 3. Merges safely (never overwrites non-empty images or existing master SKUs).
// 4. Writes one log row to vms_catalog_sync_runs.
export async function applyVmsCatalogue(db: pg.Pool): Promise<VmsApplyResult> {
  const started = await db.query<{ id: number }>(
    `INSERT INTO vms_catalog_sync_runs (status) VALUES ('running') RETURNING id`,
  )
  const runId = Number(started.rows[0].id)
  const finish = async (
    status: string,
    stats: Partial<VmsDryRun> & { imagesFilled?: number; mappingsCreated?: number },
    error = "",
  ) => {
    await db.query(
      `UPDATE vms_catalog_sync_runs
       SET finished_at = now(), status = $2, vms_rows = $3, matched_listings = $4,
           images_filled = $5, vms_only = $6, error = $7, mappings_created = $8
       WHERE id = $1`,
      [
        runId,
        status,
        stats.vmsRows ?? 0,
        stats.matchedListings ?? 0,
        stats.imagesFilled ?? 0,
        stats.vmsOnly ?? 0,
        error.slice(0, 500),
        stats.mappingsCreated ?? 0,
      ],
    )
  }
  try {
    const listings = await readVmsListings()
    const dedupedMappings = dedupeVmsMappings(listings)
    const vmsRows = await readVmsCatalogue()
    const bySku = dedupeVmsRows(vmsRows)
    const dry = await dryRunVmsCatalogue(db)

    let mappingsCreated = 0
    // 1. Insert/update product_master mappings from omsguru_listings
    for (const chunk of buildMappingInsertChunks(dedupedMappings)) {
      const inserted = await db.query(chunk.sql, chunk.values)
      mappingsCreated += inserted.rowCount ?? 0
    }

    // 2. Fill blank image links from sku_images and sku_photos
    let imagesFilled = 0
    for (const chunk of buildFillChunks(bySku)) {
      const updated = await db.query(chunk.sql, chunk.values)
      imagesFilled += updated.rowCount ?? 0
    }

    await finish("done", { ...dry, imagesFilled, mappingsCreated })
    return { ...dry, imagesFilled, mappingsCreated, runId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await finish("failed", {}, message)
    } catch {
      // The run-row write itself failed; the original error is what matters.
    }
    throw err
  }
}

// Reads masked samples of VMS catalogue (omsguru_listings, sku_images, sku_photos).
// Business data (SKUs and categories) is visible; image links are reduced to hostnames.
export async function sampleVmsCatalogue(): Promise<VmsCatalogueSample> {
  const listings = await readVmsListings()
  const listingsSample = listings.slice(0, 8).map((l) => {
    let host = ""
    try {
      host = new URL(l.imageUrl).hostname
    } catch {
      host = l.imageUrl.slice(0, 40)
    }
    return {
      listingSku: l.listingSku,
      masterSku: l.masterSku,
      category: l.category,
      imageHost: host,
      marketplace: l.marketplace,
    }
  })

  // Try sku_photos
  try {
    const counts = await queryVmsReadOnly<{ rows: string; with_image: string; blank_sku: string }>(
      `SELECT COUNT(*)::text AS rows,
              COUNT(*) FILTER (WHERE NULLIF(image_url, '') IS NOT NULL)::text AS with_image,
              COUNT(*) FILTER (WHERE NULLIF(sku, '') IS NULL)::text AS blank_sku
       FROM sku_photos`,
    )
    const scopes = await queryVmsReadOnly<{ marketplace: string; rows: string }>(
      `SELECT COALESCE(NULLIF(marketplace, ''), '') AS marketplace, COUNT(*)::text AS rows
       FROM sku_photos GROUP BY 1 ORDER BY 2 DESC, 1`,
    )
    const sample = await queryVmsReadOnly<{ sku: string; title: string; image_url: string; marketplace: string }>(
      `SELECT sku, COALESCE(title, '') AS title, COALESCE(image_url, '') AS image_url,
              COALESCE(marketplace, '') AS marketplace
       FROM sku_photos ORDER BY updated_at DESC NULLS LAST, sku LIMIT 8`,
    )
    const row = counts.rows[0]
    return {
      table: "sku_photos",
      rows: Number(row?.rows ?? 0),
      withImage: Number(row?.with_image ?? 0),
      withoutImage: Number(row?.rows ?? 0) - Number(row?.with_image ?? 0),
      blankSku: Number(row?.blank_sku ?? 0),
      marketplaces: scopes.rows.map((entry) => ({
        marketplace: String(entry.marketplace),
        rows: Number(entry.rows),
      })),
      sample: sample.rows.map((entry) => {
        let host = ""
        try {
          host = new URL(String(entry.image_url)).hostname
        } catch {
          host = String(entry.image_url).slice(0, 40)
        }
        return {
          sku: String(entry.sku),
          title: String(entry.title).slice(0, 80),
          imageHost: host,
          marketplace: String(entry.marketplace),
        }
      }),
      hasListingsTable: listings.length > 0,
      listingsSample,
    }
  } catch {
    // If sku_photos is not present, use omsguru_listings or sku_images
    return {
      table: "omsguru_listings",
      rows: listings.length,
      withImage: listings.filter((l) => l.imageUrl).length,
      withoutImage: listings.filter((l) => !l.imageUrl).length,
      blankSku: 0,
      marketplaces: [],
      sample: listingsSample.map((l) => ({
        sku: l.listingSku,
        title: l.category,
        imageHost: l.imageHost,
        marketplace: l.marketplace,
        masterSku: l.masterSku,
        category: l.category,
      })),
      hasListingsTable: listings.length > 0,
      listingsSample,
    }
  }
}
