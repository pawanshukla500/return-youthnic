// OMSGuru channel listings, stored two ways on every daily run (server/scripts/sync-oms-catalog.ts):
//  - oms_listings: one row per listing record, with every field the listing endpoint returns, including the
//    OMSGuru master SKU it is mapped to (oms_sku_id). Mapped and unmapped listings are both kept.
//  - sku_catalog: one title and image per normalized listing SKU. The upload preview and the item label read this.
//
// Synthetic-tested only (server/tests/oms.test.ts). Not verified against the live OMSGuru API.

import type pg from "pg"
import {
  OMS_PAGE_LIMIT,
  firstText,
  listingId,
  listingImage,
  listingSku,
  listingTitle,
  moneyOrNull,
  type OmsClient,
  type OmsRow,
} from "./client.js"

export type CatalogEntry = { sku: string; title: string; imageUrl: string }

export type ListingRecord = {
  omsListingId: number
  listingRef: string
  channelSku: string
  omsSkuId: number | null
  retailPrice: number | null
  title: string
  imageUrl: string
}

export type ListingSyncTotals = {
  pages: number
  listings: number
  mapped: number
  newListings: number
  newMapped: number
}

type PageCounts = { stored: number; mapped: number; inserted: number; insertedMapped: number }

// A listing is stored in sku_catalog when it has a SKU and at least a title or an image.
export function catalogEntry(row: OmsRow): CatalogEntry | null {
  const sku = listingSku(row)
  if (!sku) return null
  const title = listingTitle(row)
  const imageUrl = listingImage(row)
  if (!title && !imageUrl) return null
  return { sku, title, imageUrl }
}

// One listing record. Null when the record has no id, because it cannot be stored or paged.
export function listingRecord(row: OmsRow): ListingRecord | null {
  const omsListingId = listingId(row)
  if (omsListingId === null) return null
  const omsSkuId = Number(row.oms_sku_id)
  return {
    omsListingId,
    listingRef: firstText(row, ["listing_id"]),
    channelSku: listingSku(row),
    omsSkuId: Number.isFinite(omsSkuId) && omsSkuId > 0 ? omsSkuId : null,
    retailPrice: moneyOrNull(row.retail_price),
    title: listingTitle(row),
    imageUrl: listingImage(row),
  }
}

// Writes one page of listing records to oms_listings. xmax = 0 in RETURNING means the row was inserted, not updated.
async function storeListingRecords(db: pg.Pool, rows: OmsRow[], channelCompanyId: number): Promise<PageCounts> {
  const byId = new Map<number, { record: ListingRecord; payload: OmsRow }>()
  for (const row of rows) {
    const record = listingRecord(row)
    if (record) byId.set(record.omsListingId, { record, payload: row })
  }
  const items = [...byId.values()]
  let mapped = 0
  let inserted = 0
  let insertedMapped = 0
  const BATCH = 300
  for (let start = 0; start < items.length; start += BATCH) {
    const batch = items.slice(start, start + BATCH)
    const values: unknown[] = []
    const groups = batch.map(({ record, payload }) => {
      const base = values.length
      values.push(
        channelCompanyId,
        record.omsListingId,
        record.listingRef,
        record.channelSku,
        record.omsSkuId,
        record.retailPrice,
        record.title,
        record.imageUrl,
        JSON.stringify(payload),
      )
      const p = (offset: number) => `$${base + offset}`
      return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}::jsonb, now())`
    })
    const result = await db.query<{ inserted: boolean; mapped: boolean }>(
      `INSERT INTO oms_listings (channel_company_id, oms_listing_id, listing_id, channel_sku, oms_sku_id,
                                 retail_price, title, image_url, payload, synced_at)
       VALUES ${groups.join(", ")}
       ON CONFLICT (channel_company_id, oms_listing_id) DO UPDATE SET
         listing_id = EXCLUDED.listing_id,
         channel_sku = EXCLUDED.channel_sku,
         oms_sku_id = EXCLUDED.oms_sku_id,
         retail_price = EXCLUDED.retail_price,
         title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE oms_listings.title END,
         image_url = CASE WHEN EXCLUDED.image_url <> '' THEN EXCLUDED.image_url ELSE oms_listings.image_url END,
         payload = EXCLUDED.payload,
         synced_at = now()
       RETURNING (xmax = 0) AS inserted, (oms_sku_id IS NOT NULL) AS mapped`,
      values,
    )
    for (const row of result.rows) {
      if (row.mapped) mapped++
      if (row.inserted) {
        inserted++
        if (row.mapped) insertedMapped++
      }
    }
  }
  return { stored: items.length, mapped, inserted, insertedMapped }
}

// Writes one page of listings to sku_catalog. A later page with a blank title or image keeps the value already stored.
export async function storeCatalogPage(db: pg.Pool, rows: OmsRow[], channelCompanyId: number): Promise<number> {
  const bySku = new Map<string, CatalogEntry>()
  for (const row of rows) {
    const entry = catalogEntry(row)
    if (entry) bySku.set(entry.sku, entry)
  }
  const entries = [...bySku.values()]
  const BATCH = 500
  for (let start = 0; start < entries.length; start += BATCH) {
    const batch = entries.slice(start, start + BATCH)
    const values: unknown[] = []
    const groups = batch.map((entry) => {
      const base = values.length
      values.push(entry.sku, entry.title, entry.imageUrl, channelCompanyId)
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`
    })
    await db.query(
      `INSERT INTO sku_catalog (sku, title, image_url, channel_company_id)
       VALUES ${groups.join(", ")}
       ON CONFLICT (sku) DO UPDATE SET
         title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE sku_catalog.title END,
         image_url = CASE WHEN EXCLUDED.image_url <> '' THEN EXCLUDED.image_url ELSE sku_catalog.image_url END,
         channel_company_id = EXCLUDED.channel_company_id,
         updated_at = now()`,
      values,
    )
  }
  return entries.length
}

// Writes one page to both tables. Returns the listing counts for the page.
export async function storeListingPage(db: pg.Pool, rows: OmsRow[], channelCompanyId: number): Promise<PageCounts> {
  const listings = await storeListingRecords(db, rows, channelCompanyId)
  await storeCatalogPage(db, rows, channelCompanyId)
  return listings
}

// Pages through one channel's listings with last_id, the cursor the spec describes.
// A page shorter than OMS_PAGE_LIMIT is the last page.
export async function syncChannelListings(
  db: pg.Pool,
  client: OmsClient,
  channelCompanyId: number,
  onPage?: (totals: ListingSyncTotals) => void,
): Promise<ListingSyncTotals> {
  const totals: ListingSyncTotals = { pages: 0, listings: 0, mapped: 0, newListings: 0, newMapped: 0 }
  let lastId = 0
  for (;;) {
    const rows = await client.listChannelListings(channelCompanyId, lastId)
    if (!rows.length) break
    const page = await storeListingPage(db, rows, channelCompanyId)
    totals.pages++
    totals.listings += page.stored
    totals.mapped += page.mapped
    totals.newListings += page.inserted
    totals.newMapped += page.insertedMapped
    onPage?.(totals)
    const ids = rows.map((row) => listingId(row)).filter((id): id is number => id !== null)
    const maxId = ids.length ? Math.max(...ids) : 0
    if (rows.length < OMS_PAGE_LIMIT || !ids.length || maxId <= lastId) break
    lastId = maxId
  }
  return totals
}
