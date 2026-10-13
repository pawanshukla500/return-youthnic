// Daily OMSGuru invoice pull: every channel, one IST day at a time, paged by last_id.
//
// An invoice row is a dispatched shipment (its AWB) with its channel, warehouse, order ids and item statuses.
// Endpoint, paging and field names follow the Forward Scan project (client.py list_invoices, mapping.py).
// The end of the day window is treated as inclusive. Not verified against the live API.

import type pg from "pg"
import { istDay, istDayUnixRange } from "../dates.js"
import { OmsClient, rowsFrom, type OmsRow } from "./client.js"
import { normalizeOrderRow, redactPersonalData } from "./orders.js"

export const INVOICE_PAGE_LIMIT = 100

// Same rule as the Forward Scan project: upper case, courier suffixes such as "( EK_E2E )" removed,
// only letters, digits and - _ / kept.
export function normalizeTracking(raw: string): string {
  const withoutSuffix = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim().toUpperCase()
  return withoutSuffix.replace(/[^A-Z0-9\-_/]/g, "").replace(/^[-_/]+|[-_/]+$/g, "")
}

// Stable key for one invoice row. Re-pulling the same row updates it instead of adding a copy.
export function invoiceKey(
  channel: string,
  channelOrderId: string,
  invoiceId: string,
  subOrderIds: string,
  trackingRaw: string,
): string {
  return [channel, channelOrderId, invoiceId || subOrderIds, normalizeTracking(trackingRaw)].join("|").slice(0, 300)
}

export async function storeInvoiceRows(db: pg.Pool | pg.PoolClient, rows: OmsRow[]): Promise<number> {
  let stored = 0
  for (const row of rows) {
    const n = normalizeOrderRow(row)
    const key = invoiceKey(n.channelLabel, n.channelOrderId, n.invoiceId, n.subOrderIds, n.shipmentTracker)
    const lastId = Number(row.last_id)
    await db.query(
      `INSERT INTO oms_invoices
        (oms_key, oms_invoice_id, channel_label, warehouse, company, invoice_date, invoice_day, channel_order_id,
         sub_order_ids, shipment_tracker, item_statuses, skus, last_oms_id, payload, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (oms_key) DO UPDATE SET
         oms_invoice_id = EXCLUDED.oms_invoice_id,
         warehouse = EXCLUDED.warehouse,
         company = EXCLUDED.company,
         invoice_date = EXCLUDED.invoice_date,
         invoice_day = EXCLUDED.invoice_day,
         item_statuses = EXCLUDED.item_statuses,
         skus = EXCLUDED.skus,
         last_oms_id = EXCLUDED.last_oms_id,
         payload = EXCLUDED.payload,
         synced_at = now()`,
      [
        key,
        n.invoiceId,
        n.channelLabel,
        n.warehouse,
        typeof row.company === "string" ? row.company.trim() : "",
        n.invoiceDate,
        n.invoiceDate ? istDay(n.invoiceDate) : null,
        n.channelOrderId,
        n.subOrderIds,
        n.shipmentTracker,
        n.itemStatuses,
        n.skus,
        Number.isFinite(lastId) && lastId > 0 ? lastId : null,
        JSON.stringify(redactPersonalData(row)),
      ],
    )
    stored++
  }
  return stored
}

// Pulls every invoice for one IST day. Returns the number of pages and rows stored.
// Throws OmsThrottled or OmsError from the client; the caller decides whether to stop.
export async function syncInvoicesForDay(
  db: pg.Pool,
  client: OmsClient,
  day: string,
  onPage?: (pageRows: number, storedSoFar: number) => void,
): Promise<{ pages: number; stored: number }> {
  const range = istDayUnixRange(day)
  if (!range) throw new Error(`Day must look like 2026-10-07: ${day}`)
  let lastId = 0
  let pages = 0
  let stored = 0
  for (;;) {
    const rows = rowsFrom(
      await client.request("POST", "/order_api/invoices", {
        form: {
          start_invoice_date: range.start,
          end_invoice_date: range.end,
          last_id: lastId,
          limit: INVOICE_PAGE_LIMIT,
        },
      }),
    )
    if (!rows.length) break
    pages++
    stored += await storeInvoiceRows(db, rows)
    onPage?.(rows.length, stored)
    const ids = rows.map((row) => Number(row.last_id)).filter((id) => Number.isFinite(id) && id > 0)
    const maxId = ids.length ? Math.max(...ids) : 0
    if (rows.length < INVOICE_PAGE_LIMIT || !ids.length || maxId <= lastId) break
    lastId = maxId
  }
  return { pages, stored }
}

export async function startRun(db: pg.Pool, kind: string, day: string): Promise<number> {
  const result = await db.query<{ id: number }>(
    "INSERT INTO oms_sync_runs (kind, run_day) VALUES ($1, $2) RETURNING id",
    [kind, day],
  )
  return result.rows[0].id
}

export async function finishRun(
  db: pg.Pool,
  id: number,
  status: "done" | "throttled" | "error",
  pages: number,
  rowsStored: number,
  error = "",
): Promise<void> {
  await db.query(
    "UPDATE oms_sync_runs SET status = $2, finished_at = now(), pages = $3, rows_stored = $4, error = $5 WHERE id = $1",
    [id, status, pages, rowsStored, error],
  )
}
