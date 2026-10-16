// Dashboard, claims and recent-return figures. Every query takes the user's account scope (server/access.ts), so a
// figure never includes an account the user cannot see. Every figure is read from receipt_scans, expected_returns,
// claim_tickets and marketplaces. Days are IST.
//
// Each query has its own parameter array. A parameter that is not referenced by its query is an error in PostgreSQL,
// so the arrays are never shared.

import type pg from "pg"
import { accountCondition, type AccountScope } from "./access.js"
import { formatCount, formatInr, percentOf } from "./format.js"

const TODAY_IST = "(now() AT TIME ZONE 'Asia/Kolkata')::date"
const SCAN_DAY_IST = "(rs.scanned_at AT TIME ZONE 'Asia/Kolkata')::date"

export type ReturnRecord = {
  id: string
  order_id: string
  sku: string
  marketplace: string
  courier: string
  return_type: string
  issue: string
  ticket: string | null
  status: string
  scanned_time_label: string
  scanned_by: string
}

export type HeadlineTotals = {
  received: number
  issues: number
  clear: number
  received_today: number
  issues_today: number
  claims: number
  open_claims: number
  approved_claims: number
}

// One row per scan. A scan with several tickets shows the first one here. The register lists them all. The caller adds
// the WHERE clause, so the account scope always applies.
const RETURN_SELECT = `
  SELECT
    er.tracking_id AS id,
    er.order_number AS order_id,
    COALESCE(primary_sku.code, '—') AS sku,
    m.name AS marketplace,
    c.name AS courier,
    er.return_type,
    rs.issue_label AS issue,
    ct.ticket_code AS ticket,
    rs.status,
    rs.scanned_time_label,
    scanner.name AS scanned_by
  FROM receipt_scans rs
  JOIN expected_returns er ON er.id = rs.expected_return_id
  JOIN marketplaces m ON m.id = er.marketplace_id
  JOIN couriers c ON c.id = er.courier_id
  JOIN users scanner ON scanner.id = rs.scanned_by
  LEFT JOIN LATERAL (
    SELECT s.code
    FROM expected_return_items eri
    JOIN skus s ON s.id = eri.sku_id
    WHERE eri.expected_return_id = er.id
    ORDER BY eri.sort_order, eri.id
    LIMIT 1
  ) primary_sku ON true
  LEFT JOIN LATERAL (
    SELECT t.ticket_code
    FROM claim_tickets t
    WHERE t.receipt_scan_id = rs.id
    ORDER BY t.id
    LIMIT 1
  ) ct ON true
`

export function mapReturn(row: ReturnRecord) {
  return {
    id: row.id,
    order: row.order_id,
    sku: row.sku,
    market: row.marketplace,
    courier: row.courier,
    type: row.return_type,
    issue: row.issue,
    ticket: row.ticket || "",
    status: row.status,
    time: row.scanned_time_label,
  }
}

// Claim tone used by the claims page colour key.
export function claimTone(status: string) {
  if (status === "Approved" || status === "submitted") return "approved"
  if (status === "Rejected" || status === "failed" || status === "manual_action_required") return "rejected"
  if (status === "Review" || status === "Raised" || status === "ready_for_claim" || status === "processing" || status === "waiting_for_approval") return "review"
  return "draft"
}

export async function listRecentReturns(db: pg.Pool, scope: AccountScope, limit: number): Promise<ReturnRecord[]> {
  const params: unknown[] = []
  const condition = accountCondition(scope, "er.marketplace_id", params)
  params.push(Math.max(1, Math.min(100, Math.floor(limit) || 1)))
  const result = await db.query(
    `${RETURN_SELECT} WHERE ${condition} ORDER BY rs.scanned_at DESC LIMIT $${params.length}`,
    params,
  )
  return result.rows as ReturnRecord[]
}

// Headline counts for the dashboard and claims pages. A claim is open until it is approved or rejected.
export async function loadHeadline(db: pg.Pool, scope: AccountScope): Promise<HeadlineTotals> {
  const params: unknown[] = []
  const scans = accountCondition(scope, "er.marketplace_id", params)
  const allClaimsModern = accountCondition(scope, "c1.marketplace_id", params)
  const allClaimsLegacy = accountCondition(scope, "ce1.marketplace_id", params)
  const openClaimsModern = accountCondition(scope, "c2.marketplace_id", params)
  const openClaimsLegacy = accountCondition(scope, "ce2.marketplace_id", params)
  const approvedClaimsModern = accountCondition(scope, "c3.marketplace_id", params)
  const approvedClaimsLegacy = accountCondition(scope, "ce3.marketplace_id", params)

  const result = await db.query(
    `
    SELECT
      COUNT(rs.id)::int AS received,
      (COUNT(rs.id) FILTER (WHERE rs.outcome = 'issue'))::int AS issues,
      (COUNT(rs.id) FILTER (WHERE rs.outcome = 'clear'))::int AS clear,
      (COUNT(rs.id) FILTER (WHERE ${SCAN_DAY_IST} = ${TODAY_IST}))::int AS received_today,
      (COUNT(rs.id) FILTER (WHERE rs.outcome = 'issue' AND ${SCAN_DAY_IST} = ${TODAY_IST}))::int AS issues_today,
      (SELECT COUNT(*)::int
         FROM (
           SELECT c1.id FROM claims c1 WHERE ${allClaimsModern}
           UNION ALL
           SELECT ct1.id FROM claim_tickets ct1
           JOIN receipt_scans cs1 ON cs1.id = ct1.receipt_scan_id
           JOIN expected_returns ce1 ON ce1.id = cs1.expected_return_id
           WHERE ${allClaimsLegacy} AND NOT EXISTS (SELECT 1 FROM claims cx WHERE cx.receipt_scan_id = ct1.receipt_scan_id)
         ) u1) AS claims,
      (SELECT COUNT(*)::int
         FROM (
           SELECT c2.id FROM claims c2 WHERE c2.status NOT IN ('submitted', 'failed') AND ${openClaimsModern}
           UNION ALL
           SELECT ct2.id FROM claim_tickets ct2
           JOIN receipt_scans cs2 ON cs2.id = ct2.receipt_scan_id
           JOIN expected_returns ce2 ON ce2.id = cs2.expected_return_id
           WHERE ct2.status NOT IN ('Approved', 'Rejected') AND ${openClaimsLegacy}
             AND NOT EXISTS (SELECT 1 FROM claims cx WHERE cx.receipt_scan_id = ct2.receipt_scan_id)
         ) u2) AS open_claims,
      (SELECT COUNT(*)::int
         FROM (
           SELECT c3.id FROM claims c3 WHERE c3.status = 'submitted' AND ${approvedClaimsModern}
           UNION ALL
           SELECT ct3.id FROM claim_tickets ct3
           JOIN receipt_scans cs3 ON cs3.id = ct3.receipt_scan_id
           JOIN expected_returns ce3 ON ce3.id = cs3.expected_return_id
           WHERE ct3.status = 'Approved' AND ${approvedClaimsLegacy}
             AND NOT EXISTS (SELECT 1 FROM claims cx WHERE cx.receipt_scan_id = ct3.receipt_scan_id)
         ) u3) AS approved_claims
    FROM receipt_scans rs
    JOIN expected_returns er ON er.id = rs.expected_return_id
    WHERE ${scans}
    `,
    params,
  )
  return result.rows[0] as HeadlineTotals
}

// Received and issue counts for the last 7 IST days, oldest first. Days with no scans count as zero.
export async function loadDailyBars(db: pg.Pool, scope: AccountScope) {
  const params: unknown[] = []
  const condition = accountCondition(scope, "er.marketplace_id", params)
  const result = await db.query(
    `
    SELECT
      to_char(d.dt, 'Dy') AS weekday,
      to_char(d.dt, 'FMDD') AS d,
      (SELECT COUNT(*)::int
         FROM receipt_scans rs
         JOIN expected_returns er ON er.id = rs.expected_return_id
        WHERE ${SCAN_DAY_IST} = d.dt::date AND ${condition}) AS received,
      (SELECT COUNT(*)::int
         FROM receipt_scans rs
         JOIN expected_returns er ON er.id = rs.expected_return_id
        WHERE rs.outcome = 'issue' AND ${SCAN_DAY_IST} = d.dt::date AND ${condition}) AS issues
    FROM generate_series((${TODAY_IST} - 6)::timestamp, ${TODAY_IST}::timestamp, interval '1 day') AS d(dt)
    ORDER BY d.dt
    `,
    params,
  )
  return result.rows as { weekday: string; d: string; received: number; issues: number }[]
}

// Most common issue labels across the scans the user can see.
export async function loadReasons(db: pg.Pool, scope: AccountScope) {
  const params: unknown[] = []
  const condition = accountCondition(scope, "er.marketplace_id", params)
  const result = await db.query(
    `
    -- The reason is built from the stored issue rows, without operational categories (Iron Send is never a return
    -- issue). Legacy scans, which have no issue rows, keep their stored label.
    SELECT t.reason, COUNT(*)::int AS reason_count
    FROM (
      SELECT COALESCE(
        (SELECT string_agg(DISTINCT x.category_label, '; ')
           FROM receipt_scan_items i
           JOIN receipt_scan_issues x ON x.receipt_scan_item_id = i.id
           LEFT JOIN receipt_issue_categories c ON c.code = x.category_code
          WHERE i.receipt_scan_id = rs.id AND NOT COALESCE(c.is_operational, false)),
        rs.issue_label
      ) AS reason
      FROM receipt_scans rs
      JOIN expected_returns er ON er.id = rs.expected_return_id
      WHERE rs.outcome = 'issue' AND ${condition}
    ) t
    GROUP BY t.reason
    ORDER BY reason_count DESC, t.reason
    LIMIT 6
    `,
    params,
  )
  return result.rows as { reason: string; reason_count: number }[]
}

// Issue returns per marketplace, across the scans the user can see.
export async function loadMarketIssues(db: pg.Pool, scope: AccountScope) {
  const params: unknown[] = []
  const condition = accountCondition(scope, "m.id", params)
  const result = await db.query(
    `
    SELECT m.name AS marketplace_name, COUNT(rs.id)::int AS issue_count
    FROM marketplaces m
    LEFT JOIN expected_returns er ON er.marketplace_id = m.id
    LEFT JOIN receipt_scans rs ON rs.expected_return_id = er.id AND rs.outcome = 'issue'
    WHERE ${condition}
    GROUP BY m.id, m.name, m.sort_order
    HAVING COUNT(rs.id) > 0
    ORDER BY m.sort_order, m.id
    `,
    params,
  )
  return result.rows as { marketplace_name: string; issue_count: number }[]
}

// SKUs with the most issue returns. Each return counts against its first item line.
export async function loadSkuRisk(db: pg.Pool, scope: AccountScope) {
  const params: unknown[] = []
  const condition = accountCondition(scope, "er.marketplace_id", params)
  const result = await db.query(
    `
    SELECT
      s.code,
      s.name,
      (COUNT(*) FILTER (WHERE rs.outcome = 'issue'))::int AS issue_count,
      COUNT(*)::int AS scanned_count
    FROM receipt_scans rs
    JOIN expected_returns er ON er.id = rs.expected_return_id
    JOIN LATERAL (
      SELECT eri.sku_id
      FROM expected_return_items eri
      WHERE eri.expected_return_id = rs.expected_return_id
      ORDER BY eri.sort_order, eri.id
      LIMIT 1
    ) primary_item ON true
    JOIN skus s ON s.id = primary_item.sku_id
    WHERE ${condition}
    GROUP BY s.id, s.code, s.name
    HAVING COUNT(*) FILTER (WHERE rs.outcome = 'issue') > 0
    ORDER BY issue_count DESC, s.code
    LIMIT 5
    `,
    params,
  )
  return result.rows as { code: string; name: string; issue_count: number; scanned_count: number }[]
}

export type OperatorPerf = {
  operator_id: number
  operator_name: string
  shipments_count: number
  items_qty: number
  clear_count: number
  issue_count: number
  clear_rate: string
}

export type MarketplaceProcessing = {
  marketplace_id: number
  marketplace_name: string
  shipments_count: number
  items_qty: number
  clear_count: number
  issue_count: number
}

export type HourlyThroughput = {
  hour: number
  label: string
  shipments: number
  items_qty: number
}

export type WarehouseOperations = {
  scanned_qty_today: number
  scanned_shipments_today: number
  clear_today: number
  issues_today: number
  clear_total: number
  issues_total: number
  duplicate_attempts_today: number
  unmatched_awbs_today: number
  pending_validation_rows: number
  operators: OperatorPerf[]
  marketplaces: MarketplaceProcessing[]
  hourlyThroughput: HourlyThroughput[]
}

export async function loadWarehouseOperations(db: pg.Pool, scope: AccountScope): Promise<WarehouseOperations> {
  const p1: unknown[] = []
  const condition1 = accountCondition(scope, "er.marketplace_id", p1)

  const pPending: unknown[] = []
  const conditionPending = accountCondition(scope, "ub.marketplace_id", pPending)

  const pOp: unknown[] = []
  const conditionOp = accountCondition(scope, "er.marketplace_id", pOp)

  const pMarket: unknown[] = []
  const conditionMarket = accountCondition(scope, "m.id", pMarket)

  const pHourly: unknown[] = []
  const conditionHourly = accountCondition(scope, "er.marketplace_id", pHourly)

  const [countsResult, auditResult, pendingResult, operatorsResult, marketsResult, hourlyResult] = await Promise.all([
    db.query(
      `
      SELECT
        COUNT(rs.id)::int AS scanned_shipments_total,
        (COUNT(rs.id) FILTER (WHERE ${SCAN_DAY_IST} = ${TODAY_IST}))::int AS scanned_shipments_today,
        COALESCE(SUM(rsi.received_qty) FILTER (WHERE ${SCAN_DAY_IST} = ${TODAY_IST}), 0)::int AS scanned_items_today,
        COALESCE(SUM(rsi.received_qty), 0)::int AS scanned_items_total,
        (COUNT(rs.id) FILTER (WHERE rs.outcome = 'clear' AND ${SCAN_DAY_IST} = ${TODAY_IST}))::int AS clear_today,
        (COUNT(rs.id) FILTER (WHERE rs.outcome = 'issue' AND ${SCAN_DAY_IST} = ${TODAY_IST}))::int AS issues_today,
        (COUNT(rs.id) FILTER (WHERE rs.outcome = 'clear'))::int AS clear_total,
        (COUNT(rs.id) FILTER (WHERE rs.outcome = 'issue'))::int AS issues_total
      FROM receipt_scans rs
      JOIN expected_returns er ON er.id = rs.expected_return_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(received_qty), 1) AS received_qty
        FROM receipt_scan_items
        WHERE receipt_scan_id = rs.id
      ) rsi ON true
      WHERE ${condition1}
      `,
      p1,
    ),
    db.query(
      `
      SELECT
        (COUNT(*) FILTER (WHERE ral.action = 'scan.duplicate_attempt'))::int AS duplicate_attempts_today,
        (COUNT(*) FILTER (WHERE ral.action = 'scan.unmatched_lookup'))::int AS unmatched_awbs_today
      FROM register_audit_log ral
      WHERE (ral.occurred_at AT TIME ZONE 'Asia/Kolkata')::date = ${TODAY_IST}
        AND ral.action IN ('scan.duplicate_attempt', 'scan.unmatched_lookup')
      `,
    ),
    db.query(
      `
      SELECT COUNT(ur.id)::int AS pending_rows
      FROM upload_rows ur
      JOIN upload_batches ub ON ub.id = ur.upload_batch_id
      WHERE ur.row_status = 'pending' AND ${conditionPending}
      `,
      pPending,
    ),
    db.query(
      `
      SELECT
        scanner.id AS operator_id,
        scanner.name AS operator_name,
        COUNT(rs.id)::int AS shipments_count,
        COALESCE(SUM(rsi.received_qty), 0)::int AS items_qty,
        (COUNT(rs.id) FILTER (WHERE rs.outcome = 'clear'))::int AS clear_count,
        (COUNT(rs.id) FILTER (WHERE rs.outcome = 'issue'))::int AS issue_count
      FROM receipt_scans rs
      JOIN users scanner ON scanner.id = rs.scanned_by
      JOIN expected_returns er ON er.id = rs.expected_return_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(received_qty), 1) AS received_qty
        FROM receipt_scan_items
        WHERE receipt_scan_id = rs.id
      ) rsi ON true
      WHERE ${SCAN_DAY_IST} = ${TODAY_IST} AND ${conditionOp}
      GROUP BY scanner.id, scanner.name
      ORDER BY items_qty DESC, shipments_count DESC, scanner.name
      `,
      pOp,
    ),
    db.query(
      `
      SELECT
        m.id AS marketplace_id,
        m.name AS marketplace_name,
        COUNT(rs.id)::int AS shipments_count,
        COALESCE(SUM(rsi.received_qty), 0)::int AS items_qty,
        (COUNT(rs.id) FILTER (WHERE rs.outcome = 'clear'))::int AS clear_count,
        (COUNT(rs.id) FILTER (WHERE rs.outcome = 'issue'))::int AS issue_count
      FROM marketplaces m
      JOIN expected_returns er ON er.marketplace_id = m.id
      JOIN receipt_scans rs ON rs.expected_return_id = er.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(received_qty), 1) AS received_qty
        FROM receipt_scan_items
        WHERE receipt_scan_id = rs.id
      ) rsi ON true
      WHERE ${SCAN_DAY_IST} = ${TODAY_IST} AND ${conditionMarket}
      GROUP BY m.id, m.name, m.sort_order
      ORDER BY items_qty DESC, shipments_count DESC, m.sort_order, m.id
      `,
      pMarket,
    ),
    db.query(
      `
      SELECT
        h.hour,
        to_char(('2000-01-01'::date + (h.hour || ' hours')::interval), 'HH12 AM') AS label,
        COALESCE(counts.shipments, 0)::int AS shipments,
        COALESCE(counts.items_qty, 0)::int AS items_qty
      FROM generate_series(0, 23) AS h(hour)
      LEFT JOIN (
        SELECT
          EXTRACT(HOUR FROM (rs.scanned_at AT TIME ZONE 'Asia/Kolkata'))::int AS hr,
          COUNT(rs.id)::int AS shipments,
          COALESCE(SUM(rsi.received_qty), 0)::int AS items_qty
        FROM receipt_scans rs
        JOIN expected_returns er ON er.id = rs.expected_return_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(received_qty), 1) AS received_qty
          FROM receipt_scan_items
          WHERE receipt_scan_id = rs.id
        ) rsi ON true
        WHERE ${SCAN_DAY_IST} = ${TODAY_IST} AND ${conditionHourly}
        GROUP BY hr
      ) counts ON counts.hr = h.hour
      ORDER BY h.hour
      `,
      pHourly,
    ),
  ])

  const counts = countsResult.rows[0] || {
    scanned_shipments_today: 0,
    scanned_items_today: 0,
    clear_today: 0,
    issues_today: 0,
    clear_total: 0,
    issues_total: 0,
  }
  const audit = auditResult.rows[0] || { duplicate_attempts_today: 0, unmatched_awbs_today: 0 }
  const pending = pendingResult.rows[0]?.pending_rows ?? 0

  return {
    scanned_qty_today: Number(counts.scanned_items_today || 0),
    scanned_shipments_today: Number(counts.scanned_shipments_today || 0),
    clear_today: Number(counts.clear_today || 0),
    issues_today: Number(counts.issues_today || 0),
    clear_total: Number(counts.clear_total || 0),
    issues_total: Number(counts.issues_total || 0),
    duplicate_attempts_today: Number(audit.duplicate_attempts_today || 0),
    unmatched_awbs_today: Number(audit.unmatched_awbs_today || 0),
    pending_validation_rows: Number(pending),
    operators: operatorsResult.rows.map((row) => ({
      operator_id: row.operator_id,
      operator_name: row.operator_name,
      shipments_count: Number(row.shipments_count),
      items_qty: Number(row.items_qty),
      clear_count: Number(row.clear_count),
      issue_count: Number(row.issue_count),
      clear_rate: percentOf(Number(row.clear_count), Number(row.shipments_count)),
    })),
    marketplaces: marketsResult.rows.map((row) => ({
      marketplace_id: row.marketplace_id,
      marketplace_name: row.marketplace_name,
      shipments_count: Number(row.shipments_count),
      items_qty: Number(row.items_qty),
      clear_count: Number(row.clear_count),
      issue_count: Number(row.issue_count),
    })),
    hourlyThroughput: hourlyResult.rows.map((row) => ({
      hour: Number(row.hour),
      label: String(row.label),
      shipments: Number(row.shipments),
      items_qty: Number(row.items_qty),
    })),
  }
}

export async function loadDashboard(db: pg.Pool, scope: AccountScope) {
  const [headline, days, reasons, markets, skus, operations] = await Promise.all([
    loadHeadline(db, scope),
    loadDailyBars(db, scope),
    loadReasons(db, scope),
    loadMarketIssues(db, scope),
    loadSkuRisk(db, scope),
    loadWarehouseOperations(db, scope),
  ])
  const issueTotal = markets.reduce((sum, row) => sum + Number(row.issue_count), 0)
  const peak = Math.max(0, ...days.map((day) => day.received))
  // Bar heights are percentages of the busiest day in the window.
  const barHeight = (value: number) => (peak ? Math.round((value / peak) * 100) : 0)
  const weekTotal = days.reduce((sum, day) => sum + day.received, 0)
  const topReason = Math.max(0, ...reasons.map((reason) => reason.reason_count))
  return {
    stats: [
      {
        label: "Items scanned today",
        value: formatCount(operations.scanned_qty_today),
        delta: `${formatCount(operations.scanned_shipments_today)} shipments today (${formatCount(headline.received)} all-time)`,
        icon: "box",
        tone: "blue",
      },
      {
        label: "Clear returns",
        value: formatCount(operations.clear_today),
        delta: `${formatCount(operations.clear_total)} all time (${percentOf(operations.clear_total, headline.received)} rate)`,
        icon: "check",
        tone: "green",
      },
      {
        label: "Issue returns",
        value: formatCount(operations.issues_today),
        delta: `${formatCount(operations.issues_total)} all time (${formatCount(headline.open_claims)} open claims)`,
        icon: "alert",
        tone: "orange",
      },
      {
        label: "Pending & audits",
        value: formatCount(operations.pending_validation_rows),
        delta: `${formatCount(operations.duplicate_attempts_today)} dup attempts · ${formatCount(operations.unmatched_awbs_today)} unmatched today`,
        icon: "file",
        tone: "purple",
      },
    ],
    dailyAvg: (weekTotal / 7).toFixed(1),
    chartBars: days.map((day) => ({
      weekday: String(day.weekday),
      d: String(day.d),
      received: Number(day.received),
      issues: Number(day.issues),
      v: barHeight(Number(day.received)),
      i: barHeight(Number(day.issues)),
    })),
    reasons: reasons.map((reason) => ({
      name: reason.reason,
      count: formatCount(reason.reason_count),
      width: topReason ? Math.round((reason.reason_count / topReason) * 100) : 0,
    })),
    marketIssues: {
      total: formatCount(issueTotal),
      subtitle: `${formatCount(issueTotal)} issue returns across the accounts you can see`,
      slices: markets.map((row) => ({
        name: row.marketplace_name,
        count: formatCount(row.issue_count),
        pct: percentOf(row.issue_count, issueTotal),
        share: issueTotal ? (Number(row.issue_count) / issueTotal) * 100 : 0,
      })),
    },
    skus: skus.map((row) => ({
      sku: row.code,
      name: row.name,
      issues: formatCount(row.issue_count),
      rate: percentOf(row.issue_count, row.scanned_count),
    })),
    operations,
  }
}

const STATUS_LABELS: Record<string, string> = {
  pending_evidence: "Pending Evidence",
  ready_for_claim: "Ready for Claim",
  waiting_for_approval: "Waiting for Approval",
  processing: "Processing",
  submitted: "Submitted",
  failed: "Failed",
  manual_action_required: "Manual Action Required",
  Approved: "Approved",
  Rejected: "Rejected",
  Review: "Under Review",
  Raised: "Raised",
}

export async function loadClaims(db: pg.Pool, scope: AccountScope) {
  const totalsParams: unknown[] = []
  const totalsCondition = accountCondition(scope, "c.marketplace_id", totalsParams)

  const sliceParams: unknown[] = []
  const sliceModernCondition = accountCondition(scope, "c.marketplace_id", sliceParams)
  const sliceLegacyCondition = accountCondition(scope, "er.marketplace_id", sliceParams)

  const rowParams: unknown[] = []
  const rowCondition = accountCondition(scope, "m.id", rowParams)

  const [headline, totalsRes, slices, rows] = await Promise.all([
    loadHeadline(db, scope),
    db.query(
      `
      SELECT
        COUNT(c.id)::int AS total_claims,
        (COUNT(c.id) FILTER (WHERE c.status NOT IN ('submitted', 'failed')))::int AS open_claims,
        (COUNT(c.id) FILTER (WHERE c.status = 'submitted'))::int AS submitted_claims,
        COALESCE(SUM(c.total_price_snapshot), 0)::numeric(12,2) AS total_value,
        COALESCE(SUM(c.total_price_snapshot) FILTER (WHERE c.status = 'submitted'), 0)::numeric(12,2) AS recovered_value
      FROM claims c
      WHERE ${totalsCondition}
      `,
      totalsParams,
    ),
    db.query(
      `
      SELECT status_name, COUNT(*)::int AS claim_count FROM (
        SELECT c.status AS status_name
        FROM claims c
        WHERE ${sliceModernCondition}
        UNION ALL
        SELECT ct.status AS status_name
        FROM claim_tickets ct
        JOIN receipt_scans rs ON rs.id = ct.receipt_scan_id
        JOIN expected_returns er ON er.id = rs.expected_return_id
        WHERE ${sliceLegacyCondition} AND NOT EXISTS (SELECT 1 FROM claims cx WHERE cx.receipt_scan_id = ct.receipt_scan_id)
      ) combined
      GROUP BY status_name
      ORDER BY claim_count DESC, status_name
      `,
      sliceParams,
    ),
    db.query(
      `
      SELECT
        m.name AS market,
        (COUNT(DISTINCT c.id) + COUNT(DISTINCT ct.id))::int AS raised,
        (COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'submitted') + COUNT(DISTINCT ct.id) FILTER (WHERE ct.status = 'Approved'))::int AS approved,
        (COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('ready_for_claim', 'waiting_for_approval', 'processing', 'pending_evidence')) + COUNT(DISTINCT ct.id) FILTER (WHERE ct.status IN ('Review', 'Raised')))::int AS review,
        (COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('failed', 'manual_action_required')) + COUNT(DISTINCT ct.id) FILTER (WHERE ct.status = 'Rejected'))::int AS rejected,
        COALESCE(SUM(c.total_price_snapshot), 0)::numeric(12,2) AS total_val
      FROM marketplaces m
      LEFT JOIN claims c ON c.marketplace_id = m.id
      LEFT JOIN (
        SELECT ct.id, ct.status, er.marketplace_id
        FROM claim_tickets ct
        JOIN receipt_scans rs ON rs.id = ct.receipt_scan_id
        JOIN expected_returns er ON er.id = rs.expected_return_id
        WHERE NOT EXISTS (SELECT 1 FROM claims cx WHERE cx.receipt_scan_id = ct.receipt_scan_id)
      ) ct ON ct.marketplace_id = m.id
      WHERE ${rowCondition}
      GROUP BY m.id, m.name, m.sort_order
      ORDER BY m.sort_order, m.id
      `,
      rowParams,
    ),
  ])

  const totals = totalsRes.rows[0] || {
    total_claims: 0,
    open_claims: 0,
    submitted_claims: 0,
    total_value: "0.00",
    recovered_value: "0.00",
  }

  const claims = Number(headline.claims)
  const totalVal = Number(totals.total_value)
  const recoveredVal = Number(totals.recovered_value)
  const submittedClaims = Number(totals.submitted_claims)

  return {
    stats: [
      {
        label: "Total claims raised",
        value: formatCount(claims),
        delta: `${formatCount(headline.open_claims)} open`,
        icon: "claim",
        tone: "purple",
      },
      {
        label: "Claim value",
        value: totalVal > 0 ? formatInr(totalVal) : "₹0.00",
        delta: totalVal > 0 ? `${formatCount(Number(totals.total_claims))} valued claims` : "No claim values recorded",
        icon: "file",
        tone: "blue",
      },
      {
        label: "Amount recovered",
        value: recoveredVal > 0 ? formatInr(recoveredVal) : "₹0.00",
        delta: recoveredVal > 0 ? `${percentOf(submittedClaims, claims)} submitted / confirmed` : "No recovery amounts recorded",
        icon: "check",
        tone: "green",
      },
      {
        label: "Approval rate",
        value: percentOf(Number(headline.approved_claims), claims),
        delta: "Approved / submitted out of all claims",
        icon: "alert",
        tone: "orange",
      },
    ],
    total: formatCount(claims),
    slices: slices.rows.map((row) => ({
      name: STATUS_LABELS[row.status_name] || row.status_name,
      count: formatCount(row.claim_count),
      pct: percentOf(row.claim_count, claims),
      tone: claimTone(row.status_name),
    })),
    rows: rows.rows.map((row) => ({
      market: row.market,
      raised: formatCount(row.raised),
      approved: formatCount(row.approved),
      review: formatCount(row.review),
      rejected: formatCount(row.rejected),
      value: Number(row.total_val) > 0 ? formatInr(Number(row.total_val)) : "—",
      rate: row.raised ? Math.round((row.approved / row.raised) * 100) : 0,
    })),
  }
}
