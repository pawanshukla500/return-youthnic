// OMSGuru order details: reading a response row, removing buyer personal data, and storing a snapshot.
//
// Field names follow the Forward Scan project's parse_order_row (backend/app/oms/mapping.py).
// Not checked against the SwaggerHub spec. The command prints field names from the first real response
// so they can be checked.

import type pg from "pg"
import type { OmsRow } from "./client.js"

export type OrderLookup = { type: "sub_order_id" | "order_id"; key: string }

export type NormalizedOrder = {
  channelOrderId: string
  subOrderIds: string
  itemStatuses: string
  shipmentTracker: string
  invoiceId: string
  invoiceDate: Date | null
  warehouse: string
  channelLabel: string
  skus: string
}

// Buyer and contact fields. They are dropped from raw responses before storage.
// Order, item, and product fields are kept.
const PERSONAL_KEY = /phone|mobile|email|address|customer|buyer|consignee|receiver|recipient|pin ?code|zip ?code|gstin/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

export function redactPersonalData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactPersonalData(item))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (PERSONAL_KEY.test(key)) continue
    out[key] = redactPersonalData(inner)
  }
  return out
}

// Order items may come as an array or as an object keyed by id. Both are read.
function itemsOf(row: OmsRow): Record<string, unknown>[] {
  const raw = row.order_items
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : []
  return list.filter(isRecord)
}

// Unix time in seconds. Other values are left empty rather than guessed.
function unixToDate(value: unknown): Date | null {
  const seconds = typeof value === "number" ? value : Number(text(value))
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000)
}

export function normalizeOrderRow(row: OmsRow): NormalizedOrder {
  const items = itemsOf(row)
  const channelOrderId =
    items.map((item) => text(item.channel_order_id)).find((value) => value !== "") || text(row.channel_order_id)
  const subOrderIds = [...new Set(items.map((item) => text(item.channel_sub_order_id)).filter(Boolean))]
    .sort()
    .join(",")
  const skus = [
    ...new Set(
      items
        .map((item) => text(item.sku_code) || text(item.sku) || text(item.product_sku) || text(item.sku_name))
        .filter(Boolean),
    ),
  ].join(",")
  return {
    channelOrderId,
    subOrderIds,
    itemStatuses: items.map((item) => text(item.status)).filter(Boolean).join(";"),
    shipmentTracker: text(row.shipment_tracker) || text(row.shipment_tracking_id),
    invoiceId: text(row.invoice_id),
    invoiceDate: unixToDate(row.invoice_date),
    warehouse: text(row.warehouse),
    channelLabel: text(row.channel),
    skus,
  }
}

// Turns a stored return key into a usable lookup key.
// Strips ="..." and apostrophe wrappers. Rejects values whose digits were already lost (scientific notation).
export function usableLookupKey(value: string): string {
  const key = value.trim().replace(/^="(.*)"$/, "$1").replace(/^'/, "").replace(/\s+/g, "")
  if (!key || key === "—") return ""
  if (/^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(key)) return ""
  return key
}

export async function hasSnapshot(db: pg.Pool, lookup: OrderLookup): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM oms_order_snapshots WHERE lookup_type = $1 AND lookup_key = $2 AND raw_json IS NOT NULL LIMIT 1",
    [lookup.type, lookup.key],
  )
  return (result.rowCount ?? 0) > 0
}

// Stores every order row OMSGuru returned for one lookup. Re-running updates the same rows.
export async function storeOrderRows(
  db: pg.Pool,
  lookup: OrderLookup,
  marketplace: string,
  rows: OmsRow[],
): Promise<number> {
  let stored = 0
  for (const row of rows) {
    const n = normalizeOrderRow(row)
    await db.query(
      `INSERT INTO oms_order_snapshots
        (lookup_type, lookup_key, marketplace, channel_order_id, sub_order_ids, item_statuses, shipment_tracker,
         invoice_id, invoice_date, warehouse, channel_label, skus, raw_json, last_error, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'',now())
       ON CONFLICT (lookup_type, lookup_key, channel_order_id, sub_order_ids) DO UPDATE SET
         marketplace = EXCLUDED.marketplace,
         item_statuses = EXCLUDED.item_statuses,
         shipment_tracker = EXCLUDED.shipment_tracker,
         invoice_id = EXCLUDED.invoice_id,
         invoice_date = EXCLUDED.invoice_date,
         warehouse = EXCLUDED.warehouse,
         channel_label = EXCLUDED.channel_label,
         skus = EXCLUDED.skus,
         raw_json = EXCLUDED.raw_json,
         last_error = '',
         fetched_at = now()`,
      [
        lookup.type,
        lookup.key,
        marketplace,
        n.channelOrderId,
        n.subOrderIds,
        n.itemStatuses,
        n.shipmentTracker,
        n.invoiceId,
        n.invoiceDate,
        n.warehouse,
        n.channelLabel,
        n.skus,
        JSON.stringify(redactPersonalData(row)),
      ],
    )
    stored++
  }
  return stored
}

// Records a lookup that returned nothing (NOT_FOUND) or failed (ERROR: ...), so the run does not repeat it.
export async function recordLookupOutcome(
  db: pg.Pool,
  lookup: OrderLookup,
  marketplace: string,
  outcome: string,
): Promise<void> {
  await db.query(
    `INSERT INTO oms_order_snapshots (lookup_type, lookup_key, marketplace, last_error, fetched_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (lookup_type, lookup_key, channel_order_id, sub_order_ids) DO UPDATE SET
       last_error = EXCLUDED.last_error,
       fetched_at = now()`,
    [lookup.type, lookup.key, marketplace, outcome],
  )
}
