// Return analytics: size-wise, SKU-wise, marketplace-wise, date-wise and reason-wise figures, computed from the scans
// that are stored (receipt_scans, receipt_scan_items, receipt_scan_issues). The Reports screen and the weekly email
// both use this module, so they always agree.
//
// Definitions (one place, so every figure means the same thing):
//   scans          physical returns received (one receipt_scans row each)
//   units          units received (receipt_scan_items.received_qty)
//   issue scans    scans whose outcome is 'issue'. Iron Send alone never makes a scan an issue scan.
//   issue units    units on return issues (damaged, wrong, missing, size/SKU change, other). Iron Send is excluded.
//   iron units     units sent for ironing (Iron Send). Reported on their own, never as an issue.
//   issue rate     issue scans / scans
// Days are Indian Standard Time.

import type pg from "pg"
import { accountCondition, type AccountScope } from "./access.js"
import { extractGarmentSize } from "./return-reasons.js"

export type AnalyticsFilters = {
  dateFrom: string // YYYY-MM-DD (IST), inclusive
  dateTo: string // YYYY-MM-DD (IST), inclusive
  marketplaceId?: number | null
  categoryCode?: string // only lines with this issue category ("iron_send" works too)
}

export type AnalyticsCounts = {
  scans: number
  issueScans: number
  units: number
  issueUnits: number
  ironUnits: number
  rtoScans?: number
  customerScans?: number
  rtoUnits?: number
  customerUnits?: number
}

export type InsightCategory = "alert" | "trend" | "catalog" | "channel" | "ops"
export type InsightSeverity = "critical" | "warning" | "info" | "positive"

export type StructuredInsight = {
  id: string
  category: InsightCategory
  severity: InsightSeverity
  badge: string
  title: string
  detail: string
  metric?: string
  action?: string
}

export type AnalyticsReport = {
  filters: AnalyticsFilters
  totals: AnalyticsCounts & {
    clearScans: number
    expectedUnits: number
    missingUnits: number
    issueRatePct: number
    rtoRatioPct?: number
    customerRatioPct?: number
    skus: number
  }
  previous: AnalyticsCounts & {
    dateFrom: string
    dateTo: string
    rtoRatioPct?: number
    customerRatioPct?: number
  }
  byDay: (AnalyticsCounts & { day: string; rtoRatioPct?: number; customerRatioPct?: number })[]
  byWeek: (AnalyticsCounts & { weekStart: string; rtoRatioPct?: number; customerRatioPct?: number })[]
  byMarketplace: (AnalyticsCounts & {
    marketplaceId: number
    marketplace: string
    issueRatePct: number
    rtoRatioPct?: number
    customerRatioPct?: number
  })[]
  bySku: (AnalyticsCounts & { sku: string; marketplaceSku: string; productName: string; size: string; topReason: string })[]
  bySize: (AnalyticsCounts & { size: string; sharePct: number })[]
  byIssueCategory: { code: string; label: string; units: number; lines: number; operational: boolean }[]
  byReason: { reason: string; canonical: string; units: number; scans: number; issueUnits: number }[]
  insights: string[]
  detailedInsights: StructuredInsight[]
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return isoDay(d)
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000)
}

// Checks and fills the filters. The range is at most 366 days. A missing range is the last 30 days (IST).
export function normalizeFilters(input: Partial<AnalyticsFilters>, today: string): AnalyticsFilters {
  let dateTo = input.dateTo && DAY.test(input.dateTo) ? input.dateTo : today
  let dateFrom = input.dateFrom && DAY.test(input.dateFrom) ? input.dateFrom : addDays(dateTo, -29)
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom]
  if (daysBetween(dateFrom, dateTo) > 365) dateFrom = addDays(dateTo, -365)
  const marketplaceId = Number(input.marketplaceId)
  const categoryCode = String(input.categoryCode || "").trim()
  return {
    dateFrom,
    dateTo,
    marketplaceId: Number.isInteger(marketplaceId) && marketplaceId > 0 ? marketplaceId : null,
    categoryCode: /^[a-z_]{1,40}$/.test(categoryCode) ? categoryCode : "",
  }
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0
  return Math.round((part / whole) * 1000) / 10
}

// The size of a line, from the listing SKU first and then the product SKU and name. "Unknown" when none says.
export function sizeOfLine(marketplaceSku: string, productSku: string, productName: string): string {
  return extractGarmentSize(marketplaceSku) || extractGarmentSize(productSku) || extractGarmentSize(productName) || "Unknown"
}

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL", "6XL", "Free Size", "Unknown"]

export function sizeRank(size: string): number {
  const index = SIZE_ORDER.indexOf(size)
  return index === -1 ? SIZE_ORDER.length : index
}

// Short sentences for the screen and the weekly email. Only facts from the figures; nothing is guessed.
export function buildInsights(
  report: Omit<AnalyticsReport, "insights" | "detailedInsights">,
  iron?: { pending: number; overdue: number },
): string[] {
  const out: string[] = []
  const t = report.totals
  if (t.scans === 0) {
    out.push("No returns were scanned in this period.")
    return out
  }
  const prev = report.previous
  if (prev.scans > 0) {
    const change = pct(t.scans - prev.scans, prev.scans)
    out.push(
      `${t.scans.toLocaleString("en-IN")} returns scanned, ${change >= 0 ? "up" : "down"} ${Math.abs(change)}% on the previous period (${prev.scans.toLocaleString("en-IN")}).`,
    )
    const prevRate = pct(prev.issueScans, prev.scans)
    if (Math.abs(t.issueRatePct - prevRate) >= 2) {
      out.push(`Issue rate ${t.issueRatePct}% (previous period ${prevRate}%).`)
    }
  } else {
    out.push(`${t.scans.toLocaleString("en-IN")} returns scanned, issue rate ${t.issueRatePct}%.`)
  }
  if ((t.customerScans ?? 0) > 0 || (t.rtoScans ?? 0) > 0) {
    const custScans = t.customerScans ?? 0
    const rtoScans = t.rtoScans ?? 0
    const custPct = pct(custScans, t.scans)
    const rtoPct = pct(rtoScans, t.scans)
    out.push(`Return mix: ${custPct}% Customer Returns (${custScans.toLocaleString("en-IN")}), ${rtoPct}% RTO (${rtoScans.toLocaleString("en-IN")}).`)
  }
  const worst = [...report.byMarketplace].filter((m) => m.scans >= 20).sort((a, b) => b.issueRatePct - a.issueRatePct)[0]
  if (worst && worst.issueRatePct > 0) {
    out.push(`${worst.marketplace} has the highest issue rate: ${worst.issueRatePct}% of ${worst.scans} returns.`)
  }
  const topSize = [...report.bySize].filter((s) => s.size !== "Unknown").sort((a, b) => b.units - a.units)[0]
  if (topSize) out.push(`Size ${topSize.size} is the most returned size: ${topSize.units} units (${topSize.sharePct}% of units).`)
  const topSku = report.bySku[0]
  if (topSku) out.push(`Most returned SKU: ${topSku.sku} with ${topSku.units} units${topSku.issueUnits ? `, ${topSku.issueUnits} with issues` : ""}.`)
  const topIssue = report.byIssueCategory.find((c) => !c.operational)
  if (topIssue) out.push(`Most common issue: ${topIssue.label} (${topIssue.units} units).`)
  const topReason = report.byReason.find((r) => r.reason !== "Not given")
  if (topReason) out.push(`Top return reason: ${topReason.reason} (${topReason.units} units).`)
  if (t.ironUnits > 0) out.push(`${t.ironUnits} units were sent for ironing. They are not counted as issues.`)
  if (iron && iron.overdue > 0) out.push(`${iron.overdue} ironed units are overdue with the Inward Team (${iron.pending} pending in all).`)
  return out
}

// Structured insight cards with categorical tags, metrics, and actionable hints (inspired by 21st.dev UI design).
export function buildDetailedInsights(
  report: Omit<AnalyticsReport, "insights" | "detailedInsights">,
  iron?: { pending: number; overdue: number },
): StructuredInsight[] {
  const items: StructuredInsight[] = []
  const t = report.totals
  if (t.scans === 0) {
    items.push({
      id: "no-returns",
      category: "trend",
      severity: "info",
      badge: "NO ACTIVITY",
      title: "No returns scanned in this period",
      detail: "No receipt scans were recorded within the selected date range and filter criteria.",
    })
    return items
  }

  const prev = report.previous
  // 1. Volume & Trend
  if (prev.scans > 0) {
    const change = pct(t.scans - prev.scans, prev.scans)
    const isUp = change >= 0
    items.push({
      id: "volume-trend",
      category: "trend",
      severity: isUp && change > 25 ? "warning" : "info",
      badge: "VOLUME TREND",
      title: `${t.scans.toLocaleString("en-IN")} returns received (${isUp ? "+" : ""}${change}% vs previous period)`,
      detail: `Received ${t.scans.toLocaleString("en-IN")} returns (${t.units.toLocaleString("en-IN")} units) across ${t.skus.toLocaleString("en-IN")} SKUs, compared to ${prev.scans.toLocaleString("en-IN")} returns in the prior period.`,
      metric: `${isUp ? "▲" : "▼"} ${Math.abs(change)}% (${t.scans - prev.scans > 0 ? "+" : ""}${(t.scans - prev.scans).toLocaleString("en-IN")})`,
      action: isUp && change > 25 ? "Surge in return volume. Ensure adequate staffing at unboxing and return scanning stations." : undefined,
    })
  } else {
    items.push({
      id: "volume-baseline",
      category: "trend",
      severity: "info",
      badge: "PERIOD VOLUME",
      title: `${t.scans.toLocaleString("en-IN")} returns scanned (${t.units.toLocaleString("en-IN")} units)`,
      detail: `Total of ${t.scans.toLocaleString("en-IN")} physical return parcels received containing ${t.units.toLocaleString("en-IN")} items.`,
      metric: `${t.scans.toLocaleString("en-IN")} scans`,
    })
  }

  // 2. Return Type & Channel Split (Customer Return vs RTO)
  const custScans = t.customerScans ?? 0
  const rtoScans = t.rtoScans ?? 0
  if (custScans > 0 || rtoScans > 0) {
    const custPct = pct(custScans, t.scans)
    const rtoPct = pct(rtoScans, t.scans)
    const isHighRto = rtoPct >= 35
    const ratioStr = rtoScans > 0 ? `${(custScans / rtoScans).toFixed(1)} : 1` : "—"
    items.push({
      id: "channel-split",
      category: "channel",
      severity: isHighRto ? "warning" : "info",
      badge: "RETURN TYPE SPLIT",
      title: `Customer Returns represent ${custPct}% of volume (RTO ${rtoPct}%)`,
      detail: `Breakdown: ${custScans.toLocaleString("en-IN")} Customer Returns (${(t.customerUnits ?? 0).toLocaleString("en-IN")} units) and ${rtoScans.toLocaleString("en-IN")} RTOs (${(t.rtoUnits ?? 0).toLocaleString("en-IN")} units). Customer to RTO ratio stands at ${ratioStr}.`,
      metric: `${custPct}% Cust / ${rtoPct}% RTO`,
      action: isHighRto
        ? "RTO rate is above 35%. Check courier non-delivery reports (NDR) and verify address accuracy at dispatch."
        : "Customer returns represent the majority of returns. Review product descriptions, customer sizing feedback, and quality checks.",
    })
  }

  // 3. Issue & Defect Rate
  if (t.issueRatePct >= 10) {
    items.push({
      id: "issue-rate-high",
      category: "alert",
      severity: "critical",
      badge: "HIGH ISSUE RATE",
      title: `Critical issue rate at ${t.issueRatePct}% (${t.issueScans.toLocaleString("en-IN")} defect returns)`,
      detail: `${t.issueScans.toLocaleString("en-IN")} returns arrived with physical defects, damages, missing items, or wrong products, accounting for ${t.issueUnits.toLocaleString("en-IN")} defective units.`,
      metric: `${t.issueRatePct}% issue rate`,
      action: "Examine damaged packaging and initiate supplier/courier claim filings where applicable.",
    })
  } else if (t.issueRatePct > 0) {
    items.push({
      id: "issue-rate-normal",
      category: "alert",
      severity: t.issueRatePct >= 5 ? "warning" : "positive",
      badge: t.issueRatePct >= 5 ? "DEFECT NOTICE" : "HEALTHY DEFECT RATE",
      title: `Issue rate is ${t.issueRatePct}% (${t.issueScans.toLocaleString("en-IN")} returns with issues)`,
      detail: `${t.issueScans.toLocaleString("en-IN")} returns flagged with physical issues (${t.issueUnits.toLocaleString("en-IN")} units). ${t.clearScans.toLocaleString("en-IN")} returns arrived completely clear.`,
      metric: `${t.issueRatePct}% issues`,
    })
  }

  // 4. Marketplace Issue Disparity
  const mktsWithScans = [...report.byMarketplace].filter((m) => m.scans >= 10)
  const worstMkt = [...mktsWithScans].sort((a, b) => b.issueRatePct - a.issueRatePct)[0]
  if (worstMkt && worstMkt.issueRatePct > (t.issueRatePct || 5)) {
    items.push({
      id: `mkt-risk-${worstMkt.marketplaceId}`,
      category: "alert",
      severity: worstMkt.issueRatePct >= 12 ? "warning" : "info",
      badge: "MARKETPLACE DEFECTS",
      title: `${worstMkt.marketplace} exhibits highest defect rate (${worstMkt.issueRatePct}%)`,
      detail: `${worstMkt.issueScans} of ${worstMkt.scans} returns from ${worstMkt.marketplace} had issues (${worstMkt.issueUnits} units). Average issue rate across all channels is ${t.issueRatePct}%.`,
      metric: `${worstMkt.issueRatePct}% on ${worstMkt.marketplace}`,
      action: `Audit returns received under ${worstMkt.marketplace} to verify if courier mishandling or wrong items are concentrated on this channel.`,
    })
  }

  // 5. Channel Volume Leader
  if (report.byMarketplace.length > 1) {
    const topMkt = [...report.byMarketplace].sort((a, b) => b.scans - a.scans)[0]
    if (topMkt && topMkt.scans > 0) {
      const share = pct(topMkt.scans, t.scans)
      if (share >= 35) {
        items.push({
          id: `mkt-vol-${topMkt.marketplaceId}`,
          category: "channel",
          severity: "info",
          badge: "VOLUME CONCENTRATION",
          title: `${topMkt.marketplace} accounts for ${share}% of all returns`,
          detail: `${topMkt.scans.toLocaleString("en-IN")} returns (${topMkt.units.toLocaleString("en-IN")} units) were processed from ${topMkt.marketplace}. RTO share on this channel is ${pct(topMkt.rtoScans ?? 0, topMkt.scans)}%.`,
          metric: `${share}% volume share`,
        })
      }
    }
  }

  // 6. Garment Sizing Concentration
  const topSize = [...report.bySize].filter((s) => s.size !== "Unknown").sort((a, b) => b.units - a.units)[0]
  if (topSize && topSize.units > 0) {
    const isConcentrated = topSize.sharePct >= 30
    items.push({
      id: "size-concentration",
      category: "catalog",
      severity: isConcentrated ? "warning" : "info",
      badge: "SIZE CONCENTRATION",
      title: `Size ${topSize.size} leads returns with ${topSize.sharePct}% share (${topSize.units.toLocaleString("en-IN")} units)`,
      detail: `Garment size ${topSize.size} was returned most frequently (${topSize.units.toLocaleString("en-IN")} units, ${topSize.issueUnits.toLocaleString("en-IN")} with issues). Heavy size concentration often signals a fit or grading variance.`,
      metric: `Size ${topSize.size} (${topSize.sharePct}%)`,
      action: isConcentrated
        ? `Review garment dimensions and size charts for size ${topSize.size} against buyer fit expectations.`
        : undefined,
    })
  }

  // 7. Top Returned SKU Driver
  const topSku = report.bySku[0]
  if (topSku && topSku.units > 0) {
    const skuShare = pct(topSku.units, t.units)
    items.push({
      id: "top-sku",
      category: "catalog",
      severity: topSku.issueUnits > 5 ? "warning" : "info",
      badge: "TOP SKU RETURN",
      title: `Top returned SKU: ${topSku.sku} (${topSku.units.toLocaleString("en-IN")} units)`,
      detail: `${topSku.sku}${topSku.productName ? ` (${topSku.productName})` : ""} represents ${skuShare}% of all returned units (${topSku.units.toLocaleString("en-IN")} units, ${topSku.issueUnits.toLocaleString("en-IN")} with issues).${topSku.topReason ? ` Most stated reason: "${topSku.topReason}".` : ""}`,
      metric: `${topSku.units} units (${skuShare}%)`,
      action: topSku.issueUnits > 5 ? "Inspect SKU fabric quality and packaging integrity at dispatch." : undefined,
    })
  }

  // 8. Top Reason
  const topReason = report.byReason.find((r) => r.reason !== "Not given")
  if (topReason && topReason.units > 0) {
    const reasonShare = pct(topReason.units, t.units)
    items.push({
      id: "top-reason",
      category: "catalog",
      severity: "info",
      badge: "PRIMARY RETURN REASON",
      title: `Top reason: "${topReason.reason}" (${reasonShare}% of units)`,
      detail: `${topReason.units.toLocaleString("en-IN")} units returned under "${topReason.reason}" across ${topReason.scans.toLocaleString("en-IN")} returns${topReason.canonical ? ` (canonical category: ${topReason.canonical})` : ""}.`,
      metric: `${topReason.units} units`,
    })
  }

  // 9. Operational & Iron Status
  if (iron && iron.overdue > 0) {
    items.push({
      id: "iron-overdue",
      category: "ops",
      severity: "critical",
      badge: "INWARD OVERDUE",
      title: `${iron.overdue.toLocaleString("en-IN")} ironed units overdue with Inward Team`,
      detail: `There are ${iron.pending.toLocaleString("en-IN")} units currently pending with the Inward Team, of which ${iron.overdue.toLocaleString("en-IN")} units have exceeded the overdue SLA.`,
      metric: `${iron.overdue} overdue`,
      action: "Directly coordinate with the Inward Team to reconcile and receive overdue ironed stock.",
    })
  } else if (t.ironUnits > 0) {
    items.push({
      id: "iron-send",
      category: "ops",
      severity: "info",
      badge: "IRON SEND",
      title: `${t.ironUnits.toLocaleString("en-IN")} units sent for ironing`,
      detail: `${t.ironUnits.toLocaleString("en-IN")} return units routed to Iron Send for refurbishment. These are operational workflows and not classified as defective returns.`,
      metric: `${t.ironUnits} units`,
    })
  }

  return items
}

type Where = { sql: string; params: unknown[] }

function scanWhere(scope: AccountScope, filters: AnalyticsFilters, from: string, to: string): Where {
  const params: unknown[] = []
  const parts = [accountCondition(scope, "er.marketplace_id", params)]
  params.push(from)
  parts.push(`(rs.scanned_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}::date`)
  params.push(to)
  parts.push(`(rs.scanned_at AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}::date`)
  if (filters.marketplaceId) {
    params.push(filters.marketplaceId)
    parts.push(`er.marketplace_id = $${params.length}`)
  }
  if (filters.categoryCode) {
    params.push(filters.categoryCode)
    parts.push(
      `EXISTS (SELECT 1 FROM receipt_scan_issues fx WHERE fx.receipt_scan_item_id = i.id AND fx.category_code = $${params.length})`,
    )
  }
  return { sql: parts.join(" AND "), params }
}

// One row per scanned line, with its issue and Iron Send quantities. Every figure below is a sum over these lines.
function linesCte(where: string): string {
  return `
    lines AS (
      SELECT rs.id AS scan_id, rs.outcome, er.marketplace_id, m.name AS marketplace,
             (rs.scanned_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
             i.id AS item_id, i.received_qty, i.expected_qty,
             COALESCE(NULLIF(i.product_sku, ''), NULLIF(i.marketplace_sku, ''), 'Not resolved') AS sku,
             i.marketplace_sku, i.product_sku, i.product_name,
             COALESCE(NULLIF(btrim(i.return_reason), ''), NULLIF(btrim(er.return_reason), ''), 'Not given') AS reason,
             COALESCE(crr.label, '') AS canonical,
             CASE
               WHEN (er.return_type = 'RTO' OR er.return_type ILIKE '%rto%' OR er.return_type ILIKE '%courier%' OR er.return_type ILIKE '%undelivered%')
               THEN 'RTO'
               ELSE 'Customer Return'
             END AS return_type,
             COALESCE((SELECT SUM(x.qty) FROM receipt_scan_issues x
                        LEFT JOIN receipt_issue_categories c ON c.code = x.category_code
                        WHERE x.receipt_scan_item_id = i.id AND NOT COALESCE(c.is_operational, false)), 0)::int AS issue_units,
             COALESCE((SELECT SUM(x.qty) FROM receipt_scan_issues x
                        JOIN receipt_issue_categories c ON c.code = x.category_code AND c.is_operational
                        WHERE x.receipt_scan_item_id = i.id), 0)::int AS iron_units
      FROM receipt_scans rs
      JOIN expected_returns er ON er.id = rs.expected_return_id
      JOIN marketplaces m ON m.id = er.marketplace_id
      JOIN receipt_scan_items i ON i.receipt_scan_id = rs.id
      LEFT JOIN canonical_return_reasons crr ON crr.category_code = er.canonical_reason_code
      WHERE ${where}
    )`
}

const COUNT_COLUMNS = `
  COUNT(DISTINCT scan_id)::int AS scans,
  COUNT(DISTINCT scan_id) FILTER (WHERE outcome = 'issue')::int AS issue_scans,
  COALESCE(SUM(received_qty), 0)::int AS units,
  COALESCE(SUM(issue_units), 0)::int AS issue_units,
  COALESCE(SUM(iron_units), 0)::int AS iron_units,
  COUNT(DISTINCT scan_id) FILTER (WHERE return_type = 'RTO')::int AS rto_scans,
  COUNT(DISTINCT scan_id) FILTER (WHERE return_type = 'Customer Return')::int AS customer_scans,
  COALESCE(SUM(received_qty) FILTER (WHERE return_type = 'RTO'), 0)::int AS rto_units,
  COALESCE(SUM(received_qty) FILTER (WHERE return_type = 'Customer Return'), 0)::int AS customer_units`

function counts(row: Record<string, unknown>): AnalyticsCounts {
  return {
    scans: Number(row.scans || 0),
    issueScans: Number(row.issue_scans || 0),
    units: Number(row.units || 0),
    issueUnits: Number(row.issue_units || 0),
    ironUnits: Number(row.iron_units || 0),
    rtoScans: Number(row.rto_scans || 0),
    customerScans: Number(row.customer_scans || 0),
    rtoUnits: Number(row.rto_units || 0),
    customerUnits: Number(row.customer_units || 0),
  }
}

export async function loadAnalytics(
  db: pg.Pool,
  scope: AccountScope,
  input: Partial<AnalyticsFilters>,
  options: { today?: string; iron?: { pending: number; overdue: number } } = {},
): Promise<AnalyticsReport> {
  const today = options.today ?? isoDay(new Date(Date.now() + 330 * 60_000))
  const filters = normalizeFilters(input, today)
  const span = daysBetween(filters.dateFrom, filters.dateTo) + 1
  const prevTo = addDays(filters.dateFrom, -1)
  const prevFrom = addDays(prevTo, -(span - 1))

  const cur = scanWhere(scope, filters, filters.dateFrom, filters.dateTo)
  const prev = scanWhere(scope, filters, prevFrom, prevTo)
  const withLines = `WITH ${linesCte(cur.sql)}`

  const [totals, previous, byDay, byWeek, byMarketplace, bySkuRaw, byCategory, byReason] = await Promise.all([
    db.query(
      `${withLines}
       SELECT ${COUNT_COLUMNS},
              COUNT(DISTINCT scan_id) FILTER (WHERE outcome = 'clear')::int AS clear_scans,
              COALESCE(SUM(expected_qty), 0)::int AS expected_units,
              COALESCE(SUM(expected_qty - received_qty), 0)::int AS missing_units,
              COUNT(DISTINCT sku)::int AS skus
       FROM lines`,
      cur.params,
    ),
    db.query(`WITH ${linesCte(prev.sql)} SELECT ${COUNT_COLUMNS} FROM lines`, prev.params),
    db.query(`${withLines} SELECT day::text AS day, ${COUNT_COLUMNS} FROM lines GROUP BY day ORDER BY day`, cur.params),
    db.query(
      `${withLines} SELECT date_trunc('week', day)::date::text AS week_start, ${COUNT_COLUMNS}
       FROM lines GROUP BY week_start ORDER BY week_start`,
      cur.params,
    ),
    db.query(
      `${withLines} SELECT marketplace_id, marketplace, ${COUNT_COLUMNS}
       FROM lines GROUP BY marketplace_id, marketplace ORDER BY units DESC, marketplace`,
      cur.params,
    ),
    db.query(
      `${withLines}
       SELECT sku, MIN(marketplace_sku) AS marketplace_sku, MAX(product_name) AS product_name, ${COUNT_COLUMNS},
              (SELECT l2.reason FROM lines l2 WHERE l2.sku = lines.sku AND l2.reason <> 'Not given'
                GROUP BY l2.reason ORDER BY SUM(l2.received_qty) DESC, l2.reason LIMIT 1) AS top_reason
       FROM lines GROUP BY sku ORDER BY units DESC, sku`,
      cur.params,
    ),
    db.query(
      `${withLines}
       SELECT x.category_code AS code, COALESCE(c.label, x.category_code) AS label,
              COALESCE(c.is_operational, false) AS operational,
              SUM(x.qty)::int AS units, COUNT(*)::int AS line_count
       FROM lines
       JOIN receipt_scan_issues x ON x.receipt_scan_item_id = lines.item_id
       LEFT JOIN receipt_issue_categories c ON c.code = x.category_code
       GROUP BY x.category_code, c.label, c.is_operational
       ORDER BY operational, units DESC`,
      cur.params,
    ),
    db.query(
      `${withLines}
       SELECT reason, MAX(canonical) AS canonical, COALESCE(SUM(received_qty), 0)::int AS units,
              COUNT(DISTINCT scan_id)::int AS scans, COALESCE(SUM(issue_units), 0)::int AS issue_units
       FROM lines GROUP BY reason ORDER BY units DESC, reason LIMIT 25`,
      cur.params,
    ),
  ])

  const totalRow = totals.rows[0] ?? {}
  const totalCounts = counts(totalRow)

  const sizeMap = new Map<string, AnalyticsCounts>()
  const bySku = bySkuRaw.rows.map((row) => {
    const c = counts(row)
    const size = sizeOfLine(String(row.marketplace_sku || ""), String(row.sku || ""), String(row.product_name || ""))
    const acc = sizeMap.get(size) ?? {
      scans: 0,
      issueScans: 0,
      units: 0,
      issueUnits: 0,
      ironUnits: 0,
      rtoScans: 0,
      customerScans: 0,
      rtoUnits: 0,
      customerUnits: 0,
    }
    acc.scans += c.scans
    acc.issueScans += c.issueScans
    acc.units += c.units
    acc.issueUnits += c.issueUnits
    acc.ironUnits += c.ironUnits
    acc.rtoScans = (acc.rtoScans ?? 0) + (c.rtoScans ?? 0)
    acc.customerScans = (acc.customerScans ?? 0) + (c.customerScans ?? 0)
    acc.rtoUnits = (acc.rtoUnits ?? 0) + (c.rtoUnits ?? 0)
    acc.customerUnits = (acc.customerUnits ?? 0) + (c.customerUnits ?? 0)
    sizeMap.set(size, acc)
    return {
      ...c,
      sku: String(row.sku),
      marketplaceSku: String(row.marketplace_sku || ""),
      productName: String(row.product_name || ""),
      size,
      topReason: String(row.top_reason || ""),
    }
  })
  const bySize = [...sizeMap.entries()]
    .map(([size, c]) => ({ ...c, size, sharePct: pct(c.units, totalCounts.units) }))
    .sort((a, b) => sizeRank(a.size) - sizeRank(b.size))

  const prevCounts = counts(previous.rows[0] ?? {})
  const base: Omit<AnalyticsReport, "insights" | "detailedInsights"> = {
    filters,
    totals: {
      ...totalCounts,
      clearScans: Number(totalRow.clear_scans || 0),
      expectedUnits: Number(totalRow.expected_units || 0),
      missingUnits: Number(totalRow.missing_units || 0),
      issueRatePct: pct(totalCounts.issueScans, totalCounts.scans),
      rtoRatioPct: pct(totalCounts.rtoScans ?? 0, totalCounts.scans),
      customerRatioPct: pct(totalCounts.customerScans ?? 0, totalCounts.scans),
      skus: Number(totalRow.skus || 0),
    },
    previous: {
      ...prevCounts,
      dateFrom: prevFrom,
      dateTo: prevTo,
      rtoRatioPct: pct(prevCounts.rtoScans ?? 0, prevCounts.scans),
      customerRatioPct: pct(prevCounts.customerScans ?? 0, prevCounts.scans),
    },
    byDay: byDay.rows.map((row) => {
      const c = counts(row)
      return {
        ...c,
        day: String(row.day),
        rtoRatioPct: pct(c.rtoScans ?? 0, c.scans),
        customerRatioPct: pct(c.customerScans ?? 0, c.scans),
      }
    }),
    byWeek: byWeek.rows.map((row) => {
      const c = counts(row)
      return {
        ...c,
        weekStart: String(row.week_start),
        rtoRatioPct: pct(c.rtoScans ?? 0, c.scans),
        customerRatioPct: pct(c.customerScans ?? 0, c.scans),
      }
    }),
    byMarketplace: byMarketplace.rows.map((row) => {
      const c = counts(row)
      return {
        ...c,
        marketplaceId: Number(row.marketplace_id),
        marketplace: String(row.marketplace),
        issueRatePct: pct(c.issueScans, c.scans),
        rtoRatioPct: pct(c.rtoScans ?? 0, c.scans),
        customerRatioPct: pct(c.customerScans ?? 0, c.scans),
      }
    }),
    bySku: bySku.slice(0, 50),
    bySize,
    byIssueCategory: byCategory.rows.map((row) => ({
      code: String(row.code),
      label: String(row.label),
      units: Number(row.units || 0),
      lines: Number(row.line_count || 0),
      operational: Boolean(row.operational),
    })),
    byReason: byReason.rows.map((row) => ({
      reason: String(row.reason),
      canonical: String(row.canonical || ""),
      units: Number(row.units || 0),
      scans: Number(row.scans || 0),
      issueUnits: Number(row.issue_units || 0),
    })),
  }
  return {
    ...base,
    insights: buildInsights(base, options.iron),
    detailedInsights: buildDetailedInsights(base, options.iron),
  }
}

// The report as CSV, one section after the other, for the Download button.
export function analyticsCsv(report: AnalyticsReport): string {
  const cell = (value: unknown) => {
    const text = String(value ?? "")
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return `"${safe.replace(/"/g, '""')}"`
  }
  const lines: string[] = []
  const section = (title: string, header: string[], rows: unknown[][]) => {
    lines.push(cell(title))
    lines.push(header.map(cell).join(","))
    for (const row of rows) lines.push(row.map(cell).join(","))
    lines.push("")
  }
  const f = report.filters
  section(
    "Period",
    ["From", "To", "Returns", "Units", "Customer returns", "RTO returns", "RTO %", "Issue returns", "Issue rate %", "Issue units", "Iron Send units"],
    [
      [
        f.dateFrom,
        f.dateTo,
        report.totals.scans,
        report.totals.units,
        report.totals.customerScans ?? 0,
        report.totals.rtoScans ?? 0,
        `${report.totals.rtoRatioPct ?? 0}%`,
        report.totals.issueScans,
        report.totals.issueRatePct,
        report.totals.issueUnits,
        report.totals.ironUnits,
      ],
    ],
  )
  section(
    "Date-wise",
    ["Date", "Returns", "Units", "Customer returns", "RTO returns", "RTO %", "Issue returns", "Issue units", "Iron Send units"],
    report.byDay.map((d) => [
      d.day,
      d.scans,
      d.units,
      d.customerScans ?? 0,
      d.rtoScans ?? 0,
      `${d.rtoRatioPct ?? 0}%`,
      d.issueScans,
      d.issueUnits,
      d.ironUnits,
    ]),
  )
  section(
    "Marketplace-wise",
    ["Marketplace", "Returns", "Units", "Customer returns", "RTO returns", "RTO %", "Issue returns", "Issue rate %", "Issue units", "Iron Send units"],
    report.byMarketplace.map((m) => [
      m.marketplace,
      m.scans,
      m.units,
      m.customerScans ?? 0,
      m.rtoScans ?? 0,
      `${m.rtoRatioPct ?? 0}%`,
      m.issueScans,
      m.issueRatePct,
      m.issueUnits,
      m.ironUnits,
    ]),
  )
  section(
    "Size-wise",
    ["Size", "Units", "Share %", "Returns", "Issue units", "Iron Send units"],
    report.bySize.map((s) => [s.size, s.units, s.sharePct, s.scans, s.issueUnits, s.ironUnits]),
  )
  section(
    "SKU-wise (top 50)",
    ["SKU", "Marketplace SKU", "Size", "Units", "Returns", "Issue units", "Iron Send units", "Top reason"],
    report.bySku.map((s) => [s.sku, s.marketplaceSku, s.size, s.units, s.scans, s.issueUnits, s.ironUnits, s.topReason]),
  )
  section(
    "Return reason-wise",
    ["Reason", "Canonical reason", "Units", "Returns", "Issue units"],
    report.byReason.map((r) => [r.reason, r.canonical, r.units, r.scans, r.issueUnits]),
  )
  section(
    "Received issues",
    ["Issue", "Units", "Lines", "Counted as issue"],
    report.byIssueCategory.map((c) => [c.label, c.units, c.lines, c.operational ? "No (operational)" : "Yes"]),
  )
  return lines.join("\n")
}
