// VMS catalogue inspection and sync into product_master.
//
// The VMS database is a read-only catalogue source: every query goes through
// queryVmsReadOnly (server/vms/db.ts), which refuses write-shaped SQL and runs
// inside BEGIN READ ONLY. Nothing in this module can edit or delete VMS data.
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

export type VmsCatalogueSample = {
  table: string
  rows: number
  withImage: number
  withoutImage: number
  blankSku: number
  marketplaces: { marketplace: string; rows: number }[]
  sample: { sku: string; title: string; imageHost: string; marketplace: string }[]
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

export type VmsCatalogueRow = { sku: string; imageUrl: string; marketplace: string }

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
  matchedListings: number
  blankImagesFilled: number
  alreadyHaveImage: number
  vmsOnly: number
  masterRows: number
  masterImageless: number
}

export type VmsApplyResult = VmsDryRun & { imagesFilled: number; runId: number }

// Reads the VMS sku_photos catalogue (read-only): the channel listing SKU, its
// image link and its marketplace scope. Rows with a blank SKU are dropped;
// image links that are not http(s) are left blank, never repaired.
export async function readVmsCatalogue(): Promise<VmsCatalogueRow[]> {
  const result = await queryVmsReadOnly<{ sku: string; image_url: string; marketplace: string }>(
    `SELECT sku, COALESCE(image_url, '') AS image_url, COALESCE(marketplace, '') AS marketplace
     FROM sku_photos
     ORDER BY sku`,
  )
  const rows: VmsCatalogueRow[] = []
  for (const entry of result.rows) {
    const sku = cleanVmsSku(entry.sku)
    if (!sku) continue
    rows.push({ sku, imageUrl: cleanVmsImageUrl(entry.image_url), marketplace: String(entry.marketplace || "") })
  }
  return rows
}

// Compares the VMS catalogue against the local product_master without writing
// anything. A VMS row matches when its SKU equals a stored listing SKU; only
// stored rows with a blank image link would be filled. Counts only — no SKU
// values are returned.
export async function dryRunVmsCatalogue(db: pg.Pool): Promise<VmsDryRun> {
  const vmsRows = await readVmsCatalogue()
  // Same image-having-only map the apply path fills from: one read, one rule.
  const bySku = dedupeVmsRows(vmsRows)
  const master = await db.query<{ rows: string; imageless: string }>(
    `SELECT COUNT(*)::text AS rows,
            COUNT(*) FILTER (WHERE COALESCE(image_url, '') = '')::text AS imageless
     FROM product_master`,
  )
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
    vmsRows: vmsRows.length,
    vmsUsable: bySku.size,
    matchedListings: matched,
    blankImagesFilled: blank,
    alreadyHaveImage: matched - blank,
    vmsOnly: bySku.size - matched,
    masterRows: Number(master.rows[0]?.rows ?? 0),
    masterImageless: Number(master.rows[0]?.imageless ?? 0),
  }
}

// Fills blank product_master image links from the VMS catalogue (read-only
// source). Merge-only: existing rows are updated where the stored image is
// blank, matched by listing SKU (case-insensitive). Nothing is created (a VMS
// SKU without a stored listing row needs the listing→product mapping first,
// which still comes from the product master file or OMSGuru), nothing is
// deleted, and stored product SKUs, categories and non-blank images are never
// touched. Each run writes one row to vms_catalog_sync_runs.
export async function applyVmsCatalogue(db: pg.Pool): Promise<VmsApplyResult> {
  const started = await db.query<{ id: number }>(
    `INSERT INTO vms_catalog_sync_runs (status) VALUES ('running') RETURNING id`,
  )
  const runId = Number(started.rows[0].id)
  const finish = async (status: string, stats: Partial<VmsDryRun> & { imagesFilled?: number }, error = "") => {
    await db.query(
      `UPDATE vms_catalog_sync_runs
       SET finished_at = now(), status = $2, vms_rows = $3, matched_listings = $4,
           images_filled = $5, vms_only = $6, error = $7
       WHERE id = $1`,
      [
        runId,
        status,
        stats.vmsRows ?? 0,
        stats.matchedListings ?? 0,
        stats.imagesFilled ?? 0,
        stats.vmsOnly ?? 0,
        error.slice(0, 500),
      ],
    )
  }
  try {
    const vmsRows = await readVmsCatalogue()
    const bySku = dedupeVmsRows(vmsRows)
    const dry = await dryRunVmsCatalogue(db)
    // imagesFilled counts updated rows (a listing SKU can repeat across
    // marketplace scopes); matchedListings counts distinct matched keys.
    let imagesFilled = 0
    for (const chunk of buildFillChunks(bySku)) {
      const updated = await db.query(chunk.sql, chunk.values)
      imagesFilled += updated.rowCount ?? 0
    }
    await finish("done", { ...dry, imagesFilled })
    return { ...dry, imagesFilled, runId }
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

// Reads a small, masked sample of the VMS sku_photos catalogue: value SKUs and
// titles are business data (the point of the sync), but image links are reduced
// to their host and no credential-adjacent table (e.g. users) is ever read.
export async function sampleVmsCatalogue(): Promise<VmsCatalogueSample> {
  try {
    return await sampleVmsCatalogueInner()
  } catch {
    throw new Error(
      "Could not read the VMS catalogue sample (expected table sku_photos with columns sku, title, image_url, marketplace, updated_at).",
    )
  }
}

async function sampleVmsCatalogueInner(): Promise<VmsCatalogueSample> {
  const table = "sku_photos"
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
    table,
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
  }
}
