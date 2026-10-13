// OMSGuru master SKUs (GET /order_api/skus), stored in oms_skus by the daily sync.
//
// The SKU record has no image field. Product images come from the channel listings (oms_listings.image_url and
// sku_catalog.image_url). A listing joins to its master SKU on oms_listings.oms_sku_id = oms_skus.oms_sku_id.
//
// Synthetic-tested only (server/tests/oms.test.ts). Not verified against the live OMSGuru API.

import type pg from "pg"
import { firstText, moneyOrNull, type OmsClient, type OmsRow } from "./client.js"

export type SkuRecord = {
  omsSkuId: number
  skuCode: string
  name: string
  sellingPrice: number | null
  mrpPrice: number | null
  lastPurchasePrice: number | null
  sizeCode: string
  styleCode: string
  modelCode: string
  colorCode: string
  upc: string
}

export type SkuSyncTotals = { pages: number; skus: number; newSkus: number }

// One master SKU record. Null when the record has no id, because it cannot be stored or paged.
export function skuRecord(row: OmsRow): SkuRecord | null {
  const omsSkuId = Number(row.id)
  if (!Number.isFinite(omsSkuId) || omsSkuId <= 0) return null
  return {
    omsSkuId,
    skuCode: firstText(row, ["sku_code"]),
    name: firstText(row, ["name"]),
    sellingPrice: moneyOrNull(row.selling_price),
    mrpPrice: moneyOrNull(row.mrp_price),
    lastPurchasePrice: moneyOrNull(row.last_purchase_price),
    sizeCode: firstText(row, ["sku_size_code"]),
    styleCode: firstText(row, ["sku_style_code"]),
    modelCode: firstText(row, ["sku_model_code"]),
    colorCode: firstText(row, ["sku_color_code"]),
    upc: firstText(row, ["sku_upc"]),
  }
}

// Writes one page of master SKUs. xmax = 0 in RETURNING means the row was inserted, not updated.
export async function storeSkuPage(db: pg.Pool, rows: OmsRow[]): Promise<{ stored: number; inserted: number }> {
  const byId = new Map<number, { record: SkuRecord; payload: OmsRow }>()
  for (const row of rows) {
    const record = skuRecord(row)
    if (record) byId.set(record.omsSkuId, { record, payload: row })
  }
  const items = [...byId.values()]
  let inserted = 0
  const BATCH = 300
  for (let start = 0; start < items.length; start += BATCH) {
    const batch = items.slice(start, start + BATCH)
    const values: unknown[] = []
    const groups = batch.map(({ record, payload }) => {
      const base = values.length
      values.push(
        record.omsSkuId,
        record.skuCode,
        record.name,
        record.sellingPrice,
        record.mrpPrice,
        record.lastPurchasePrice,
        record.sizeCode,
        record.styleCode,
        record.modelCode,
        record.colorCode,
        record.upc,
        JSON.stringify(payload),
      )
      const p = (offset: number) => `$${base + offset}`
      return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)}::jsonb, now())`
    })
    const result = await db.query<{ inserted: boolean }>(
      `INSERT INTO oms_skus (oms_sku_id, sku_code, name, selling_price, mrp_price, last_purchase_price,
                             size_code, style_code, model_code, color_code, upc, payload, synced_at)
       VALUES ${groups.join(", ")}
       ON CONFLICT (oms_sku_id) DO UPDATE SET
         sku_code = EXCLUDED.sku_code,
         name = EXCLUDED.name,
         selling_price = EXCLUDED.selling_price,
         mrp_price = EXCLUDED.mrp_price,
         last_purchase_price = EXCLUDED.last_purchase_price,
         size_code = EXCLUDED.size_code,
         style_code = EXCLUDED.style_code,
         model_code = EXCLUDED.model_code,
         color_code = EXCLUDED.color_code,
         upc = EXCLUDED.upc,
         payload = EXCLUDED.payload,
         synced_at = now()
       RETURNING (xmax = 0) AS inserted`,
      values,
    )
    inserted += result.rows.filter((row) => row.inserted).length
  }
  return { stored: items.length, inserted }
}

// Pages through the whole master SKU list with last_id. Stops on an empty page or when the cursor does not move.
// The page size is not stated for this call, so a short page does not end the loop.
export async function syncSkuMaster(
  db: pg.Pool,
  client: OmsClient,
  onPage?: (totals: SkuSyncTotals) => void,
): Promise<SkuSyncTotals> {
  const totals: SkuSyncTotals = { pages: 0, skus: 0, newSkus: 0 }
  let lastId = 0
  for (;;) {
    const rows = await client.listSkus(lastId)
    if (!rows.length) break
    const page = await storeSkuPage(db, rows)
    totals.pages++
    totals.skus += page.stored
    totals.newSkus += page.inserted
    onPage?.(totals)
    const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0)
    const maxId = ids.length ? Math.max(...ids) : 0
    if (!ids.length || maxId <= lastId) break
    lastId = maxId
  }
  return totals
}
