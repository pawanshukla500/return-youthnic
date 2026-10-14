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
//   overdue   pending, when the record is older than the overdue setting (3 days unless Admin changes it)

import type pg from "pg"
import { accountCondition, allowsAccount, isAdminRole, isInwardRole, type AccountScope } from "./access.js"
import { extractGarmentSize } from "./return-reasons.js"
import { ServiceError, type Actor } from "./register-service.js"

export const DEFAULT_OVERDUE_DAYS = 3
export const MAX_IRON_NOTES = 500

export type IronState = "pending" | "partial" | "overdue" | "received" | "cancelled"

// The state of one record. Pure, so the screen, the email and the tests agree.
export function ironStateOf(input: {
  status: "open" | "cancelled"
  qtySent: number
  qtyReceived: number
  sentAt: Date
  now: Date
  overdueAfterDays: number
}): IronState {
  if (input.status === "cancelled") return "cancelled"
  const pending = Math.max(0, input.qtySent - input.qtyReceived)
  if (pending === 0) return "received"
  const ageMs = input.now.getTime() - input.sentAt.getTime()
  if (ageMs > input.overdueAfterDays * 24 * 3600_000) return "overdue"
  return input.qtyReceived > 0 ? "partial" : "pending"
}

// Only the Inward Team (and an Admin) may record ironed units as received. The Return Team only sends.
export function canReceiveIron(role: string): boolean {
  return isInwardRole(role) || isAdminRole(role)
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
    `SELECT r.id, r.receipt_scan_item_id, r.qty_sent,
            COALESCE((SELECT SUM(e.qty) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id), 0)::int AS received
     FROM iron_send_records r
     WHERE r.receipt_scan_id = $1 AND r.status = 'open'
     FOR UPDATE OF r`,
    [scanId],
  )
  const openByItem = new Map<number, { id: number; qty: number; received: number }>()
  for (const row of open.rows) {
    openByItem.set(Number(row.receipt_scan_item_id), {
      id: Number(row.id),
      qty: Number(row.qty_sent),
      received: Number(row.received),
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
  state?: string // pending | overdue | partial | received | open (pending+partial+overdue) | cancelled | all
  marketplaceId?: number | null
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
  receipts: { id: number; qty: number; receivedAt: string; receivedBy: string; notes: string }[]
}

export type IronSummary = {
  overdueAfterDays: number
  records: { open: number; pending: number; partial: number; overdue: number; received: number }
  units: { sent: number; received: number; pending: number; overdue: number }
  receivedToday: number
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
         COALESCE((SELECT SUM(e.qty) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id), 0)::int AS received,
         (SELECT MAX(e.received_at) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id) AS last_received_at
  FROM iron_send_records r
  JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
  JOIN expected_returns er ON er.id = rs.expected_return_id
  JOIN receipt_scan_items i ON i.id = r.receipt_scan_item_id
  LEFT JOIN marketplaces m ON m.id = COALESCE(r.marketplace_id, er.marketplace_id)
  LEFT JOIN users sender ON sender.id = r.sent_by`

function ironWhere(scope: AccountScope, filters: IronFilters, params: unknown[]): string {
  const parts = [accountCondition(scope, "COALESCE(r.marketplace_id, er.marketplace_id)", params)]
  if (filters.state === "cancelled") parts.push("r.status = 'cancelled'")
  else if (filters.state !== "all") parts.push("r.status = 'open'")
  if (filters.marketplaceId) {
    params.push(filters.marketplaceId)
    parts.push(`COALESCE(r.marketplace_id, er.marketplace_id) = $${params.length}`)
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

function toView(row: Record<string, unknown>, now: Date, overdueDays: number): IronRecordView {
  const sentAt = new Date(row.sent_at as string)
  const qtySent = Number(row.qty_sent)
  const qtyReceived = Number(row.received)
  const marketplaceSku = String(row.marketplace_sku || "")
  const productSku = String(row.product_sku || "")
  return {
    id: Number(row.id),
    scanId: Number(row.receipt_scan_id),
    state: ironStateOf({
      status: row.status === "cancelled" ? "cancelled" : "open",
      qtySent,
      qtyReceived,
      sentAt,
      now,
      overdueAfterDays: overdueDays,
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
    receipts: [],
  }
}

export async function listIronRecords(
  db: pg.Pool,
  scope: AccountScope,
  filters: IronFilters,
  limit = 500,
): Promise<{ rows: IronRecordView[]; summary: IronSummary }> {
  const overdueDays = await getOverdueDays(db)
  const now = new Date()
  const params: unknown[] = []
  const where = ironWhere(scope, { ...filters, state: filters.state === "cancelled" ? "cancelled" : filters.state === "all" ? "all" : "open-or-done" }, params)
  const result = await db.query(`${RECORD_SQL} WHERE ${where} ORDER BY r.sent_at ASC, r.id ASC LIMIT 5000`, params)
  let rows = result.rows.map((row) => toView(row, now, overdueDays))
  const state = filters.state || "open"
  if (state === "open") rows = rows.filter((row) => row.state !== "received")
  else if (["pending", "partial", "overdue", "received"].includes(state)) rows = rows.filter((row) => row.state === state)
  const summary = await ironSummary(db, scope, filters.marketplaceId ?? null)
  return { rows: rows.slice(0, Math.max(1, Math.min(limit, 2000))), summary }
}

export async function ironSummary(db: pg.Pool, scope: AccountScope, marketplaceId: number | null = null): Promise<IronSummary> {
  const overdueDays = await getOverdueDays(db)
  const params: unknown[] = []
  const where = ironWhere(scope, { state: "open-or-done", marketplaceId }, params)
  params.push(overdueDays)
  const daysParam = `$${params.length}`
  const result = await db.query(
    `WITH rec AS (
       SELECT r.id, r.qty_sent, r.sent_at,
              COALESCE((SELECT SUM(e.qty) FROM iron_receive_events e WHERE e.iron_send_record_id = r.id), 0)::int AS received
       FROM iron_send_records r
       JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       JOIN receipt_scan_items i ON i.id = r.receipt_scan_item_id
       WHERE ${where}
     )
     SELECT
       COUNT(*) FILTER (WHERE qty_sent > received)::int AS open_records,
       COUNT(*) FILTER (WHERE qty_sent > received AND received = 0 AND sent_at >= now() - make_interval(days => ${daysParam}))::int AS pending_records,
       COUNT(*) FILTER (WHERE qty_sent > received AND received > 0 AND sent_at >= now() - make_interval(days => ${daysParam}))::int AS partial_records,
       COUNT(*) FILTER (WHERE qty_sent > received AND sent_at < now() - make_interval(days => ${daysParam}))::int AS overdue_records,
       COUNT(*) FILTER (WHERE qty_sent <= received)::int AS received_records,
       COALESCE(SUM(qty_sent), 0)::int AS units_sent,
       COALESCE(SUM(received), 0)::int AS units_received,
       COALESCE(SUM(GREATEST(qty_sent - received, 0)), 0)::int AS units_pending,
       COALESCE(SUM(GREATEST(qty_sent - received, 0)) FILTER (WHERE sent_at < now() - make_interval(days => ${daysParam})), 0)::int AS units_overdue,
       COALESCE((SELECT SUM(e.qty) FROM iron_receive_events e
                 WHERE e.iron_send_record_id IN (SELECT id FROM rec)
                   AND (e.received_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::int AS received_today
     FROM rec`,
    params,
  )
  const row = result.rows[0] ?? {}
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
    if (locked.status !== "open") throw new ServiceError(409, "This Iron Send was cancelled at the scan bench.")
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
