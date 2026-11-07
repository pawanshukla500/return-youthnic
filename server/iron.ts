// Iron Send tracking. See server/schema-iron.sql for the tables and the rules.
//
// The Return Team taps "Iron Send" at the scan bench. That opens one record per scanned line with the quantity sent.
// The Inward Team records what came back, by hand, in one or more entries. Nothing here marks a record received on
// its own, and nothing here talks to OMSGuru: Iron Send units are never part of an inventory update.
//
// Quantities, per record:
//   sent      qty_sent of an open record
//   received  the sum of its receive events (never more than sent)
//   pending   sent - received
//   overdue   pending, past the expected return date of its batch, or (for a line not yet in a batch) older than the
//             overdue setting (3 days unless Admin changes it)
//
// Batches: the Return Team groups pending lines into a numbered batch (IRN-YYMMDD-NNN), downloads the sheet, and writes
// the batch number on the khaata challan. The outward and inward teams track by batch. See server/schema-iron.sql.

import type pg from "pg"
import * as XLSX from "xlsx"
import {
  accountCondition,
  allowsAccount,
  isAdminRole,
  isInwardRole,
  isSupervisorOrAdminRole,
  type AccountScope,
} from "./access.js"
import { extractGarmentSize } from "./return-reasons.js"
import { ServiceError, type Actor } from "./register-service.js"

export const DEFAULT_OVERDUE_DAYS = 3
export const MAX_IRON_NOTES = 500

export type IronState = "pending" | "partial" | "overdue" | "received" | "cancelled" | "cleared"
export type IronHandoverStatus = "batch_created" | "ready_for_handover" | "handed_over"
export type IronReturnTeamStatus = "completed"

/**
 * Normalizes an arbitrary value into a valid `IronHandoverStatus` (`batch_created`, `ready_for_handover`, or `handed_over`).
 */
export function ironHandoverStatusOf(value: unknown): IronHandoverStatus {
  const clean = String(value ?? "").trim().toLowerCase()
  if (clean === "ready_for_handover") return "ready_for_handover"
  if (clean === "handed_over") return "handed_over"
  return "batch_created"
}

/**
 * Returns the human-readable UI/sheet label for an `IronHandoverStatus`.
 */
export function ironHandoverStatusLabel(status: IronHandoverStatus): string {
  if (status === "ready_for_handover") return "Ready for Handover"
  if (status === "handed_over") return "Handed Over"
  return "Batch Created"
}

/**
 * Computes the operational lifecycle state of one Iron Send record (`pending`, `partial`, `overdue`, `received`, `cancelled`, or `cleared`).
 */
export function ironStateOf(input: {
  status: "open" | "cancelled" | "cleared"
  qtySent: number
  qtyReceived: number
  sentAt: Date
  now: Date
  overdueAfterDays: number
  // The expected return date of the line's batch. A line in a batch is overdue after that date instead.
  dueAt?: Date | null
}): IronState {
  if (input.status === "cancelled") return "cancelled"
  if (input.status === "cleared") return "cleared"
  const pending = Math.max(0, input.qtySent - input.qtyReceived)
  if (pending === 0) return "received"
  const overdue = input.dueAt
    ? input.now.getTime() > input.dueAt.getTime()
    : input.now.getTime() - input.sentAt.getTime() > input.overdueAfterDays * 24 * 3600_000
  if (overdue) return "overdue"
  return input.qtyReceived > 0 ? "partial" : "pending"
}

/**
 * Checks whether the role belongs to the Inward Team or an Admin (allowed to record ironed units received).
 */
export function canReceiveIron(role: string): boolean {
  return isInwardRole(role) || isAdminRole(role)
}

/**
 * Checks whether the role belongs to the Return Team, a Supervisor, or an Admin (allowed to create and hand over batches).
 */
export function canDispatchIron(role: string): boolean {
  return !isInwardRole(role) && String(role || "").trim() !== ""
}

/**
 * Checks whether the role is a Supervisor or an Admin (allowed to clear unbatched pending Iron Send backlogs).
 */
export function canClearIron(role: string): boolean {
  return isSupervisorOrAdminRole(role)
}

// Where a batch is ironed: sent out to a khaata on a challan, or (high-running pieces) ironed at the return desk.
export type IronLocation = "khaata" | "in_house"
export const IN_HOUSE_IRON_NAME = "Return desk (in-house)"

export function ironLocationOf(value: unknown): IronLocation {
  return String(value ?? "").trim().toLowerCase() === "in_house" ? "in_house" : "khaata"
}

// IRN-YYMMDD-NNN, by the IST day the batch was made.
export function ironBatchNumber(istDay: string, sequence: number): string {
  const compact = istDay.replace(/-/g, "").slice(2)
  return `IRN-${compact}-${String(sequence).padStart(3, "0")}`
}

// Checks one receive entry before it is written. Returns the problem, or null.
export function receiveProblem(qty: number, pending: number, notes: string): string | null {
  if (!Number.isInteger(qty) || qty < 1) return "Enter the received quantity as a whole number of at least 1."
  if (pending <= 0) return "Every unit of this Iron Send has already been received."
  if (qty > pending) return `Only ${pending} unit(s) are still pending for this Iron Send.`
  if (notes.length > MAX_IRON_NOTES) return `Notes must be ${MAX_IRON_NOTES} characters or fewer.`
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Scan bench: keeps the open records of a scan in line with its Iron Send issues. Runs inside the scan transaction.
// ---------------------------------------------------------------------------------------------------------------

// For each line of the scan, the wanted Iron Send quantity is the sum of its operational issues. A line whose open
// record already has that quantity is left alone. A line whose quantity changed gets its record cancelled and a new
// one opened, unless the Inward Team has already received units for it: then the correction is refused, because the
// bench must not rewrite what the Inward Team recorded.
export async function syncIronRecordsForScan(
  client: pg.PoolClient,
  scanId: number,
  actorId: number,
  reason: string,
): Promise<{ opened: number; cancelled: number }> {
  const wanted = await client.query(
    `SELECT i.id AS item_id, er.marketplace_id,
            COALESCE(SUM(x.qty) FILTER (WHERE c.is_operational), 0)::int AS qty,
            COALESCE(string_agg(NULLIF(x.notes, ''), '; ') FILTER (WHERE c.is_operational), '') AS notes
     FROM receipt_scan_items i
     JOIN receipt_scans rs ON rs.id = i.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     LEFT JOIN receipt_scan_issues x ON x.receipt_scan_item_id = i.id
     LEFT JOIN receipt_issue_categories c ON c.code = x.category_code
     WHERE i.receipt_scan_id = $1
     GROUP BY i.id, er.marketplace_id`,
    [scanId],
  )
  const open = await client.query(
    `SELECT r.id, r.receipt_scan_item_id, r.qty_sent, r.status, r.batch_id,
            (SELECT b.batch_no FROM iron_batches b WHERE b.id = r.batch_id) AS batch_no,
            COALESCE((SELECT SUM(e.qty) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id), 0)::int AS received
     FROM iron_send_records r
     WHERE r.receipt_scan_id = $1 AND r.status IN ('open', 'cleared')
     ORDER BY CASE WHEN r.status = 'open' THEN 0 ELSE 1 END, r.id DESC
     FOR UPDATE OF r`,
    [scanId],
  )
  const openByItem = new Map<number, { id: number; qty: number; received: number; batchNo: string | null; status: string }>()
  for (const row of open.rows) {
    const itemId = Number(row.receipt_scan_item_id)
    if (openByItem.has(itemId)) continue
    openByItem.set(itemId, {
      id: Number(row.id),
      qty: Number(row.qty_sent),
      received: Number(row.received),
      batchNo: row.batch_id === null ? null : String(row.batch_no),
      status: String(row.status || "open"),
    })
  }

  let opened = 0
  let cancelled = 0
  for (const row of wanted.rows) {
    const itemId = Number(row.item_id)
    const qty = Number(row.qty)
    const current = openByItem.get(itemId)
    if (current && current.qty === qty) continue
    if (current) {
      if (current.status === "cleared") {
        throw new ServiceError(
          409,
          "This Iron Send record was already cleared in a daily batch cutover and cannot be changed from the scan bench.",
        )
      }
      if (current.batchNo) {
        throw new ServiceError(
          409,
          `This Iron Send has already gone out in batch ${current.batchNo}. Iron Send cannot be changed from the scan bench.`,
        )
      }
      if (current.received > 0) {
        throw new ServiceError(
          409,
          "The Inward Team has already received ironed units for this return. Iron Send cannot be changed from the scan bench.",
        )
      }
      await client.query(
        `UPDATE iron_send_records
         SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3
         WHERE id = $1`,
        [current.id, actorId, reason],
      )
      cancelled += 1
    }
    if (qty > 0) {
      await client.query(
        `INSERT INTO iron_send_records (receipt_scan_id, receipt_scan_item_id, marketplace_id, qty_sent, notes, sent_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [scanId, itemId, row.marketplace_id === null ? null : Number(row.marketplace_id), qty, String(row.notes || ""), actorId],
      )
      opened += 1
    }
  }
  return { opened, cancelled }
}

// ---------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------

export async function getOverdueDays(db: pg.Pool | pg.PoolClient): Promise<number> {
  const row = (await db.query("SELECT overdue_after_days FROM iron_settings WHERE id = 1")).rows[0]
  const days = Number(row?.overdue_after_days)
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_OVERDUE_DAYS
}

export async function setOverdueDays(db: pg.Pool, actor: Actor, days: number): Promise<number> {
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new ServiceError(400, "Overdue after must be a whole number of days from 1 to 30.")
  }
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const before = await getOverdueDays(client)
    await client.query(
      `INSERT INTO iron_settings (id, overdue_after_days, updated_by, updated_at) VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET overdue_after_days = EXCLUDED.overdue_after_days,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [days, actor.id],
    )
    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'iron.settings', 'iron_settings', '1', $2::jsonb)`,
      [actor.id, JSON.stringify({ overdueAfterDaysFrom: before, overdueAfterDaysTo: days })],
    )
    await client.query("COMMIT")
    return days
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lists and figures
// ---------------------------------------------------------------------------------------------------------------

export type IronFilters = {
  state?: string // pending | overdue | partial | received | open (pending+partial+overdue) | unbatched | cancelled | all
  marketplaceId?: number | null
  batchId?: number | null
  search?: string
  dateFrom?: string // YYYY-MM-DD, IST, on the sent date
  dateTo?: string
}

export type IronRecordView = {
  id: number
  scanId: number
  state: IronState
  marketplace: string
  marketplaceId: number | null
  trackingId: string
  orderId: string
  marketplaceSku: string
  productSku: string
  productName: string
  size: string
  imageUrl: string
  qtySent: number
  qtyReceived: number
  qtyPending: number
  sentAt: string
  sentBy: string
  ageDays: number
  lastReceivedAt: string | null
  notes: string
  batchId: number | null
  batchNo: string | null
  // When the line is due back: its batch's expected return date. Null until it is in a batch.
  dueAt: string | null
  receipts: { id: number; qty: number; receivedAt: string; receivedBy: string; notes: string }[]
}

export type IronSummary = {
  overdueAfterDays: number
  records: { open: number; pending: number; partial: number; overdue: number; received: number }
  units: { sent: number; received: number; pending: number; overdue: number }
  receivedToday: number
  // Pending lines and units that are not in a batch yet (the Return Team still has to send them out).
  unbatched: { lines: number; units: number; todayLines: number; todayUnits: number }
  batches: {
    total: number
    batchCreated: number
    readyForHandover: number
    handedOver: number
    totalUnits: number
    todayBatches: number
  }
  cleared: { lines: number; units: number }
}

const RECORD_SQL = `
  SELECT r.id, r.receipt_scan_id, r.status, r.qty_sent, r.sent_at, r.notes, r.marketplace_id,
         COALESCE(m.name, rs.marketplace_snapshot, '') AS marketplace,
         COALESCE(rs.tracking_id_snapshot, er.tracking_id, '') AS tracking_id,
         COALESCE(rs.order_number_snapshot, er.order_number, '') AS order_number,
         COALESCE(i.marketplace_sku, '') AS marketplace_sku,
         COALESCE(i.product_sku, '') AS product_sku,
         COALESCE(i.product_name, '') AS product_name,
         COALESCE((SELECT pm.image_url FROM product_master pm
                    WHERE pm.listing_sku = i.marketplace_sku AND pm.image_url <> '' LIMIT 1), '') AS image_url,
         COALESCE(sender.name, '') AS sent_by,
         r.batch_id, b.batch_no, b.expected_return_at,
         COALESCE((SELECT SUM(e.qty) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id), 0)::int AS received,
         (SELECT MAX(e.received_at) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id) AS last_received_at
  FROM iron_send_records r
  JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
  JOIN expected_returns er ON er.id = rs.expected_return_id
  JOIN receipt_scan_items i ON i.id = r.receipt_scan_item_id
  LEFT JOIN marketplaces m ON m.id = COALESCE(r.marketplace_id, er.marketplace_id)
  LEFT JOIN users sender ON sender.id = r.sent_by
  LEFT JOIN iron_batches b ON b.id = r.batch_id`

/**
 * Builds the parameterized SQL `WHERE` clause for `iron_send_records` queries based on account scope and filters.
 */
function ironWhere(scope: AccountScope, filters: IronFilters, params: unknown[]): string {
  const parts = [accountCondition(scope, "COALESCE(r.marketplace_id, er.marketplace_id)", params)]
  if (filters.state === "cancelled") parts.push("r.status = 'cancelled'")
  else if (filters.state === "cleared") parts.push("r.status = 'cleared'")
  else if (filters.state !== "all") parts.push("r.status = 'open'")
  if (filters.marketplaceId) {
    params.push(filters.marketplaceId)
    parts.push(`COALESCE(r.marketplace_id, er.marketplace_id) = $${params.length}`)
  }
  if (filters.batchId) {
    params.push(filters.batchId)
    parts.push(`r.batch_id = $${params.length}`)
  } else if (filters.state === "batched") {
    parts.push("r.batch_id IS NOT NULL")
  } else if (filters.state === "unbatched" || filters.state === "pending" || filters.state === "open") {
    // Only tracking records for which a batch has NOT yet been created appear in the pending/open Iron Send list.
    // Once a batch is created for a tracking record, it moves to the Batched section.
    parts.push("r.batch_id IS NULL")
  }
  const search = (filters.search || "").trim()
  if (search) {
    params.push(`%${search.toUpperCase()}%`)
    const p = `$${params.length}`
    parts.push(
      `(UPPER(COALESCE(rs.tracking_id_snapshot, er.tracking_id, '')) LIKE ${p}
        OR UPPER(COALESCE(rs.order_number_snapshot, er.order_number, '')) LIKE ${p}
        OR UPPER(i.marketplace_sku) LIKE ${p} OR UPPER(i.product_sku) LIKE ${p})`,
    )
  }
  if (filters.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(filters.dateFrom)) {
    params.push(filters.dateFrom)
    parts.push(`(r.sent_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}::date`)
  }
  if (filters.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(filters.dateTo)) {
    params.push(filters.dateTo)
    parts.push(`(r.sent_at AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}::date`)
  }
  return parts.join(" AND ")
}

/**
 * Maps a raw database row from `RECORD_SQL` into an `IronRecordView`.
 */
function toView(row: Record<string, unknown>, now: Date, overdueDays: number): IronRecordView {
  const sentAt = new Date(row.sent_at as string)
  const dueAt = row.expected_return_at ? new Date(row.expected_return_at as string) : null
  const qtySent = Number(row.qty_sent)
  const qtyReceived = Number(row.received)
  const marketplaceSku = String(row.marketplace_sku || "")
  const productSku = String(row.product_sku || "")
  const rowStatus = row.status === "cancelled" ? "cancelled" : row.status === "cleared" ? "cleared" : "open"
  return {
    id: Number(row.id),
    scanId: Number(row.receipt_scan_id),
    state: ironStateOf({
      status: rowStatus,
      qtySent,
      qtyReceived,
      sentAt,
      now,
      overdueAfterDays: overdueDays,
      dueAt,
    }),
    marketplace: String(row.marketplace || ""),
    marketplaceId: row.marketplace_id === null || row.marketplace_id === undefined ? null : Number(row.marketplace_id),
    trackingId: String(row.tracking_id || ""),
    orderId: String(row.order_number || ""),
    marketplaceSku,
    productSku,
    productName: String(row.product_name || ""),
    size: extractGarmentSize(marketplaceSku) || extractGarmentSize(productSku) || "",
    imageUrl: String(row.image_url || ""),
    qtySent,
    qtyReceived,
    qtyPending: Math.max(0, qtySent - qtyReceived),
    sentAt: sentAt.toISOString(),
    sentBy: String(row.sent_by || ""),
    ageDays: Math.max(0, Math.floor((now.getTime() - sentAt.getTime()) / (24 * 3600_000))),
    lastReceivedAt: row.last_received_at ? new Date(row.last_received_at as string).toISOString() : null,
    notes: String(row.notes || ""),
    batchId: row.batch_id === null || row.batch_id === undefined ? null : Number(row.batch_id),
    batchNo: row.batch_no ? String(row.batch_no) : null,
    dueAt: dueAt ? dueAt.toISOString() : null,
    receipts: [],
  }
}

/**
 * Lists Iron Send records and computes the aggregated `IronSummary` for the caller's account scope.
 */
export async function listIronRecords(
  db: pg.Pool,
  scope: AccountScope,
  filters: IronFilters,
  limit = 500,
): Promise<{ rows: IronRecordView[]; summary: IronSummary }> {
  const overdueDays = await getOverdueDays(db)
  const now = new Date()
  const state = filters.state || "open"
  const params: unknown[] = []
  const whereState =
    state === "cancelled"
      ? "cancelled"
      : state === "cleared"
        ? "cleared"
        : state === "all"
          ? "all"
          : state === "batched"
            ? "batched"
            : state === "unbatched" || state === "pending" || state === "open"
              ? state
              : "open-or-done"
  const where = ironWhere(scope, { ...filters, state: whereState }, params)
  const result = await db.query(`${RECORD_SQL} WHERE ${where} ORDER BY r.sent_at ASC, r.id ASC LIMIT 5000`, params)
  let rows = result.rows.map((row) => toView(row, now, overdueDays))
  if (state === "open") rows = rows.filter((row) => row.state !== "received")
  else if (state === "unbatched") rows = rows.filter((row) => row.state !== "received" && row.qtyReceived === 0)
  else if (["pending", "partial", "overdue", "received"].includes(state)) rows = rows.filter((row) => row.state === state)
  const summary = await ironSummary(db, scope, filters.marketplaceId ?? null)
  return { rows: rows.slice(0, Math.max(1, Math.min(limit, 2000))), summary }
}

/**
 * Computes account-scoped summary KPI figures for Iron Send records, unbatched pending lines,
 * active batches, and cleared records.
 */
export async function ironSummary(db: pg.Pool, scope: AccountScope, marketplaceId: number | null = null): Promise<IronSummary> {
  const overdueDays = await getOverdueDays(db)
  const params: unknown[] = []
  const where = ironWhere(scope, { state: "open-or-done", marketplaceId }, params)
  params.push(overdueDays)
  const daysParam = `$${params.length}`
  const result = await db.query(
    `WITH rec AS (
       SELECT r.id, r.qty_sent, r.sent_at, r.batch_id,
              COALESCE((SELECT SUM(e.qty) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id), 0)::int AS received,
              COALESCE(b.expected_return_at, r.sent_at + make_interval(days => ${daysParam})) AS due_at
       FROM iron_send_records r
       JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       JOIN receipt_scan_items i ON i.id = r.receipt_scan_item_id
       LEFT JOIN iron_batches b ON b.id = r.batch_id
       WHERE ${where}
     )
     SELECT
       COUNT(*) FILTER (WHERE qty_sent > received)::int AS open_records,
       COUNT(*) FILTER (WHERE qty_sent > received AND received = 0 AND due_at >= now())::int AS pending_records,
       COUNT(*) FILTER (WHERE qty_sent > received AND received > 0 AND due_at >= now())::int AS partial_records,
       COUNT(*) FILTER (WHERE qty_sent > received AND due_at < now())::int AS overdue_records,
       COUNT(*) FILTER (WHERE qty_sent > received AND received = 0 AND batch_id IS NULL)::int AS unbatched_records,
       COALESCE(SUM(qty_sent) FILTER (WHERE qty_sent > received AND received = 0 AND batch_id IS NULL), 0)::int AS unbatched_units,
       COUNT(*) FILTER (WHERE qty_sent > received AND received = 0 AND batch_id IS NULL
                         AND (sent_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS unbatched_today_records,
       COALESCE(SUM(qty_sent) FILTER (WHERE qty_sent > received AND received = 0 AND batch_id IS NULL
                         AND (sent_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::int AS unbatched_today_units,
       COUNT(*) FILTER (WHERE qty_sent <= received)::int AS received_records,
       COALESCE(SUM(qty_sent), 0)::int AS units_sent,
       COALESCE(SUM(received), 0)::int AS units_received,
       COALESCE(SUM(GREATEST(qty_sent - received, 0)), 0)::int AS units_pending,
       COALESCE(SUM(GREATEST(qty_sent - received, 0)) FILTER (WHERE due_at < now()), 0)::int AS units_overdue,
       COALESCE((SELECT SUM(e.qty) FROM iron_receive_events e
                 WHERE e.iron_send_record_id IN (SELECT id FROM rec)
                   AND (e.received_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::int AS received_today
     FROM rec`,
    params,
  )
  const row = result.rows[0] ?? {}

  const batchParams: unknown[] = []
  const batchScope = accountCondition(scope, "COALESCE(r.marketplace_id, er.marketplace_id)", batchParams)
  const batchMpSql = marketplaceId
    ? (() => {
        batchParams.push(marketplaceId)
        return `AND COALESCE(r.marketplace_id, er.marketplace_id) = $${batchParams.length}`
      })()
    : ""
  const batchRes = await db.query(
    `WITH visible_batches AS (
       SELECT b.id, b.handover_status, b.batch_date, COALESCE(SUM(r.qty_sent), 0)::int AS qty_sent
       FROM iron_batches b
       JOIN iron_send_records r ON r.batch_id = b.id AND r.status = 'open'
       JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       WHERE ${batchScope} ${batchMpSql}
       GROUP BY b.id, b.handover_status, b.batch_date
     )
     SELECT
       COUNT(*)::int AS total_batches,
       COUNT(*) FILTER (WHERE handover_status = 'batch_created')::int AS batch_created,
       COUNT(*) FILTER (WHERE handover_status = 'ready_for_handover')::int AS ready_for_handover,
       COUNT(*) FILTER (WHERE handover_status = 'handed_over')::int AS handed_over,
       COALESCE(SUM(qty_sent), 0)::int AS total_units,
       COUNT(*) FILTER (WHERE batch_date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today_batches
     FROM visible_batches`,
    batchParams,
  )
  const bRow = batchRes.rows[0] ?? {}

  const clearedParams: unknown[] = []
  const clearedWhere = ironWhere(scope, { state: "cleared", marketplaceId }, clearedParams)
  const clearedRes = await db.query(
    `SELECT COUNT(*)::int AS lines, COALESCE(SUM(r.qty_sent), 0)::int AS units
     FROM iron_send_records r
     JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     WHERE ${clearedWhere}`,
    clearedParams,
  )
  const cRow = clearedRes.rows[0] ?? {}

  return {
    overdueAfterDays: overdueDays,
    records: {
      open: Number(row.open_records || 0),
      pending: Number(row.pending_records || 0),
      partial: Number(row.partial_records || 0),
      overdue: Number(row.overdue_records || 0),
      received: Number(row.received_records || 0),
    },
    units: {
      sent: Number(row.units_sent || 0),
      received: Number(row.units_received || 0),
      pending: Number(row.units_pending || 0),
      overdue: Number(row.units_overdue || 0),
    },
    receivedToday: Number(row.received_today || 0),
    unbatched: {
      lines: Number(row.unbatched_records || 0),
      units: Number(row.unbatched_units || 0),
      todayLines: Number(row.unbatched_today_records || 0),
      todayUnits: Number(row.unbatched_today_units || 0),
    },
    batches: {
      total: Number(bRow.total_batches || 0),
      batchCreated: Number(bRow.batch_created || 0),
      readyForHandover: Number(bRow.ready_for_handover || 0),
      handedOver: Number(bRow.handed_over || 0),
      totalUnits: Number(bRow.total_units || 0),
      todayBatches: Number(bRow.today_batches || 0),
    },
    cleared: {
      lines: Number(cRow.lines || 0),
      units: Number(cRow.units || 0),
    },
  }
}

/**
 * Clears pending Iron Send tracking records up to and including `upToDate` (defaulting to today IST).
 * By default clears unbatched records (`r.batch_id IS NULL`); when `includeBatched` is true, also clears
 * unreceived batched records sent on or before `upToDate`.
 * Cleared records are marked `status = 'cleared'` (never deleted), never synced with OMSGuru inventory, and audited.
 */
export async function clearPendingIronRecords(
  db: pg.Pool,
  actor: Actor & { role: string },
  scope: AccountScope,
  input: { upToDate?: string; reason?: string; includeBatched?: boolean } = {},
): Promise<{ clearedRecords: number; clearedUnits: number; upToDate: string }> {
  if (!canClearIron(actor.role)) {
    throw new ServiceError(403, "Only a Supervisor or an Admin can clear pending Iron Send records.")
  }
  const client = await db.connect()
  let open = false
  try {
    await client.query("BEGIN")
    open = true
    const istToday = String(
      (await client.query("SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d")).rows[0].d,
    )
    const upToDate =
      input.upToDate && /^\d{4}-\d{2}-\d{2}$/.test(input.upToDate.trim()) ? input.upToDate.trim() : istToday
    const includeBatched = Boolean(input.includeBatched)
    const reason =
      String(input.reason || "").trim().slice(0, MAX_IRON_NOTES) ||
      `Cleared pending Iron Send tracking records up to ${upToDate} (not synced with OMSGuru inventory)`

    const params: unknown[] = []
    const scopeSql = accountCondition(scope, "COALESCE(r.marketplace_id, er.marketplace_id)", params)
    params.push(upToDate)
    const dateParam = `$${params.length}`
    const batchClause = includeBatched ? "" : "AND r.batch_id IS NULL"

    const locked = await client.query(
      `SELECT r.id, r.qty_sent
       FROM iron_send_records r
       JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       WHERE r.status = 'open'
         ${batchClause}
         AND (r.sent_at AT TIME ZONE 'Asia/Kolkata')::date <= ${dateParam}::date
         AND ${scopeSql}
         AND NOT EXISTS (SELECT 1 FROM iron_receive_events e WHERE e.iron_send_record_id = r.id)
       FOR UPDATE OF r`,
      params,
    )
    const ids = locked.rows.map((row) => Number(row.id))
    const clearedUnits = locked.rows.reduce((sum, row) => sum + Number(row.qty_sent || 0), 0)
    if (ids.length > 0) {
      await client.query(
        `UPDATE iron_send_records
         SET status = 'cleared', cleared_by = $2, cleared_at = now(), clear_reason = $3
         WHERE id = ANY($1::integer[])`,
        [ids, actor.id, reason],
      )
      await client.query(
        `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'iron.clear_pending', 'iron_send_record', $2, $3::jsonb)`,
        [
          actor.id,
          upToDate,
          JSON.stringify({
            clearedRecords: ids.length,
            clearedUnits,
            upToDate,
            includeBatched,
            reason,
            omsguruSync: false,
          }),
        ],
      )
    }
    await client.query("COMMIT")
    open = false
    return { clearedRecords: ids.length, clearedUnits, upToDate }
  } catch (error) {
    if (open) await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function getIronRecord(db: pg.Pool, scope: AccountScope, id: number): Promise<IronRecordView> {
  const overdueDays = await getOverdueDays(db)
  const params: unknown[] = [id]
  const where = ironWhere(scope, { state: "all" }, params)
  const result = await db.query(`${RECORD_SQL} WHERE r.id = $1 AND ${where}`, params)
  const row = result.rows[0]
  if (!row) throw new ServiceError(404, "Iron Send record not found")
  const view = toView(row, new Date(), overdueDays)
  const receipts = await db.query(
    `SELECT e.id, e.qty, e.received_at, e.notes, COALESCE(u.name, '') AS received_by
     FROM iron_receive_events e
     LEFT JOIN users u ON u.id = e.received_by
     WHERE e.iron_send_record_id = $1
     ORDER BY e.received_at, e.id`,
    [id],
  )
  view.receipts = receipts.rows.map((r) => ({
    id: Number(r.id),
    qty: Number(r.qty),
    receivedAt: new Date(r.received_at).toISOString(),
    receivedBy: String(r.received_by),
    notes: String(r.notes || ""),
  }))
  return view
}

// ---------------------------------------------------------------------------------------------------------------
// Inward Team: record ironed units that came back
// ---------------------------------------------------------------------------------------------------------------

export async function receiveIron(
  db: pg.Pool,
  actor: Actor & { role: string },
  scope: AccountScope,
  input: { recordId: number; qty: number; notes: string; clientKey: string | null },
): Promise<{ record: IronRecordView; replayed: boolean }> {
  if (!canReceiveIron(actor.role)) {
    throw new ServiceError(403, "Only the Inward Team can record ironed units as received.")
  }
  const clientKey = input.clientKey && /^[A-Za-z0-9_.:-]{8,120}$/.test(input.clientKey) ? input.clientKey : null
  const notes = String(input.notes || "").trim()
  const client = await db.connect()
  let open = false
  try {
    if (clientKey) {
      const replay = (
        await client.query("SELECT iron_send_record_id FROM iron_receive_events WHERE client_key = $1", [clientKey])
      ).rows[0]
      if (replay) {
        if (Number(replay.iron_send_record_id) !== input.recordId) {
          throw new ServiceError(409, "This entry key was already used for another Iron Send.")
        }
        return { record: await getIronRecord(db, scope, input.recordId), replayed: true }
      }
    }
    await client.query("BEGIN")
    open = true
    const locked = (
      await client.query(
        `SELECT r.id, r.status, r.qty_sent, COALESCE(r.marketplace_id, er.marketplace_id) AS marketplace_id
         FROM iron_send_records r
         JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
         JOIN expected_returns er ON er.id = rs.expected_return_id
         WHERE r.id = $1
         FOR UPDATE OF r`,
        [input.recordId],
      )
    ).rows[0]
    if (!locked || (locked.marketplace_id !== null && !allowsAccount(scope, Number(locked.marketplace_id)))) {
      throw new ServiceError(404, "Iron Send record not found")
    }
    if (locked.status !== "open") {
      throw new ServiceError(
        409,
        locked.status === "cleared"
          ? "This Iron Send record was cleared during the daily batch cutover and is closed."
          : "This Iron Send was cancelled at the scan bench.",
      )
    }
    const received = Number(
      (
        await client.query(
          "SELECT COALESCE(SUM(qty), 0)::int AS n FROM iron_receive_events WHERE iron_send_record_id = $1",
          [input.recordId],
        )
      ).rows[0].n,
    )
    const pending = Number(locked.qty_sent) - received
    const problem = receiveProblem(input.qty, pending, notes)
    if (problem) throw new ServiceError(400, problem)
    const inserted = await client.query(
      `INSERT INTO iron_receive_events (iron_send_record_id, qty, notes, received_by, client_key)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.recordId, input.qty, notes, actor.id, clientKey],
    )
    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'iron.receive', 'iron_send_record', $2, $3::jsonb)`,
      [
        actor.id,
        String(input.recordId),
        JSON.stringify({ eventId: Number(inserted.rows[0].id), qty: input.qty, pendingBefore: pending, pendingAfter: pending - input.qty }),
      ],
    )
    await client.query("COMMIT")
    open = false
    return { record: await getIronRecord(db, scope, input.recordId), replayed: false }
  } catch (error) {
    if (open) await client.query("ROLLBACK")
    const pgError = error as { code?: string; constraint?: string }
    if (pgError.code === "23505" && pgError.constraint === "iron_receive_events_client_key_uidx") {
      return { record: await getIronRecord(db, scope, input.recordId), replayed: true }
    }
    throw error
  } finally {
    client.release()
  }
}

// The marketplace of a record, for the live update. Null when the record is not found.
export async function ironRecordAccount(db: pg.Pool, id: number): Promise<number | null> {
  const row = (
    await db.query(
      `SELECT COALESCE(r.marketplace_id, er.marketplace_id) AS marketplace_id
       FROM iron_send_records r JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id WHERE r.id = $1`,
      [id],
    )
  ).rows[0]
  return row && row.marketplace_id !== null ? Number(row.marketplace_id) : null
}

// ---------------------------------------------------------------------------------------------------------------
// Batches: the Return Team sends pending lines out together, with one batch number on the khaata challan
// ---------------------------------------------------------------------------------------------------------------

export type IronBatchState = "open" | "partial" | "overdue" | "received"

export type IronBatchView = {
  id: number
  batchNo: string
  batchDate: string
  location: IronLocation
  khaataName: string
  challanNo: string
  expectedDays: number
  expectedReturnAt: string
  notes: string
  createdBy: string
  createdAt: string
  state: IronBatchState
  returnTeamStatus: IronReturnTeamStatus
  handoverStatus: IronHandoverStatus
  readyForHandoverAt: string | null
  readyForHandoverBy: string
  handedOverAt: string | null
  handedOverBy: string
  handoverTo: string
  handoverNotes: string
  trackingIds: string[]
  lines: number
  qtySent: number
  qtyReceived: number
  qtyPending: number
  lastReceivedAt: string | null
}

export const MAX_BATCH_TEXT = 120

// The state of a batch from its totals. Pure.
export function ironBatchStateOf(input: { qtySent: number; qtyReceived: number; expectedReturnAt: Date; now: Date }): IronBatchState {
  const pending = Math.max(0, input.qtySent - input.qtyReceived)
  if (input.qtySent > 0 && pending === 0) return "received"
  if (input.now.getTime() > input.expectedReturnAt.getTime()) return "overdue"
  return input.qtyReceived > 0 ? "partial" : "open"
}

const BATCH_SQL = `
  SELECT b.id, b.batch_no,
         to_char(COALESCE(b.batch_date, (b.created_at AT TIME ZONE 'Asia/Kolkata')::date), 'YYYY-MM-DD') AS batch_date,
         b.iron_location, b.khaata_name, b.challan_no, b.expected_days, b.expected_return_at, b.notes, b.created_at,
         COALESCE(b.return_team_status, 'completed') AS return_team_status,
         COALESCE(b.handover_status, 'batch_created') AS handover_status,
         b.ready_for_handover_at,
         COALESCE(rfh_u.name, '') AS ready_for_handover_by,
         b.handed_over_at,
         COALESCE(ho_u.name, '') AS handed_over_by,
         COALESCE(b.handover_to, '') AS handover_to,
         COALESCE(b.handover_notes, '') AS handover_notes,
         COALESCE(u.name, '') AS created_by,
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(TRIM(COALESCE(rs.tracking_id_snapshot, er.tracking_id, '')), '')), NULL) AS tracking_ids,
         COUNT(r.id)::int AS lines,
         COALESCE(SUM(r.qty_sent), 0)::int AS qty_sent,
         COALESCE(SUM((SELECT COALESCE(SUM(e.qty), 0) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id)), 0)::int AS qty_received,
         MAX((SELECT MAX(e.received_at) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id)) AS last_received_at
  FROM iron_batches b
  LEFT JOIN users u ON u.id = b.created_by
  LEFT JOIN users rfh_u ON rfh_u.id = b.ready_for_handover_by
  LEFT JOIN users ho_u ON ho_u.id = b.handed_over_by
  JOIN iron_send_records r ON r.batch_id = b.id AND r.status = 'open'
  JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
  JOIN expected_returns er ON er.id = rs.expected_return_id`

/**
 * Maps a raw database row from `BATCH_SQL` into an `IronBatchView`.
 */
function toBatchView(row: Record<string, unknown>, now: Date): IronBatchView {
  const expectedReturnAt = new Date(row.expected_return_at as string)
  const createdAt = new Date(row.created_at as string)
  const qtySent = Number(row.qty_sent || 0)
  const qtyReceived = Number(row.qty_received || 0)
  const rawTrackings = Array.isArray(row.tracking_ids) ? (row.tracking_ids as unknown[]) : []
  const trackingIds = rawTrackings.map((t) => String(t ?? "").trim()).filter(Boolean)
  return {
    id: Number(row.id),
    batchNo: String(row.batch_no),
    batchDate: String(row.batch_date || createdAt.toISOString().slice(0, 10)),
    location: ironLocationOf(row.iron_location),
    khaataName: String(row.khaata_name || ""),
    challanNo: String(row.challan_no || ""),
    expectedDays: Number(row.expected_days),
    expectedReturnAt: expectedReturnAt.toISOString(),
    notes: String(row.notes || ""),
    createdBy: String(row.created_by || ""),
    createdAt: createdAt.toISOString(),
    state: ironBatchStateOf({ qtySent, qtyReceived, expectedReturnAt, now }),
    returnTeamStatus: "completed",
    handoverStatus: ironHandoverStatusOf(row.handover_status),
    readyForHandoverAt: row.ready_for_handover_at ? new Date(row.ready_for_handover_at as string).toISOString() : null,
    readyForHandoverBy: String(row.ready_for_handover_by || ""),
    handedOverAt: row.handed_over_at ? new Date(row.handed_over_at as string).toISOString() : null,
    handedOverBy: String(row.handed_over_by || ""),
    handoverTo: String(row.handover_to || ""),
    handoverNotes: String(row.handover_notes || ""),
    trackingIds,
    lines: Number(row.lines || 0),
    qtySent,
    qtyReceived,
    qtyPending: Math.max(0, qtySent - qtyReceived),
    lastReceivedAt: row.last_received_at ? new Date(row.last_received_at as string).toISOString() : null,
  }
}

export type IronBatchFilters = {
  state?: string // open | partial | overdue | received | all
  handoverStatus?: string // batch_created | ready_for_handover | handed_over | all
  search?: string
  dateFrom?: string
  dateTo?: string
}

/**
 * Lists Iron Send batches that contain at least one line visible to the caller's account scope.
 */
export async function listIronBatches(
  db: pg.Pool,
  scope: AccountScope,
  filters: IronBatchFilters = {},
): Promise<IronBatchView[]> {
  const params: unknown[] = []
  const parts = [accountCondition(scope, "COALESCE(r.marketplace_id, er.marketplace_id)", params)]
  const handover = (filters.handoverStatus || "").trim().toLowerCase()
  if (handover && handover !== "all" && ["batch_created", "ready_for_handover", "handed_over"].includes(handover)) {
    params.push(handover)
    parts.push(`COALESCE(b.handover_status, 'batch_created') = $${params.length}`)
  }
  if (filters.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(filters.dateFrom)) {
    params.push(filters.dateFrom)
    parts.push(`COALESCE(b.batch_date, (b.created_at AT TIME ZONE 'Asia/Kolkata')::date) >= $${params.length}::date`)
  }
  if (filters.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(filters.dateTo)) {
    params.push(filters.dateTo)
    parts.push(`COALESCE(b.batch_date, (b.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= $${params.length}::date`)
  }
  const search = (filters.search || "").trim()
  if (search) {
    params.push(`%${search.toUpperCase()}%`)
    const p = `$${params.length}`
    parts.push(
      `(UPPER(b.batch_no) LIKE ${p}
        OR UPPER(b.khaata_name) LIKE ${p}
        OR UPPER(b.challan_no) LIKE ${p}
        OR UPPER(COALESCE(b.handover_to, '')) LIKE ${p}
        OR EXISTS (
          SELECT 1 FROM iron_send_records r2
          JOIN receipt_scans rs2 ON rs2.id = r2.receipt_scan_id
          JOIN expected_returns er2 ON er2.id = rs2.expected_return_id
          JOIN receipt_scan_items i2 ON i2.id = r2.receipt_scan_item_id
          WHERE r2.batch_id = b.id AND r2.status = 'open'
            AND (UPPER(COALESCE(rs2.tracking_id_snapshot, er2.tracking_id, '')) LIKE ${p}
                 OR UPPER(COALESCE(rs2.order_number_snapshot, er2.order_number, '')) LIKE ${p}
                 OR UPPER(i2.marketplace_sku) LIKE ${p}
                 OR UPPER(i2.product_sku) LIKE ${p})
        ))`,
    )
  }
  const result = await db.query(
    `${BATCH_SQL} WHERE ${parts.join(" AND ")}
     GROUP BY b.id, u.name, rfh_u.name, ho_u.name
     ORDER BY b.created_at DESC
     LIMIT 500`,
    params,
  )
  const now = new Date()
  const all = result.rows.map((row) => toBatchView(row, now))
  const state = filters.state || "open"
  if (state === "all") return all
  if (state === "open") return all.filter((batch) => batch.state !== "received")
  return all.filter((batch) => batch.state === state)
}

/**
 * Loads a single Iron Send batch and its open lines for the caller's account scope.
 */
export async function getIronBatch(
  db: pg.Pool,
  scope: AccountScope,
  id: number,
): Promise<{ batch: IronBatchView; rows: IronRecordView[] }> {
  const params: unknown[] = [id]
  const scopeSql = accountCondition(scope, "COALESCE(r.marketplace_id, er.marketplace_id)", params)
  const result = await db.query(`${BATCH_SQL} WHERE b.id = $1 AND ${scopeSql} GROUP BY b.id, u.name, rfh_u.name, ho_u.name`, params)
  if (!result.rows[0]) throw new ServiceError(404, "Iron batch not found")
  const { rows } = await listIronRecords(db, scope, { state: "all", batchId: id }, 2000)
  return {
    batch: toBatchView(result.rows[0], new Date()),
    rows: rows.filter((row) => row.state !== "cancelled" && row.state !== "cleared"),
  }
}

function cleanText(value: unknown, label: string, max = MAX_BATCH_TEXT): string {
  const text = String(value ?? "").trim()
  if (text.length > max) throw new ServiceError(400, `${label} must be ${max} characters or fewer.`)
  return text
}

/**
 * Creates a numbered daily Iron Send batch (`IRN-YYMMDD-NNN`) from unbatched pending lines,
 * preventing duplicate tracking/item batching and marking Return Team responsibility as completed.
 */
export async function createIronBatch(
  db: pg.Pool,
  actor: Actor & { role: string },
  scope: AccountScope,
  input: {
    recordIds: number[] | null
    location?: IronLocation
    khaataName: string
    challanNo: string
    expectedDays: number
    notes: string
    clientKey: string | null
  },
): Promise<{ batch: IronBatchView; replayed: boolean }> {
  if (!canDispatchIron(actor.role)) {
    throw new ServiceError(403, "The Return Team makes Iron Send batches. The Inward Team records what comes back.")
  }
  const location = ironLocationOf(input.location)
  const khaataName = location === "in_house" ? IN_HOUSE_IRON_NAME : cleanText(input.khaataName, "Khaata name")
  if (!khaataName) throw new ServiceError(400, "Enter the khaata (ironing unit) the batch goes to.")
  const challanNo = cleanText(input.challanNo, "Challan number")
  const notes = cleanText(input.notes, "Notes", MAX_IRON_NOTES)
  const expectedDays = Number(input.expectedDays)
  if (!Number.isInteger(expectedDays) || expectedDays < 1 || expectedDays > 30) {
    throw new ServiceError(400, "Expected back in must be a whole number of days from 1 to 30.")
  }
  const clientKey = input.clientKey && /^[A-Za-z0-9_.:-]{8,120}$/.test(input.clientKey) ? input.clientKey : null
  if (clientKey) {
    const replay = (await db.query("SELECT id FROM iron_batches WHERE client_key = $1", [clientKey])).rows[0]
    if (replay) return { batch: (await getIronBatch(db, scope, Number(replay.id))).batch, replayed: true }
  }

  const client = await db.connect()
  let open = false
  try {
    await client.query("BEGIN")
    open = true
    // One batch number at a time, across every bench.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('iron_batches.batch_no'))")
    const params: unknown[] = []
    const scopeSql = accountCondition(scope, "COALESCE(r.marketplace_id, er.marketplace_id)", params)
    let idSql = ""
    const wanted = input.recordIds && input.recordIds.length
      ? [...new Set(input.recordIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0)
      : null
    if (wanted) {
      if (!wanted.length) throw new ServiceError(400, "Choose the Iron Send lines for this batch.")
      params.push(wanted)
      idSql = `AND r.id = ANY($${params.length}::integer[])`
    }
    const eligible = await client.query(
      `SELECT r.id, r.receipt_scan_item_id, COALESCE(rs.tracking_id_snapshot, er.tracking_id, '') AS tracking_id
       FROM iron_send_records r
       JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       WHERE r.status = 'open' AND r.batch_id IS NULL ${idSql} AND ${scopeSql}
         AND NOT EXISTS (SELECT 1 FROM iron_receive_events e WHERE e.iron_send_record_id = r.id)
         AND NOT EXISTS (
           SELECT 1 FROM iron_send_records r2
           WHERE r2.id <> r.id
             AND r2.receipt_scan_item_id = r.receipt_scan_item_id
             AND (r2.batch_id IS NOT NULL OR r2.status = 'cleared')
         )
       ORDER BY r.sent_at, r.id
       FOR UPDATE OF r`,
      params,
    )
    // Deduplicate by receipt_scan_item_id so the same tracking/item can never be batched twice.
    const seenItems = new Set<number>()
    const ids: number[] = []
    for (const row of eligible.rows) {
      const itemId = Number(row.receipt_scan_item_id)
      if (seenItems.has(itemId)) continue
      seenItems.add(itemId)
      ids.push(Number(row.id))
    }
    if (wanted && ids.length !== wanted.length) {
      throw new ServiceError(409, "Some chosen lines are already in a batch or were received. Refresh and choose again.")
    }
    if (!ids.length) throw new ServiceError(409, "There are no pending Iron Send lines to put in a batch.")

    const istToday = String(
      (await client.query("SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d")).rows[0].d,
    )
    const sequence = Number(
      (
        await client.query(
          "SELECT COUNT(*)::int + 1 AS n FROM iron_batches WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date",
          [istToday],
        )
      ).rows[0].n,
    )
    const batchNo = ironBatchNumber(istToday, sequence)
    const inserted = await client.query(
      `INSERT INTO iron_batches (
         batch_no, batch_date, iron_location, khaata_name, challan_no, expected_days, expected_return_at,
         notes, created_by, client_key, return_team_status, handover_status
       )
       VALUES ($1, $9::date, $8, $2, $3, $4::int, now() + make_interval(days => $4::int), $5, $6, $7, 'completed', 'batch_created')
       RETURNING id`,
      [batchNo, khaataName, challanNo, expectedDays, notes, actor.id, clientKey, location, istToday],
    )
    const batchId = Number(inserted.rows[0].id)
    await client.query("UPDATE iron_send_records SET batch_id = $1 WHERE id = ANY($2::integer[])", [batchId, ids])
    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'iron.batch_create', 'iron_batch', $2, $3::jsonb)`,
      [
        actor.id,
        String(batchId),
        JSON.stringify({
          batchNo,
          batchDate: istToday,
          lines: ids.length,
          location,
          khaataName,
          challanNo,
          expectedDays,
          returnTeamStatus: "completed",
          handoverStatus: "batch_created",
        }),
      ],
    )
    await client.query("COMMIT")
    open = false
    return { batch: (await getIronBatch(db, scope, batchId)).batch, replayed: false }
  } catch (error) {
    if (open) await client.query("ROLLBACK")
    const pgError = error as { code?: string; constraint?: string }
    if (pgError.code === "23505" && pgError.constraint === "iron_batches_client_key_uidx" && clientKey) {
      const replay = (await db.query("SELECT id FROM iron_batches WHERE client_key = $1", [clientKey])).rows[0]
      if (replay) return { batch: (await getIronBatch(db, scope, Number(replay.id))).batch, replayed: true }
    }
    throw error
  } finally {
    client.release()
  }
}

// Updates a batch's handover workflow status (batch_created -> ready_for_handover -> handed_over)
// and records actor, timestamp, receiving team/person, and handover notes for full accountability.
/**
 * Transitions or updates a batch's Return Team Handover Workflow status
 * (`batch_created` -> `ready_for_handover` -> `handed_over`) with row-level locking and audit logging.
 */
export async function updateIronBatchHandover(
  db: pg.Pool,
  actor: Actor & { role: string },
  scope: AccountScope,
  id: number,
  input: { handoverStatus: unknown; handoverTo?: unknown; handoverNotes?: unknown },
): Promise<IronBatchView> {
  if (!canDispatchIron(actor.role) && !canReceiveIron(actor.role)) {
    throw new ServiceError(403, "You do not have permission to update batch handover status.")
  }
  const rawStatus = String(input.handoverStatus ?? "").trim().toLowerCase()
  if (!["batch_created", "ready_for_handover", "handed_over"].includes(rawStatus)) {
    throw new ServiceError(400, "Handover status must be batch_created, ready_for_handover, or handed_over.")
  }
  const targetStatus = rawStatus as IronHandoverStatus
  const current = (await getIronBatch(db, scope, id)).batch

  const handoverTo =
    input.handoverTo === undefined
      ? current.handoverTo || (targetStatus === "handed_over" ? current.khaataName : "")
      : cleanText(input.handoverTo, "Handed over to")
  const handoverNotes =
    input.handoverNotes === undefined
      ? current.handoverNotes
      : cleanText(input.handoverNotes, "Handover notes", MAX_IRON_NOTES)

  if (targetStatus === "handed_over" && !handoverTo) {
    throw new ServiceError(400, "Enter the receiving team or person name before marking the batch as Handed Over.")
  }

  const client = await db.connect()
  let open = false
  try {
    await client.query("BEGIN")
    open = true
    const lockedRow = (
      await client.query<{ handover_status: string }>(
        "SELECT handover_status FROM iron_batches WHERE id = $1 FOR UPDATE",
        [id],
      )
    ).rows[0]
    if (!lockedRow) throw new ServiceError(404, "Iron Send batch not found.")
    const lockedStatus = ironHandoverStatusOf(lockedRow.handover_status)
    if (lockedStatus === "handed_over" && targetStatus !== "handed_over" && !isAdminRole(actor.role)) {
      throw new ServiceError(
        409,
        "This batch has already been handed over. Only an Admin can reopen its handover status.",
      )
    }

    if (targetStatus === "ready_for_handover") {
      await client.query(
        `UPDATE iron_batches
         SET handover_status = 'ready_for_handover',
             ready_for_handover_at = COALESCE(ready_for_handover_at, now()),
             ready_for_handover_by = COALESCE(ready_for_handover_by, $2),
             handed_over_at = NULL,
             handed_over_by = NULL,
             handover_to = $3,
             handover_notes = $4,
             updated_at = now()
         WHERE id = $1`,
        [id, actor.id, handoverTo, handoverNotes],
      )
    } else if (targetStatus === "handed_over") {
      await client.query(
        `UPDATE iron_batches
         SET handover_status = 'handed_over',
             ready_for_handover_at = COALESCE(ready_for_handover_at, now()),
             ready_for_handover_by = COALESCE(ready_for_handover_by, $2),
             handed_over_at = COALESCE(handed_over_at, now()),
             handed_over_by = COALESCE(handed_over_by, $2),
             handover_to = $3,
             handover_notes = $4,
             updated_at = now()
         WHERE id = $1`,
        [id, actor.id, handoverTo, handoverNotes],
      )
    } else {
      await client.query(
        `UPDATE iron_batches
         SET handover_status = 'batch_created',
             ready_for_handover_at = NULL,
             ready_for_handover_by = NULL,
             handed_over_at = NULL,
             handed_over_by = NULL,
             handover_to = $2,
             handover_notes = $3,
             updated_at = now()
         WHERE id = $1`,
        [id, handoverTo, handoverNotes],
      )
    }

    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'iron.batch_handover', 'iron_batch', $2, $3::jsonb)`,
      [
        actor.id,
        String(id),
        JSON.stringify({
          batchNo: current.batchNo,
          fromStatus: lockedStatus,
          toStatus: targetStatus,
          handoverTo,
          handoverNotes,
        }),
      ],
    )
    await client.query("COMMIT")
    open = false
    return (await getIronBatch(db, scope, id)).batch
  } catch (error) {
    if (open) await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// The challan number often comes after the batch is made. Khaata, challan and notes can be corrected; every change
// is audited with the values it replaced.
export async function updateIronBatch(
  db: pg.Pool,
  actor: Actor & { role: string },
  scope: AccountScope,
  id: number,
  input: { khaataName?: string; challanNo?: string; notes?: string },
): Promise<IronBatchView> {
  if (!canDispatchIron(actor.role)) throw new ServiceError(403, "Only the Return Team can change a batch.")
  const current = await getIronBatch(db, scope, id)
  const next = {
    khaataName:
      input.khaataName === undefined || current.batch.location === "in_house"
        ? current.batch.khaataName
        : cleanText(input.khaataName, "Khaata name"),
    challanNo: input.challanNo === undefined ? current.batch.challanNo : cleanText(input.challanNo, "Challan number"),
    notes: input.notes === undefined ? current.batch.notes : cleanText(input.notes, "Notes", MAX_IRON_NOTES),
  }
  if (!next.khaataName) throw new ServiceError(400, "Enter the khaata (ironing unit) the batch goes to.")
  await db.query("UPDATE iron_batches SET khaata_name = $2, challan_no = $3, notes = $4, updated_at = now() WHERE id = $1", [
    id,
    next.khaataName,
    next.challanNo,
    next.notes,
  ])
  await db.query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'iron.batch_update', 'iron_batch', $2, $3::jsonb)`,
    [
      actor.id,
      String(id),
      JSON.stringify({
        from: { khaataName: current.batch.khaataName, challanNo: current.batch.challanNo, notes: current.batch.notes },
        to: next,
      }),
    ],
  )
  return (await getIronBatch(db, scope, id)).batch
}

// The Inward Team records a whole batch as received back: every pending unit of every line, in one step. It is still
// a manual action, and it writes one receive entry per line, like receiving the lines one by one.
export async function receiveIronBatch(
  db: pg.Pool,
  actor: Actor & { role: string },
  scope: AccountScope,
  id: number,
  input: { notes: string; clientKey: string | null },
): Promise<{ batch: IronBatchView; linesReceived: number; unitsReceived: number }> {
  if (!canReceiveIron(actor.role)) throw new ServiceError(403, "Only the Inward Team can record ironed units as received.")
  const { batch, rows } = await getIronBatch(db, scope, id)
  const keyBase = input.clientKey && /^[A-Za-z0-9_.:-]{8,100}$/.test(input.clientKey) ? input.clientKey : null
  let linesReceived = 0
  let unitsReceived = 0
  for (const row of rows) {
    if (row.qtyPending <= 0) continue
    const result = await receiveIron(db, actor, scope, {
      recordId: row.id,
      qty: row.qtyPending,
      notes: (input.notes || `Batch ${batch.batchNo} received`).slice(0, MAX_IRON_NOTES),
      clientKey: keyBase ? `${keyBase}-${row.id}` : null,
    })
    if (!result.replayed) {
      linesReceived += 1
      unitsReceived += row.qtyPending
    }
  }
  return { batch: (await getIronBatch(db, scope, id)).batch, linesReceived, unitsReceived }
}

const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
})

/**
 * Builds the 2D array of rows for the downloadable Excel/CSV batch sheet.
 */
export function ironBatchSheetRows(batch: IronBatchView, rows: IronRecordView[]): (string | number)[][] {
  const out: (string | number)[][] = [
    ["Youthnic · Iron Send batch"],
    ["Batch No", batch.batchNo],
    ["Ironed at", batch.location === "in_house" ? "Return desk (in-house, high-running pieces)" : "Khaata (sent out)"],
    ["Khaata (ironing unit)", batch.khaataName],
    ["Challan No", batch.challanNo || (batch.location === "in_house" ? "(not needed for in-house ironing)" : "(write the challan number here)")],
    ["Batch Date (IST)", batch.batchDate],
    ["Sent on (IST)", IST_DATE_TIME.format(new Date(batch.createdAt))],
    ["Expected back by (IST)", IST_DATE_TIME.format(new Date(batch.expectedReturnAt))],
    ["Return Team Status", "Completed"],
    ["Handover Status", ironHandoverStatusLabel(batch.handoverStatus)],
    ["Handed Over To", batch.handoverTo || "-"],
    ["Handover Notes", batch.handoverNotes || "-"],
    ["Made by", batch.createdBy],
    ["Notes", batch.notes],
    [],
    ["#", "Product SKU", "Listing SKU", "Size", "Product", "Marketplace", "AWB", "Order", "Qty sent", "Qty received", "Pending"],
  ]
  rows.forEach((row, index) => {
    out.push([
      index + 1,
      row.productSku,
      row.marketplaceSku,
      row.size,
      row.productName,
      row.marketplace,
      row.trackingId,
      row.orderId,
      row.qtySent,
      row.qtyReceived,
      row.qtyPending,
    ])
  })
  out.push(["", "Total", "", "", "", "", "", "", batch.qtySent, batch.qtyReceived, batch.qtyPending])
  return out
}

export function ironBatchXlsx(batch: IronBatchView, rows: IronRecordView[]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(ironBatchSheetRows(batch, rows))
  sheet["!cols"] = [{ wch: 22 }, { wch: 30 }, { wch: 30 }, { wch: 8 }, { wch: 34 }, { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 9 }, { wch: 12 }, { wch: 9 }]
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, batch.batchNo.slice(0, 31))
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer
}

export function ironBatchCsv(batch: IronBatchView, rows: IronRecordView[]): string {
  const cell = (value: unknown) => {
    const text = String(value ?? "")
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return `"${safe.replace(/"/g, '""')}"`
  }
  return ironBatchSheetRows(batch, rows).map((row) => row.map(cell).join(",")).join("\n") + "\n"
}

/**
 * Escapes unsafe HTML characters for printable slip generation.
 */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Generates a self-contained printable/downloadable HTML Batch Slip for handover and warehouse tracking.
 */
export function ironBatchSlipHtml(batch: IronBatchView, rows: IronRecordView[]): string {
  const createdLabel = IST_DATE_TIME.format(new Date(batch.createdAt))
  const expectedLabel = IST_DATE_TIME.format(new Date(batch.expectedReturnAt))
  const handoverLabel = ironHandoverStatusLabel(batch.handoverStatus)
  const readyAtLabel = batch.readyForHandoverAt ? IST_DATE_TIME.format(new Date(batch.readyForHandoverAt)) : "—"
  const handedAtLabel = batch.handedOverAt ? IST_DATE_TIME.format(new Date(batch.handedOverAt)) : "—"
  const locationLabel = batch.location === "in_house" ? "Return desk (in-house)" : "Khaata (sent out)"
  const trackingList = batch.trackingIds.length
    ? batch.trackingIds
    : [...new Set(rows.map((r) => r.trackingId).filter(Boolean))]

  const lineRowsHtml = rows
    .map(
      (row, idx) => `
      <tr>
        <td class="num">${idx + 1}</td>
        <td class="mono">${escapeHtml(row.trackingId || "—")}</td>
        <td class="mono">${escapeHtml(row.orderId || "—")}</td>
        <td>${escapeHtml(row.marketplace || "—")}</td>
        <td class="mono">${escapeHtml(row.productSku || row.marketplaceSku || "—")}</td>
        <td class="mono">${escapeHtml(row.marketplaceSku || "—")}</td>
        <td>${escapeHtml(row.size || "—")}</td>
        <td>${escapeHtml(row.productName || "—")}</td>
        <td class="num"><strong>${row.qtySent}</strong></td>
      </tr>`,
    )
    .join("")

  const trackingPillsHtml = trackingList.length
    ? trackingList.map((t) => `<span class="awb-pill">${escapeHtml(t)}</span>`).join(" ")
    : "<span>—</span>"

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Iron Send Batch Slip · ${escapeHtml(batch.batchNo)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      background: #f8fafc;
      margin: 0;
      padding: 24px;
      font-size: 13px;
      line-height: 1.45;
    }
    .toolbar {
      max-width: 960px;
      margin: 0 auto 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #0f172a;
      color: #fff;
      padding: 10px 16px;
      border-radius: 8px;
    }
    .toolbar button {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 8px 14px;
      font-weight: 600;
      cursor: pointer;
      font-size: 13px;
    }
    .slip {
      max-width: 960px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 24px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 14px;
      margin-bottom: 16px;
    }
    .brand {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #475569;
    }
    .title {
      font-size: 22px;
      font-weight: 800;
      margin: 2px 0 4px;
    }
    .subtitle {
      color: #475569;
      font-size: 12px;
    }
    .badges {
      text-align: right;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-left: 6px;
      border: 1px solid #cbd5e1;
      background: #f1f5f9;
    }
    .badge.done { background: #dcfce7; border-color: #86efac; color: #166534; }
    .badge.handover { background: #dbeafe; border-color: #93c5fd; color: #1e40af; }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 16px;
    }
    .cell {
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 8px 10px;
      background: #f8fafc;
    }
    .cell .k {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748b;
      margin-bottom: 2px;
    }
    .cell .v {
      font-size: 13px;
      font-weight: 700;
      color: #0f172a;
      word-break: break-word;
    }
    .awb-box {
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 16px;
      background: #fff;
    }
    .awb-box .k {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: #475569;
      margin-bottom: 6px;
    }
    .awb-pill {
      display: inline-block;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      padding: 2px 6px;
      margin: 2px 4px 2px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      font-size: 12px;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f1f5f9;
      font-weight: 700;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    td.num, th.num { text-align: right; }
    td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
    tfoot td {
      background: #f8fafc;
      font-weight: 700;
    }
    .signatures {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-top: 24px;
      padding-top: 12px;
    }
    .sig-box {
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 10px 12px;
      min-height: 92px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .sig-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: #475569;
    }
    .sig-meta {
      font-size: 11.5px;
      color: #334155;
      margin-top: 4px;
    }
    .sig-line {
      border-top: 1px dashed #94a3b8;
      padding-top: 4px;
      font-size: 11px;
      color: #64748b;
      margin-top: 24px;
    }
    @media print {
      body { background: #fff; padding: 0; }
      .toolbar { display: none !important; }
      .slip { border: none; padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span><strong>Iron Send Batch Slip</strong> · ${escapeHtml(batch.batchNo)} (${rows.length} lines · ${batch.qtySent} units)</span>
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="slip">
    <div class="header">
      <div>
        <div class="brand">VB Exports · Youthnic Return Operations</div>
        <div class="title">Batch Slip · ${escapeHtml(batch.batchNo)}</div>
        <div class="subtitle">Batch Date: ${escapeHtml(batch.batchDate)} · Created: ${escapeHtml(createdLabel)} · Excluded from OMSGuru Inventory Sync</div>
      </div>
      <div class="badges">
        <span class="badge done">Return Team: Completed</span>
        <span class="badge handover">Handover: ${escapeHtml(handoverLabel)}</span>
        <span class="badge">Inward: ${escapeHtml(batch.state.toUpperCase())}</span>
      </div>
    </div>

    <div class="grid">
      <div class="cell"><div class="k">Batch ID</div><div class="v">${escapeHtml(batch.batchNo)}</div></div>
      <div class="cell"><div class="k">Creation Date</div><div class="v">${escapeHtml(batch.batchDate)}</div></div>
      <div class="cell"><div class="k">Total Tracking IDs</div><div class="v">${trackingList.length}</div></div>
      <div class="cell"><div class="k">Total Quantity</div><div class="v">${batch.qtySent} units (${batch.lines} lines)</div></div>
      <div class="cell"><div class="k">Ironed At</div><div class="v">${escapeHtml(locationLabel)}</div></div>
      <div class="cell"><div class="k">Khaata / Unit</div><div class="v">${escapeHtml(batch.khaataName || "—")}</div></div>
      <div class="cell"><div class="k">Challan No</div><div class="v">${escapeHtml(batch.challanNo || "—")}</div></div>
      <div class="cell"><div class="k">Expected Return</div><div class="v">${escapeHtml(expectedLabel)}</div></div>
      <div class="cell"><div class="k">Created By</div><div class="v">${escapeHtml(batch.createdBy || "—")}</div></div>
      <div class="cell"><div class="k">Ready for Handover</div><div class="v">${escapeHtml(batch.readyForHandoverBy ? `${batch.readyForHandoverBy} (${readyAtLabel})` : readyAtLabel)}</div></div>
      <div class="cell"><div class="k">Handed Over To</div><div class="v">${escapeHtml(batch.handoverTo || "—")}</div></div>
      <div class="cell"><div class="k">Handed Over At</div><div class="v">${escapeHtml(batch.handedOverBy ? `${batch.handedOverBy} (${handedAtLabel})` : handedAtLabel)}</div></div>
    </div>

    <div class="awb-box">
      <div class="k">Tracking IDs in Batch (${trackingList.length})</div>
      <div>${trackingPillsHtml}</div>
    </div>

    <table>
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Tracking ID (AWB)</th>
          <th>Order ID</th>
          <th>Marketplace</th>
          <th>Product SKU</th>
          <th>Listing SKU</th>
          <th>Size</th>
          <th>Product</th>
          <th class="num">Qty</th>
        </tr>
      </thead>
      <tbody>
        ${lineRowsHtml}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="8">Total (${rows.length} lines · ${trackingList.length} tracking IDs)</td>
          <td class="num">${batch.qtySent}</td>
        </tr>
      </tfoot>
    </table>

    ${batch.notes || batch.handoverNotes ? `<div class="awb-box"><div class="k">Batch & Handover Notes</div><div>${escapeHtml([batch.notes, batch.handoverNotes].filter(Boolean).join(" · "))}</div></div>` : ""}

    <div class="signatures">
      <div class="sig-box">
        <div>
          <div class="sig-title">1. Return Team (Completed)</div>
          <div class="sig-meta">Prepared by: ${escapeHtml(batch.createdBy || "Return Team")}<br/>Date: ${escapeHtml(createdLabel)}</div>
        </div>
        <div class="sig-line">Return Team Signature</div>
      </div>
      <div class="sig-box">
        <div>
          <div class="sig-title">2. Handover Verification</div>
          <div class="sig-meta">Status: ${escapeHtml(handoverLabel)}<br/>By: ${escapeHtml(batch.handedOverBy || batch.readyForHandoverBy || "—")}</div>
        </div>
        <div class="sig-line">Handover Dispatcher Signature</div>
      </div>
      <div class="sig-box">
        <div>
          <div class="sig-title">3. Received By (Next Team / Khaata)</div>
          <div class="sig-meta">Receiver: ${escapeHtml(batch.handoverTo || batch.khaataName || "—")}<br/>Date: ${escapeHtml(batch.handedOverAt ? handedAtLabel : "____________________")}</div>
        </div>
        <div class="sig-line">Receiver Name &amp; Signature</div>
      </div>
    </div>
  </div>
</body>
</html>`
}

