// The VB EXPORT product master (product_master): a channel listing SKU to a product SKU, with its category and the
// channel image link. This is configuration data, loaded by an administrator from the Admin "Product SKU master" tab
// or by the CLI (server/scripts/load-product-master.ts).
//
// Loading replaces the whole table in one transaction, so the newest catalog file is the only source. Nothing is kept
// from an earlier load except in register_audit_log, which records who loaded what and how many rows changed. The
// image link from this file wins over the OMSGuru catalog image when a return file is activated (server/lookup-import.ts).
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
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
      })
      await client.query(
        `INSERT INTO product_master (marketplace, listing_sku, master_sku, category, cogs, weight_slab, image_url)
         VALUES ${groups.join(", ")}`,
        values,
      )
    }
    await writeAudit(client, actor.id, "product_master.replace", "product_master", "all", {
      filename,
      rows: rows.length,
      removed: removed.rowCount ?? 0,
    })
    await client.query("COMMIT")
    return { inserted: rows.length, removed: removed.rowCount ?? 0, lastLoadedAt: formatUploadLabel() }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
