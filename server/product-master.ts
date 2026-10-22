// The VB EXPORT product master (product_master): a channel listing SKU to a product SKU, with its category and the
// channel image link. This is configuration data, loaded by an administrator from the Admin "Product SKU master" tab
// or by the CLI (server/scripts/load-product-master.ts).
//
// Loading can either MERGE/UPSERT (default and recommended, preserving all existing master rows) or REPLACE the whole
// table in one transaction. The image link from this file wins over the OMSGuru catalog image when a return file is
// activated (server/lookup-import.ts).
//
// Parsing and the preview summary are pure and live in server/sheets.ts.

import type pg from "pg"
import { formatUploadLabel, toIsoTimestamp } from "./format.js"
import { compactSkuKey, listingSkuCandidates, marketplaceRank } from "./marketplace-rules.js"
import { bridgeMasterMappings } from "./oms/master-bridge.js"
import { ServiceError, writeAudit, type Actor } from "./register-service.js"
import type { MasterRow } from "./sheets.js"
import { applyVmsCatalogue } from "./vms/catalog.js"
import { isVmsConfigured } from "./vms/db.js"

// Candidate-aware unmapped-queue resolution. Mirrors scan-time lookup
// (masterSkusForListings in server/lookup-import.ts): a queue row resolves when ANY
// candidate of its listing SKU (exact first, then spaceless form, then parent
// article-suffix form via listingSkuCandidates) hits a stored master candidate for
// the same account, or for the 'all'/blank scope fallback. marketplaceRank covers
// the generic-scope case (e.g. "myntra" for "Myntra VB"); exact and 'all' hit via a
// fast hash lookup, generic scopes via a rank-checked scan only when needed.
export function unmappedIsResolved(
  listingSku: string,
  marketplace: string,
  masterKeys: Set<string>,
): boolean {
  const account = (marketplace ?? "").trim().toLowerCase()
  const exact = (listingSku ?? "").trim()
  if (!exact || !account) return false
  const candidates = listingSkuCandidates(exact).map((c) => compactSkuKey(c))
  if (!candidates.length) return false
  for (const cand of candidates) {
    if (masterKeys.has(`${account}|${cand}`)) return true
    if (masterKeys.has(`all|${cand}`)) return true
    if (masterKeys.has(`|${cand}`)) return true
  }
  const wanted = new Set(candidates)
  for (const key of masterKeys) {
    const sep = key.indexOf("|")
    if (sep < 0) continue
    const scope = key.slice(0, sep)
    if (scope === account || scope === "all" || scope === "") continue
    if (!wanted.has(key.slice(sep + 1))) continue
    if (marketplaceRank(scope, account) > 0) return true
  }
  return false
}

// One query over product_master, candidates expanded in JS. 63k rows fit in memory.
// Key format mirrors lookup: `${marketplaceLower}|${compactCandidateLower}` for every
// candidate of every stored listing.
export async function loadMasterLookupKeys(db: pg.Pool | pg.PoolClient): Promise<Set<string>> {
  const res = await db.query("SELECT marketplace, listing_sku FROM product_master")
  const keys = new Set<string>()
  for (const row of res.rows) {
    const scope = String(row.marketplace ?? "").trim().toLowerCase()
    const listing = String(row.listing_sku ?? "")
    for (const candidate of listingSkuCandidates(listing)) {
      keys.add(`${scope}|${compactSkuKey(candidate)}`)
    }
  }
  return keys
}

// Candidate-aware flip shared by every writer. Resolution is decided in JS via
// unmappedIsResolved; SQL stays a set-based exact update keyed on LOWER() equality.
async function flipResolvedUnmappedRows(db: pg.Pool | pg.PoolClient): Promise<void> {
  const masterKeys = await loadMasterLookupKeys(db)
  const unmapped = await db.query(
    "SELECT DISTINCT marketplace, listing_sku FROM unmapped_listing_skus WHERE status = 'unmapped'",
  )
  const resolved: string[] = []
  for (const row of unmapped.rows) {
    const mp = String(row.marketplace ?? "")
    const sku = String(row.listing_sku ?? "")
    if (mp.trim() && sku.trim() && unmappedIsResolved(sku, mp, masterKeys)) {
      resolved.push(`${mp.trim().toLowerCase()}|${sku.trim().toLowerCase()}`)
    }
  }
  if (!resolved.length) return
  await db.query(
    `UPDATE unmapped_listing_skus u
     SET status = 'mapped'
     WHERE u.status = 'unmapped'
       AND (LOWER(u.marketplace) || '|' || LOWER(u.listing_sku)) = ANY($1::text[])`,
    [resolved],
  )
}

const CHUNK = 1000

export type ProductMasterRow = {
  marketplace: string
  listingSku: string
  masterSku: string
  category: string
  imageUrl: string
}

export type ProductMasterState = {
  rows: number
  listings: number
  masters: number
  withImage: number
  lastLoadedAt: string
  marketplaces: { marketplace: string; rows: number }[]
  sample: ProductMasterRow[]
}

// What the product master holds right now. Reads only, so it is safe to call from the Admin screen on load.
export async function productMasterState(db: pg.Pool): Promise<ProductMasterState> {
  const totals = await db.query(
    `SELECT
       COUNT(*)::int AS rows,
       COUNT(DISTINCT listing_sku)::int AS listings,
       COUNT(DISTINCT master_sku)::int AS masters,
       COUNT(*) FILTER (WHERE image_url <> '')::int AS with_image,
       MAX(updated_at) AS last_loaded
     FROM product_master`,
  )
  const accounts = await db.query(
    "SELECT marketplace, COUNT(*)::int AS rows FROM product_master GROUP BY marketplace ORDER BY rows DESC, marketplace",
  )
  const sample = await db.query(
    `SELECT marketplace, listing_sku, master_sku, COALESCE(category, '') AS category, image_url
     FROM product_master
     ORDER BY marketplace, listing_sku
     LIMIT 20`,
  )
  const row = totals.rows[0]
  return {
    rows: Number(row.rows),
    listings: Number(row.listings),
    masters: Number(row.masters),
    withImage: Number(row.with_image),
    lastLoadedAt: row.last_loaded ? formatUploadLabel(new Date(row.last_loaded)) : "Never loaded",
    marketplaces: accounts.rows.map((entry) => ({
      marketplace: String(entry.marketplace),
      rows: Number(entry.rows),
    })),
    sample: sample.rows.map((entry) => ({
      marketplace: String(entry.marketplace),
      listingSku: String(entry.listing_sku),
      masterSku: String(entry.master_sku),
      category: String(entry.category),
      imageUrl: String(entry.image_url),
    })),
  }
}

// Product SKU key used to share one image across listing rows. Case and surrounding space do not make a new product.
export function masterSkuKey(masterSku: string): string {
  return masterSku.trim().toLowerCase()
}

// Fills blank image links from the same product SKU. A link already on the row stays. A link in this file wins over
// one already stored. Stored links are keyed by masterSkuKey.
export function inheritBlankMasterImages<T extends { masterSku: string; imageUrl: string }>(
  rows: readonly T[],
  storedByMasterSku: ReadonlyMap<string, string> = new Map(),
): T[] {
  const fromFile = new Map<string, string>()
  for (const row of rows) {
    const image = row.imageUrl.trim()
    if (!image) continue
    const key = masterSkuKey(row.masterSku)
    if (key && !fromFile.has(key)) fromFile.set(key, image)
  }
  return rows.map((row) => {
    if (row.imageUrl.trim()) return row
    const key = masterSkuKey(row.masterSku)
    if (!key) return row
    const image = fromFile.get(key) || storedByMasterSku.get(key)?.trim() || ""
    if (!image) return row
    return { ...row, imageUrl: image }
  })
}

// How many blank rows gained an image. Rows stay in the same order.
export function inheritedImageCount(
  before: readonly { imageUrl: string }[],
  after: readonly { imageUrl: string }[],
): number {
  let filled = 0
  const count = Math.min(before.length, after.length)
  for (let index = 0; index < count; index++) {
    if (!before[index].imageUrl.trim() && after[index].imageUrl.trim()) filled++
  }
  return filled
}

// Newest stored image for each product SKU in the list. Blank images are ignored.
export async function loadStoredMasterImages(
  db: pg.Pool | pg.PoolClient,
  masterSkus: readonly string[],
): Promise<Map<string, string>> {
  const keys = [...new Set(masterSkus.map(masterSkuKey).filter(Boolean))]
  const images = new Map<string, string>()
  if (!keys.length) return images
  const found = await db.query<{ master_key: string; image_url: string }>(
    `SELECT DISTINCT ON (lower(btrim(master_sku)))
       lower(btrim(master_sku)) AS master_key,
       image_url
     FROM product_master
     WHERE btrim(image_url) <> ''
       AND lower(btrim(master_sku)) = ANY($1::text[])
     ORDER BY lower(btrim(master_sku)), updated_at DESC, listing_sku`,
    [keys],
  )
  for (const row of found.rows) {
    const image = String(row.image_url || "").trim()
    if (image) images.set(String(row.master_key), image)
  }
  return images
}

// Writes a known product-SKU image onto listing rows that are still blank. A saved image is never replaced.
// Pass no list to fill every product SKU that already has an image somewhere in the table.
export async function pasteBlankMasterImages(
  db: pg.Pool | pg.PoolClient,
  masterSkus?: readonly string[],
): Promise<number> {
  const keys = masterSkus ? [...new Set(masterSkus.map(masterSkuKey).filter(Boolean))] : null
  if (keys && !keys.length) return 0
  const updated = await db.query(
    `UPDATE product_master AS blank
     SET image_url = donor.image_url,
         updated_at = now()
     FROM (
       SELECT DISTINCT ON (lower(btrim(master_sku)))
         lower(btrim(master_sku)) AS master_key,
         image_url
       FROM product_master
       WHERE btrim(image_url) <> ''
         AND ($1::text[] IS NULL OR lower(btrim(master_sku)) = ANY($1::text[]))
       ORDER BY lower(btrim(master_sku)), updated_at DESC, listing_sku
     ) AS donor
     WHERE btrim(blank.image_url) = ''
       AND lower(btrim(blank.master_sku)) = donor.master_key`,
    [keys],
  )
  return updated.rowCount ?? 0
}

// Incrementally merges/upserts product master rows without deleting previously loaded data.
// Adds new mappings and updates existing ones on conflict (marketplace, listing_sku).
// A blank image cell is then filled from any other row of the same product SKU that already has a link.
export async function upsertProductMaster(
  db: pg.Pool,
  actor: Actor,
  rows: MasterRow[],
  filename: string,
): Promise<{ inserted: number; total: number; lastLoadedAt: string; imagesFilled: number }> {
  if (!rows.length) {
    throw new ServiceError(400, "No row has both a listing SKU and a product SKU. Nothing was loaded.")
  }
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    let affected = 0
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK)
      const values: unknown[] = []
      const groups = chunk.map((row) => {
        const base = values.length
        values.push(row.marketplace, row.listingSku, row.masterSku, row.category || null, row.cogs, row.weightSlab, row.imageUrl)
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, now())`
      })
      const res = await client.query(
        `INSERT INTO product_master (marketplace, listing_sku, master_sku, category, cogs, weight_slab, image_url, updated_at)
         VALUES ${groups.join(", ")}
         ON CONFLICT (marketplace, listing_sku) DO UPDATE SET
           master_sku = EXCLUDED.master_sku,
           category = COALESCE(NULLIF(EXCLUDED.category, ''), product_master.category),
           image_url = CASE WHEN EXCLUDED.image_url <> '' THEN EXCLUDED.image_url ELSE product_master.image_url END,
           cogs = COALESCE(EXCLUDED.cogs, product_master.cogs),
           weight_slab = COALESCE(EXCLUDED.weight_slab, product_master.weight_slab),
           updated_at = now()`,
        values,
      )
      affected += (res.rowCount ?? 0)
    }
    const imagesFilled = await pasteBlankMasterImages(client, rows.map((row) => row.masterSku))

    await writeAudit(client, actor.id, "product_master.upsert", "product_master", "all", {
      filename,
      rows: rows.length,
      affected,
      imagesFilled,
    })

    // Candidate-aware flip: variant rows (spaceless, parent article-suffix) resolve too.
    await flipResolvedUnmappedRows(client)

    await client.query("COMMIT")
    return { inserted: affected, total: rows.length, lastLoadedAt: formatUploadLabel(), imagesFilled }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// Replaces the whole product master with the rows read from one file. One transaction: if anything fails, the previous
// master stays. The change is audited.
export async function replaceProductMaster(
  db: pg.Pool,
  actor: Actor,
  rows: MasterRow[],
  filename: string,
): Promise<{ inserted: number; removed: number; lastLoadedAt: string; imagesFilled: number }> {
  if (!rows.length) {
    throw new ServiceError(400, "No row has both a listing SKU and a product SKU. Nothing was loaded.")
  }
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const donors = await loadStoredMasterImages(client, rows.map((row) => row.masterSku))
    const ready = inheritBlankMasterImages(rows, donors)
    const imagesFromFile = inheritedImageCount(rows, ready)
    const removed = await client.query("DELETE FROM product_master")
    for (let start = 0; start < ready.length; start += CHUNK) {
      const chunk = ready.slice(start, start + CHUNK)
      const values: unknown[] = []
      const groups = chunk.map((row) => {
        const base = values.length
        values.push(row.marketplace, row.listingSku, row.masterSku, row.category || null, row.cogs, row.weightSlab, row.imageUrl)
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, now())`
      })
      await client.query(
        `INSERT INTO product_master (marketplace, listing_sku, master_sku, category, cogs, weight_slab, image_url, updated_at)
         VALUES ${groups.join(", ")}`,
        values,
      )
    }
    const imagesFilled = imagesFromFile + await pasteBlankMasterImages(client, ready.map((row) => row.masterSku))
    await writeAudit(client, actor.id, "product_master.replace", "product_master", "all", {
      filename,
      rows: rows.length,
      removed: removed.rowCount ?? 0,
      imagesFilled,
    })

    // Candidate-aware flip: variant rows (spaceless, parent article-suffix) resolve too.
    await flipResolvedUnmappedRows(client)

    await client.query("COMMIT")
    return { inserted: rows.length, removed: removed.rowCount ?? 0, lastLoadedAt: formatUploadLabel(), imagesFilled }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export type UnmappedSkuSummary = {
  total: number
  totalUnmapped: number
  pendingResolution: number
  byMarketplace: { marketplace: string; count: number }[]
  sample: { marketplace: string; listingSku: string; lastSeenAt: string; sampleOrderNumber?: string; sampleTrackingId?: string }[]
}

export type UnmappedSkuItem = {
  id: number
  marketplace: string
  listingSku: string
  sampleOrderNumber: string
  sampleTrackingId: string
  firstSeenAt: string
  lastSeenAt: string
  status: string
}

export type UnmappedListResult = {
  items: UnmappedSkuItem[]
  total: number
  page: number
  pageSize: number
}

export async function recordUnmappedListingSkus(
  client: pg.Pool | pg.PoolClient,
  marketplace: string,
  listings: string[],
  sampleOrder = "",
  sampleTracking = "",
): Promise<number> {
  const cleanListings = [...new Set(listings.map((l) => l.trim()).filter(Boolean))]
  if (!cleanListings.length) return 0

  let inserted = 0
  for (const sku of cleanListings) {
    const res = await client.query(
      `INSERT INTO unmapped_listing_skus (marketplace, listing_sku, sample_order_number, sample_tracking_id, last_seen_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (marketplace, listing_sku)
       DO UPDATE SET last_seen_at = now(),
                     sample_order_number = CASE WHEN unmapped_listing_skus.sample_order_number = '' THEN EXCLUDED.sample_order_number ELSE unmapped_listing_skus.sample_order_number END,
                     sample_tracking_id = CASE WHEN unmapped_listing_skus.sample_tracking_id = '' THEN EXCLUDED.sample_tracking_id ELSE unmapped_listing_skus.sample_tracking_id END`,
      [marketplace, sku, sampleOrder, sampleTracking],
    )
    if ((res.rowCount ?? 0) > 0) inserted++
  }
  return inserted
}

export async function getUnmappedListingSkusSummary(db: pg.Pool): Promise<UnmappedSkuSummary> {
  // Sync status against product_master first (candidate-aware: variants resolve too)
  await flipResolvedUnmappedRows(db)

  const totalRes = await db.query(
    "SELECT COUNT(*)::int AS count FROM unmapped_listing_skus WHERE status = 'unmapped'",
  )
  const mpRes = await db.query(
    `SELECT marketplace, COUNT(*)::int AS count
     FROM unmapped_listing_skus
     WHERE status = 'unmapped'
     GROUP BY marketplace
     ORDER BY count DESC, marketplace`,
  )
  const sampleRes = await db.query(
    `SELECT marketplace, listing_sku, last_seen_at, sample_order_number, sample_tracking_id
     FROM unmapped_listing_skus
     WHERE status = 'unmapped'
     ORDER BY last_seen_at DESC, id DESC
     LIMIT 50`,
  )

  const pendingCount = Number(totalRes.rows[0]?.count ?? 0)

  return {
    total: pendingCount,
    totalUnmapped: pendingCount,
    pendingResolution: pendingCount,
    byMarketplace: mpRes.rows.map((r) => ({
      marketplace: String(r.marketplace),
      count: Number(r.count),
    })),
    sample: sampleRes.rows.map((r) => ({
      marketplace: String(r.marketplace),
      listingSku: String(r.listing_sku),
      sampleOrderNumber: String(r.sample_order_number || ""),
      sampleTrackingId: String(r.sample_tracking_id || ""),
      lastSeenAt: toIsoTimestamp(r.last_seen_at),
    })),
  }
}

export async function listUnmappedListingSkus(
  db: pg.Pool,
  options: {
    marketplace?: string
    search?: string
    status?: string
    page?: number
    pageSize?: number
  } = {},
): Promise<UnmappedListResult> {
  const page = Math.max(1, options.page || 1)
  const pageSize = Math.min(100, Math.max(10, options.pageSize || 25))
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: unknown[] = []

  const status = options.status || "unmapped"
  if (status !== "all") {
    params.push(status)
    conditions.push(`status = $${params.length}`)
  }

  if (options.marketplace && options.marketplace !== "all" && options.marketplace !== "All marketplaces") {
    params.push(options.marketplace)
    conditions.push(`LOWER(marketplace) = LOWER($${params.length})`)
  }

  if (options.search && options.search.trim()) {
    params.push(`%${options.search.trim()}%`)
    conditions.push(`(listing_sku ILIKE $${params.length} OR sample_order_number ILIKE $${params.length} OR sample_tracking_id ILIKE $${params.length})`)
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

  const countRes = await db.query(`SELECT COUNT(*)::int AS count FROM unmapped_listing_skus ${whereClause}`, params)
  const total = Number(countRes.rows[0]?.count ?? 0)

  params.push(pageSize)
  params.push(offset)
  const rowsRes = await db.query(
    `SELECT id, marketplace, listing_sku, sample_order_number, sample_tracking_id, first_seen_at, last_seen_at, status
     FROM unmapped_listing_skus
     ${whereClause}
     ORDER BY last_seen_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )

  const items: UnmappedSkuItem[] = rowsRes.rows.map((r) => ({
    id: Number(r.id),
    marketplace: String(r.marketplace),
    listingSku: String(r.listing_sku),
    sampleOrderNumber: String(r.sample_order_number || ""),
    sampleTrackingId: String(r.sample_tracking_id || ""),
    firstSeenAt: toIsoTimestamp(r.first_seen_at),
    lastSeenAt: toIsoTimestamp(r.last_seen_at),
    status: String(r.status),
  }))

  return { items, total, page, pageSize }
}

export async function refreshUnmappedListingSkus(db: pg.Pool): Promise<number> {
  const client = await db.connect()
  try {
    await client.query("SET statement_timeout = '30s'")
    // Find all listing SKUs in expected_return_items that lack a product_master mapping
    const res = await client.query(`
      SELECT DISTINCT ON (m.name, COALESCE(NULLIF(eri.channel_listing_id, ''), eri.marketplace_sku_identifier))
        m.name AS marketplace,
        COALESCE(NULLIF(eri.channel_listing_id, ''), eri.marketplace_sku_identifier) AS listing_sku,
        er.order_number AS sample_order_number,
        er.tracking_id AS sample_tracking_id
      FROM expected_return_items eri
      JOIN expected_returns er ON er.id = eri.expected_return_id
      JOIN marketplaces m ON m.id = er.marketplace_id
      WHERE (eri.product_sku_source = 'unresolved'
         OR NOT EXISTS (
           SELECT 1 FROM product_master pm
           WHERE LOWER(pm.listing_sku) = LOWER(COALESCE(NULLIF(eri.channel_listing_id, ''), eri.marketplace_sku_identifier))
         ))
        AND COALESCE(NULLIF(eri.channel_listing_id, ''), eri.marketplace_sku_identifier) IS NOT NULL
        AND COALESCE(NULLIF(eri.channel_listing_id, ''), eri.marketplace_sku_identifier) <> ''
      ORDER BY m.name, COALESCE(NULLIF(eri.channel_listing_id, ''), eri.marketplace_sku_identifier), er.id DESC
    `)

    // Candidate-aware: the SELECT above is exact-match, so variant-resolved rows are
    // filtered here in JS (skip the insert) instead of entering the queue.
    const masterKeys = await loadMasterLookupKeys(client)
    let count = 0
    for (const row of res.rows) {
      const mp = String(row.marketplace || "").trim()
      const sku = String(row.listing_sku || "").trim()
      const sampleOrder = String(row.sample_order_number || "").trim()
      const sampleTracking = String(row.sample_tracking_id || "").trim()
      if (mp && sku) {
        if (unmappedIsResolved(sku, mp, masterKeys)) continue
        await client.query(
          `INSERT INTO unmapped_listing_skus (marketplace, listing_sku, sample_order_number, sample_tracking_id, last_seen_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (marketplace, listing_sku)
           DO UPDATE SET last_seen_at = now(),
                         sample_order_number = CASE WHEN unmapped_listing_skus.sample_order_number = '' THEN EXCLUDED.sample_order_number ELSE unmapped_listing_skus.sample_order_number END,
                         sample_tracking_id = CASE WHEN unmapped_listing_skus.sample_tracking_id = '' THEN EXCLUDED.sample_tracking_id ELSE unmapped_listing_skus.sample_tracking_id END`,
          [mp, sku, sampleOrder, sampleTracking],
        )
        count++
      }
    }

    // Flip existing unmapped rows that now resolve via a variant ( decided in JS ).
    await flipResolvedUnmappedRows(client)

    return count
  } finally {
    client.release()
  }
}

export async function generateUnmappedSkusTemplateCsv(db: pg.Pool, marketplace?: string): Promise<string> {
  const params: unknown[] = []
  let sql = "SELECT listing_sku, marketplace FROM unmapped_listing_skus WHERE status = 'unmapped'"
  if (marketplace && marketplace !== "All marketplaces" && marketplace !== "all") {
    sql += " AND LOWER(marketplace) = LOWER($1)"
    params.push(marketplace)
  }
  sql += " ORDER BY marketplace, listing_sku"

  const res = await db.query(sql, params)
  const header = "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL,Marketplace\n"
  const rows = res.rows.map((r) => {
    const sku = String(r.listing_sku || "").replace(/"/g, '""')
    const mp = String(r.marketplace || "").replace(/"/g, '""')
    return `"${sku}","","","","${mp}"`
  })
  return header + rows.join("\n") + (rows.length ? "\n" : "")
}

// ---------------------------------------------------------------------------------------------------------------
// Staged batched import for large product-master files (tens of thousands of rows).
//
// The batch routes in server/product-master-routes.ts stage parsed rows in memory and commit them 500 rows at a
// time, so the server never holds one huge transaction. Everything below is additive: the existing
// upsertProductMaster/replaceProductMaster above are untouched, and the chunk writers below reuse their exact
// row-insert SQL pattern. No history table is ever deleted here.
// ---------------------------------------------------------------------------------------------------------------

// One batch never exceeds 500 rows, no matter what the client asks for.
export const MASTER_BATCH_LIMIT = 500

// A staged master import expires 15 minutes after /import/start, mirroring the upload preview TTL.
export const MASTER_STAGING_TTL_MS = 15 * 60 * 1000

export type MasterImportMode = "merge" | "replace"

export type StagedMasterImport = {
  rows: MasterRow[]
  filename: string
  scope: string
  mode: MasterImportMode
  ownerId: number
  createdAt: number
  // Progress across /import/batch calls.
  processed: number
  inserted: number
  // Replace mode only: rows removed by the one DELETE, and whether that DELETE already ran.
  removed: number
  replaced: boolean
  // Blank image cells filled from another row of the same product SKU.
  imagesFilled: number
}

// Caps a client-supplied batch limit at 500. Missing, zero, negative and non-numeric values mean 500.
export function clampMasterBatchLimit(limit: unknown): number {
  const n = typeof limit === "string" ? Number(limit) : (limit as number)
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return MASTER_BATCH_LIMIT
  return Math.min(Math.floor(n), MASTER_BATCH_LIMIT)
}

// The next chunk of staged rows to commit, plus the progress it leads to.
export function takeMasterBatch<T>(
  rows: T[],
  processed: number,
  limit?: unknown,
): { chunk: T[]; nextProcessed: number; done: boolean; effectiveLimit: number } {
  const effectiveLimit = clampMasterBatchLimit(limit ?? MASTER_BATCH_LIMIT)
  const start = Math.max(0, Math.min(processed, rows.length))
  const chunk = rows.slice(start, start + effectiveLimit)
  const nextProcessed = start + chunk.length
  return { chunk, nextProcessed, done: nextProcessed >= rows.length, effectiveLimit }
}

// Overall progress of a staged import. Processed is clamped so it can never exceed the total.
export function masterBatchProgress(
  processed: number,
  total: number,
): { processed: number; total: number; done: boolean; remaining: number } {
  const safe = Math.max(0, Math.min(processed, total))
  return { processed: safe, total, done: safe >= total, remaining: total - safe }
}

// Returns the staged import for this owner, or throws the same way an unknown/expired upload preview does:
// unknown ids and other owners mean the file must be uploaded again (400/403), an expired staging means the
// preview expired (400). The clock is a parameter so tests can pin it. Expired entries are removed on read.
export function requireStagedMasterImport(
  staged: Map<string, StagedMasterImport>,
  uploadId: string,
  ownerId: number,
  now: number = Date.now(),
): StagedMasterImport {
  const entry = staged.get(uploadId)
  if (!entry) throw new ServiceError(400, "Upload the file again before importing.")
  if (entry.ownerId !== ownerId) throw new ServiceError(403, "Upload the file again before importing.")
  if (now - entry.createdAt > MASTER_STAGING_TTL_MS) {
    staged.delete(uploadId)
    throw new ServiceError(400, "That file preview expired. Upload it again.")
  }
  return entry
}

// Shared value list for one chunk, using the same columns as upsertProductMaster.
function masterChunkValues(rows: MasterRow[]): { values: unknown[]; groups: string[] } {
  const values: unknown[] = []
  const groups = rows.map((row) => {
    const base = values.length
    values.push(row.marketplace, row.listingSku, row.masterSku, row.category || null, row.cogs, row.weightSlab, row.imageUrl)
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, now())`
  })
  return { values, groups }
}

// Upserts one chunk (merge mode). The caller owns the transaction: one batch, one commit.
export async function upsertMasterRows(client: pg.PoolClient, rows: MasterRow[]): Promise<number> {
  if (!rows.length) return 0
  const { values, groups } = masterChunkValues(rows)
  const res = await client.query(
    `INSERT INTO product_master (marketplace, listing_sku, master_sku, category, cogs, weight_slab, image_url, updated_at)
     VALUES ${groups.join(", ")}
     ON CONFLICT (marketplace, listing_sku) DO UPDATE SET
       master_sku = EXCLUDED.master_sku,
       category = COALESCE(NULLIF(EXCLUDED.category, ''), product_master.category),
       image_url = CASE WHEN EXCLUDED.image_url <> '' THEN EXCLUDED.image_url ELSE product_master.image_url END,
       cogs = COALESCE(EXCLUDED.cogs, product_master.cogs),
       weight_slab = COALESCE(EXCLUDED.weight_slab, product_master.weight_slab),
       updated_at = now()`,
    values,
  )
  return res.rowCount ?? 0
}

// Inserts one chunk (replace mode, after the one DELETE). The caller owns the transaction.
export async function insertMasterRows(client: pg.PoolClient, rows: MasterRow[]): Promise<number> {
  if (!rows.length) return 0
  const { values, groups } = masterChunkValues(rows)
  const res = await client.query(
    `INSERT INTO product_master (marketplace, listing_sku, master_sku, category, cogs, weight_slab, image_url, updated_at)
     VALUES ${groups.join(", ")}`,
    values,
  )
  return res.rowCount ?? 0
}

// Flips matching unmapped_listing_skus to mapped. Shared by every batch so the logic lives in one place.
// Candidate-aware: resolution is decided in JS, SQL stays a set-based LOWER() update.
export async function markUnmappedListingSkusMapped(client: pg.PoolClient): Promise<void> {
  await flipResolvedUnmappedRows(client)
}

export type AutoLinkSummary = {
  omsguruBridged: number
  omsguruImagesFilled: number
  vmsMappingsCreated: number
  vmsImagesFilled: number
  pastedBlankImages: number
  resolvedUnmappedCount: number
  errors: string[]
}

// Scans and automatically links missing listing SKUs from OMSGuru channels and VMS database.
// Runs nightly before the OMSGuru inventory update email is generated and sent, or on-demand from Admin.
export async function autoResolveMissingListingSkus(db: pg.Pool): Promise<AutoLinkSummary> {
  const summary: AutoLinkSummary = {
    omsguruBridged: 0,
    omsguruImagesFilled: 0,
    vmsMappingsCreated: 0,
    vmsImagesFilled: 0,
    pastedBlankImages: 0,
    resolvedUnmappedCount: 0,
    errors: [],
  }

  // 1. OMSGuru local catalog bridge (oms_listings JOIN oms_skus)
  try {
    const ready = await db.query<{ ready: boolean }>(
      `SELECT to_regclass('public.oms_listings') IS NOT NULL
          AND to_regclass('public.oms_skus') IS NOT NULL AS ready`,
    )
    if (ready.rows[0]?.ready) {
      const channelsRes = await db.query<{ id: number; channel_name: string; name: string }>(
        `SELECT DISTINCT channel_company_id AS id,
                COALESCE(payload->>'channel_name', payload->>'name', '') AS channel_name,
                COALESCE(payload->>'name', '') AS name
         FROM oms_listings`,
      )
      if (channelsRes.rows.length) {
        const bridgeRes = await bridgeMasterMappings(db, channelsRes.rows)
        summary.omsguruBridged = bridgeRes.inserted
        summary.omsguruImagesFilled = bridgeRes.imageFilled
      }
    }
  } catch (err) {
    summary.errors.push(`OMSGuru bridge: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. VMS catalogue sync (omsguru_listings and sku_images) if VMS is configured
  if (isVmsConfigured()) {
    try {
      const vmsRes = await applyVmsCatalogue(db)
      summary.vmsMappingsCreated = vmsRes.mappingsCreated
      summary.vmsImagesFilled = vmsRes.imagesFilled
    } catch (err) {
      summary.errors.push(`VMS sync: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 3. Share images across matching master SKUs
  try {
    summary.pastedBlankImages = await pasteBlankMasterImages(db)
  } catch (err) {
    summary.errors.push(`Master image propagation: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. Mark newly resolved listing SKUs as mapped in unmapped_listing_skus
  try {
    const beforeCount = Number((await db.query("SELECT COUNT(*)::int AS count FROM unmapped_listing_skus WHERE status = 'unmapped'")).rows[0]?.count ?? 0)
    await flipResolvedUnmappedRows(db)
    const afterCount = Number((await db.query("SELECT COUNT(*)::int AS count FROM unmapped_listing_skus WHERE status = 'unmapped'")).rows[0]?.count ?? 0)
    summary.resolvedUnmappedCount = Math.max(0, beforeCount - afterCount)
  } catch (err) {
    summary.errors.push(`Unmapped resolution: ${err instanceof Error ? err.message : String(err)}`)
  }

  return summary
}

