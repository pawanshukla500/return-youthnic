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
import { formatUploadLabel } from "./format.js"
import { ServiceError, writeAudit, type Actor } from "./register-service.js"
import type { MasterRow } from "./sheets.js"

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

// Incrementally merges/upserts product master rows without deleting previously loaded data.
// Adds new mappings and updates existing ones on conflict (marketplace, listing_sku).
export async function upsertProductMaster(
  db: pg.Pool,
  actor: Actor,
  rows: MasterRow[],
  filename: string,
): Promise<{ inserted: number; total: number; lastLoadedAt: string }> {
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

    await writeAudit(client, actor.id, "product_master.upsert", "product_master", "all", {
      filename,
      rows: rows.length,
      affected,
    })

    // Automatically mark matching entries in unmapped_listing_skus as mapped
    await client.query(`
      UPDATE unmapped_listing_skus u
      SET status = 'mapped'
      FROM product_master pm
      WHERE u.status = 'unmapped'
        AND LOWER(pm.listing_sku) = LOWER(u.listing_sku)
    `)

    await client.query("COMMIT")
    return { inserted: affected, total: rows.length, lastLoadedAt: formatUploadLabel() }
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
): Promise<{ inserted: number; removed: number; lastLoadedAt: string }> {
  if (!rows.length) {
    throw new ServiceError(400, "No row has both a listing SKU and a product SKU. Nothing was loaded.")
  }
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const removed = await client.query("DELETE FROM product_master")
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK)
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
    await writeAudit(client, actor.id, "product_master.replace", "product_master", "all", {
      filename,
      rows: rows.length,
      removed: removed.rowCount ?? 0,
    })

    // Automatically mark matching entries in unmapped_listing_skus as mapped
    await client.query(`
      UPDATE unmapped_listing_skus u
      SET status = 'mapped'
      FROM product_master pm
      WHERE u.status = 'unmapped'
        AND LOWER(pm.listing_sku) = LOWER(u.listing_sku)
    `)

    await client.query("COMMIT")
    return { inserted: rows.length, removed: removed.rowCount ?? 0, lastLoadedAt: formatUploadLabel() }
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
  // Sync status against product_master first
  await db.query(`
    UPDATE unmapped_listing_skus u
    SET status = 'mapped'
    FROM product_master pm
    WHERE u.status = 'unmapped'
      AND LOWER(pm.listing_sku) = LOWER(u.listing_sku)
  `)

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
      lastSeenAt: r.last_seen_at ? formatUploadLabel(new Date(r.last_seen_at)) : "",
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
    firstSeenAt: r.first_seen_at ? formatUploadLabel(new Date(r.first_seen_at)) : "",
    lastSeenAt: r.last_seen_at ? formatUploadLabel(new Date(r.last_seen_at)) : "",
    status: String(r.status),
  }))

  return { items, total, page, pageSize }
}

export async function refreshUnmappedListingSkus(db: pg.Pool): Promise<number> {
  // Find all listing SKUs in expected_return_items that lack a product_master mapping
  const res = await db.query(`
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

  let count = 0
  for (const row of res.rows) {
    const mp = String(row.marketplace || "").trim()
    const sku = String(row.listing_sku || "").trim()
    const sampleOrder = String(row.sample_order_number || "").trim()
    const sampleTracking = String(row.sample_tracking_id || "").trim()
    if (mp && sku) {
      await db.query(
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

  // Also sync mapped status
  await db.query(`
    UPDATE unmapped_listing_skus u
    SET status = 'mapped'
    FROM product_master pm
    WHERE u.status = 'unmapped'
      AND LOWER(pm.listing_sku) = LOWER(u.listing_sku)
  `)

  return count
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
