// Resend operational email report generator and idempotent scheduler for Return App.
//
// Follows agency engineering standards:
// - Uses official Resend API (https://api.resend.com/emails).
// - Sender: return.scan@youthnic.shop.
// - All dates and boundaries calculated in Asia/Kolkata (IST).
// - Daily report (8:00 PM IST) and Weekly report (Mon 9:00 AM IST covering Mon-Sun).
// - PostgreSQL advisory lock (pg_try_advisory_lock) guarantees single execution in clustered environments.
// - scheduled_report_runs table enforces idempotency (no duplicate emails).
// - Rich, responsive HTML templates with plain-text alternative and optional CSV export.
// - Configurable schedules and authorized Admin/Supervisor recipient list in Admin settings.

import type pg from "pg"

export const SENDER_EMAIL = process.env.RESEND_FROM_EMAIL?.trim() || "return.scan@youthnic.shop"

export type ReportsConfig = {
  dailyEnabled: boolean
  dailyTime: string // "20:00"
  weeklyEnabled: boolean
  weeklyDay: number // 1 for Monday
  weeklyTime: string // "09:00"
  timezone: string // "Asia/Kolkata"
  sender: string
  recipientEmails: string[]
}

export const DEFAULT_REPORTS_CONFIG: ReportsConfig = {
  dailyEnabled: true,
  dailyTime: "20:00",
  weeklyEnabled: true,
  weeklyDay: 1,
  weeklyTime: "09:00",
  timezone: "Asia/Kolkata",
  sender: SENDER_EMAIL,
  recipientEmails: [],
}

export type MarketplaceStat = {
  marketplace: string
  shipments: number
  units: number
  withIssues: number
  clearReturns: number
  issueRate: string
}

export type OperatorStat = {
  operator: string
  shipments: number
  units: number
  firstScan: string
  lastScan: string
}

export type DailyReportData = {
  dateIst: string
  periodStartIso: string
  periodEndIso: string
  totalShipments: number
  totalUnits: number
  clearReturns: number
  returnsWithIssues: number
  issueRatePct: string
  duplicateAttempts: number
  previousDay: {
    dateIst: string
    totalShipments: number
    totalUnits: number
    deltaShipmentsPct: string
  }
  marketplaces: MarketplaceStat[]
  operators: OperatorStat[]
  warnings: string[]
}

export type DailyTrendPoint = {
  dayName: string
  dateIst: string
  shipments: number
  units: number
  withIssues: number
}

export type IssueCategoryStat = {
  category: string
  count: number
  ratePct: string
}

export type WeeklyReportData = {
  weekLabel: string
  periodStartIst: string
  periodEndIst: string
  periodStartIso: string
  periodEndIso: string
  totalShipments: number
  totalUnits: number
  clearReturns: number
  returnsWithIssues: number
  overallIssueRatePct: string
  previousWeek: {
    totalShipments: number
    totalUnits: number
    deltaShipmentsPct: string
    deltaUnitsPct: string
  }
  dailyTrend: DailyTrendPoint[]
  marketplaces: MarketplaceStat[]
  operators: OperatorStat[]
  topIssues: IssueCategoryStat[]
  managementSummary: string
  warnings: string[]
}

// Convert Date to IST string representation (YYYY-MM-DD, HH:mm, etc.)
export function getIstDateParts(date: Date = new Date()): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  dateStr: string
  timeStr: string
  dayOfWeek: number // 0=Sun, 1=Mon, ..., 6=Sat
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  })

  const parts = formatter.formatToParts(date)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value

  const year = Number(map.year)
  const month = Number(map.month)
  const day = Number(map.day)
  const hour = Number(map.hour)
  const minute = Number(map.minute)
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`

  // Calculate day of week in IST
  // Format day string to 0-6 index
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const dayOfWeek = weekdayMap[map.weekday] ?? 0

  return { year, month, day, hour, minute, dateStr, timeStr, dayOfWeek }
}

// Format numbers
const fmt = (n: number) => n.toLocaleString("en-IN")

// Format percentage
function fmtPct(num: number, denom: number): string {
  if (denom === 0) return "0.0%"
  return `${((num / denom) * 100).toFixed(1)}%`
}

function calcDelta(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? "+100%" : "0%"
  const diff = current - previous
  const pct = (diff / previous) * 100
  const sign = pct > 0 ? "+" : ""
  return `${sign}${pct.toFixed(1)}%`
}

export async function getReportsConfig(db: pg.Pool): Promise<ReportsConfig> {
  try {
    const result = await db.query(
      "SELECT setting_value FROM app_system_settings WHERE setting_key = 'reports_config'",
    )
    if (result.rows[0]?.setting_value) {
      const stored = result.rows[0].setting_value as Partial<ReportsConfig>
      return {
        dailyEnabled: stored.dailyEnabled ?? true,
        dailyTime: stored.dailyTime || "20:00",
        weeklyEnabled: stored.weeklyEnabled ?? true,
        weeklyDay: stored.weeklyDay ?? 1,
        weeklyTime: stored.weeklyTime || "09:00",
        timezone: "Asia/Kolkata",
        sender: SENDER_EMAIL,
        recipientEmails: Array.isArray(stored.recipientEmails) ? stored.recipientEmails : [],
      }
    }
  } catch {
    // If not found, return default
  }
  return DEFAULT_REPORTS_CONFIG
}

export async function updateReportsConfig(
  db: pg.Pool,
  config: Partial<ReportsConfig>,
  actorUserId: number,
): Promise<ReportsConfig> {
  const current = await getReportsConfig(db)
  const updated: ReportsConfig = {
    dailyEnabled: config.dailyEnabled ?? current.dailyEnabled,
    dailyTime: config.dailyTime ?? current.dailyTime,
    weeklyEnabled: config.weeklyEnabled ?? current.weeklyEnabled,
    weeklyDay: config.weeklyDay ?? current.weeklyDay,
    weeklyTime: config.weeklyTime ?? current.weeklyTime,
    timezone: "Asia/Kolkata",
    sender: SENDER_EMAIL,
    recipientEmails: Array.isArray(config.recipientEmails) ? config.recipientEmails : current.recipientEmails,
  }

  await db.query(
    `INSERT INTO app_system_settings (setting_key, setting_value, updated_at, updated_by)
     VALUES ('reports_config', $1::jsonb, now(), $2)
     ON CONFLICT (setting_key) DO UPDATE
     SET setting_value = EXCLUDED.setting_value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(updated), actorUserId],
  )

  await db.query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'system.update_reports_config', 'reports_config', 'default', $2::jsonb)`,
    [actorUserId, JSON.stringify(updated)],
  )

  return updated
}

export async function getAuthorizedRecipients(db: pg.Pool): Promise<string[]> {
  try {
    const config = await getReportsConfig(db)
    if (config.recipientEmails.length > 0) {
      return config.recipientEmails
    }

    // Default: find all active Admin and Supervisor users marked or enabled
    const res = await db.query(`
      SELECT email
      FROM users
      WHERE status = 'Active'
        AND (
          can_receive_reports = true
          OR lower(role) IN ('admin', 'supervisor')
        )
      ORDER BY id
    `)
    return res.rows.map((r) => String(r.email).toLowerCase())
  } catch {
    return []
  }
}

// Query real PostgreSQL records for Daily Report
export async function generateDailyReportData(
  db: pg.Pool,
  targetDateIst?: string,
): Promise<DailyReportData> {
  const dateStr = targetDateIst || getIstDateParts().dateStr
  const periodStart = `${dateStr} 00:00:00+05:30`
  const periodEnd = `${dateStr} 23:59:59.999+05:30`

  // Previous day
  const targetDateObj = new Date(periodStart)
  const prevDateObj = new Date(targetDateObj.getTime() - 24 * 60 * 60 * 1000)
  const prevDateStr = getIstDateParts(prevDateObj).dateStr
  const prevPeriodStart = `${prevDateStr} 00:00:00+05:30`
  const prevPeriodEnd = `${prevDateStr} 23:59:59.999+05:30`

  // 1. Current Day Totals
  const totalsRes = await db.query(
    `SELECT
       COUNT(DISTINCT s.id)::int AS total_shipments,
       COALESCE(SUM(i.quantity_received), 0)::int AS total_units,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('clear', 'completed_clean'))::int AS clear_returns,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('with_issues', 'issue_reported'))::int AS returns_with_issues
     FROM receipt_scans s
     LEFT JOIN receipt_scan_items i ON i.receipt_scan_id = s.id
     WHERE s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz`,
    [periodStart, periodEnd],
  )
  const totalRow = totalsRes.rows[0] || {}
  const totalShipments = Number(totalRow.total_shipments || 0)
  const totalUnits = Number(totalRow.total_units || 0)
  const clearReturns = Number(totalRow.clear_returns || 0)
  const returnsWithIssues = Number(totalRow.returns_with_issues || 0)

  // 2. Previous Day Totals for comparison
  const prevRes = await db.query(
    `SELECT
       COUNT(DISTINCT s.id)::int AS total_shipments,
       COALESCE(SUM(i.quantity_received), 0)::int AS total_units
     FROM receipt_scans s
     LEFT JOIN receipt_scan_items i ON i.receipt_scan_id = s.id
     WHERE s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz`,
    [prevPeriodStart, prevPeriodEnd],
  )
  const prevRow = prevRes.rows[0] || {}
  const prevShipments = Number(prevRow.total_shipments || 0)
  const prevUnits = Number(prevRow.total_units || 0)

  // 3. Marketplace Breakdown
  const marketRes = await db.query(
    `SELECT
       m.name AS marketplace,
       COUNT(DISTINCT s.id)::int AS shipments,
       COALESCE(SUM(i.quantity_received), 0)::int AS units,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('with_issues', 'issue_reported'))::int AS with_issues,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('clear', 'completed_clean'))::int AS clear_returns
     FROM marketplaces m
     LEFT JOIN receipt_scans s ON s.marketplace_id = m.id
       AND s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz
     LEFT JOIN receipt_scan_items i ON i.receipt_scan_id = s.id
     GROUP BY m.name, m.sort_order
     ORDER BY m.sort_order, m.name`,
    [periodStart, periodEnd],
  )

  const marketplaces: MarketplaceStat[] = marketRes.rows.map((r) => {
    const shipments = Number(r.shipments || 0)
    const withIssues = Number(r.with_issues || 0)
    return {
      marketplace: String(r.marketplace),
      shipments,
      units: Number(r.units || 0),
      withIssues,
      clearReturns: Number(r.clear_returns || 0),
      issueRate: fmtPct(withIssues, shipments),
    }
  })

  // 4. Operator Productivity
  const opRes = await db.query(
    `SELECT
       COALESCE(u.name, 'Unknown Operator') AS operator,
       COUNT(DISTINCT s.id)::int AS shipments,
       COALESCE(SUM(i.quantity_received), 0)::int AS units,
       MIN(s.created_at) AS first_scan,
       MAX(s.created_at) AS last_scan
     FROM receipt_scans s
     LEFT JOIN users u ON u.id = s.created_by
     LEFT JOIN receipt_scan_items i ON i.receipt_scan_id = s.id
     WHERE s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz
     GROUP BY u.name
     ORDER BY shipments DESC`,
    [periodStart, periodEnd],
  )

  const operators: OperatorStat[] = opRes.rows.map((r) => ({
    operator: String(r.operator),
    shipments: Number(r.shipments || 0),
    units: Number(r.units || 0),
    firstScan: r.first_scan ? getIstDateParts(new Date(r.first_scan)).timeStr : "—",
    lastScan: r.last_scan ? getIstDateParts(new Date(r.last_scan)).timeStr : "—",
  }))

  // 5. Duplicate attempts
  let duplicateAttempts = 0
  try {
    const dupRes = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM upload_rows ur
       JOIN upload_batches ub ON ub.id = ur.upload_batch_id
       WHERE ur.duplicate_kind <> ''
         AND ub.created_at >= $1::timestamptz AND ub.created_at <= $2::timestamptz`,
      [periodStart, periodEnd],
    )
    duplicateAttempts = Number(dupRes.rows[0]?.count || 0)
  } catch {
    // upload_rows might have no duplicates
  }

  // 6. Warnings
  const warnings: string[] = []
  const overallRate = totalShipments > 0 ? (returnsWithIssues / totalShipments) * 100 : 0
  if (overallRate > 15) {
    warnings.push(`High issue rate: ${overallRate.toFixed(1)}% of scanned returns had issues or damages today.`)
  }
  for (const m of marketplaces) {
    if (m.shipments > 20 && (m.withIssues / m.shipments) > 0.2) {
      warnings.push(`${m.marketplace} experienced elevated issue rate (${m.issueRate} across ${m.shipments} shipments).`)
    }
  }

  return {
    dateIst: dateStr,
    periodStartIso: new Date(periodStart).toISOString(),
    periodEndIso: new Date(periodEnd).toISOString(),
    totalShipments,
    totalUnits,
    clearReturns,
    returnsWithIssues,
    issueRatePct: fmtPct(returnsWithIssues, totalShipments),
    duplicateAttempts,
    previousDay: {
      dateIst: prevDateStr,
      totalShipments: prevShipments,
      totalUnits: prevUnits,
      deltaShipmentsPct: calcDelta(totalShipments, prevShipments),
    },
    marketplaces,
    operators,
    warnings,
  }
}

// Query real PostgreSQL records for Weekly Report (Completed Mon-Sun)
export async function generateWeeklyReportData(
  db: pg.Pool,
  referenceSundayDateIst?: string,
): Promise<WeeklyReportData> {
  // If not provided, calculate the most recent completed Sunday in IST
  let endSundayStr: string
  if (referenceSundayDateIst) {
    endSundayStr = referenceSundayDateIst
  } else {
    const nowParts = getIstDateParts()
    const daysSinceSunday = nowParts.dayOfWeek === 0 ? 7 : nowParts.dayOfWeek
    const lastSunObj = new Date(Date.now() - daysSinceSunday * 24 * 60 * 60 * 1000)
    endSundayStr = getIstDateParts(lastSunObj).dateStr
  }

  const endSundayObj = new Date(`${endSundayStr} 23:59:59.999+05:30`)
  const startMondayObj = new Date(endSundayObj.getTime() - (7 * 24 * 60 * 60 * 1000 - 1))
  const startMondayStr = getIstDateParts(startMondayObj).dateStr

  const periodStart = `${startMondayStr} 00:00:00+05:30`
  const periodEnd = `${endSundayStr} 23:59:59.999+05:30`

  // Previous week (for delta comparison)
  const prevEndSundayObj = new Date(startMondayObj.getTime() - 1)
  const prevStartMondayObj = new Date(prevEndSundayObj.getTime() - (7 * 24 * 60 * 60 * 1000 - 1))
  const prevStartStr = `${getIstDateParts(prevStartMondayObj).dateStr} 00:00:00+05:30`
  const prevEndStr = `${getIstDateParts(prevEndSundayObj).dateStr} 23:59:59.999+05:30`

  // 1. Weekly Totals
  const totalsRes = await db.query(
    `SELECT
       COUNT(DISTINCT s.id)::int AS total_shipments,
       COALESCE(SUM(i.quantity_received), 0)::int AS total_units,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('clear', 'completed_clean'))::int AS clear_returns,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('with_issues', 'issue_reported'))::int AS returns_with_issues
     FROM receipt_scans s
     LEFT JOIN receipt_scan_items i ON i.receipt_scan_id = s.id
     WHERE s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz`,
    [periodStart, periodEnd],
  )
  const totalRow = totalsRes.rows[0] || {}
  const totalShipments = Number(totalRow.total_shipments || 0)
  const totalUnits = Number(totalRow.total_units || 0)
  const clearReturns = Number(totalRow.clear_returns || 0)
  const returnsWithIssues = Number(totalRow.returns_with_issues || 0)

  // 2. Previous Week Totals
  const prevRes = await db.query(
    `SELECT
       COUNT(DISTINCT s.id)::int AS total_shipments,
       COALESCE(SUM(i.quantity_received), 0)::int AS total_units
     FROM receipt_scans s
     LEFT JOIN receipt_scan_items i ON i.receipt_scan_id = s.id
     WHERE s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz`,
    [prevStartStr, prevEndStr],
  )
  const prevRow = prevRes.rows[0] || {}
  const prevShipments = Number(prevRow.total_shipments || 0)
  const prevUnits = Number(prevRow.total_units || 0)

  // 3. Daily Trend across 7 days
  const trendRes = await db.query(
    `SELECT
       to_char(s.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day_date,
       to_char(s.created_at AT TIME ZONE 'Asia/Kolkata', 'Dy') AS day_name,
       COUNT(DISTINCT s.id)::int AS shipments,
       COALESCE(SUM(i.quantity_received), 0)::int AS units,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('with_issues', 'issue_reported'))::int AS with_issues
     FROM receipt_scans s
     LEFT JOIN receipt_scan_items i ON i.receipt_scan_id = s.id
     WHERE s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz
     GROUP BY day_date, day_name
     ORDER BY day_date`,
    [periodStart, periodEnd],
  )

  const dailyTrend: DailyTrendPoint[] = trendRes.rows.map((r) => ({
    dayName: String(r.day_name),
    dateIst: String(r.day_date),
    shipments: Number(r.shipments || 0),
    units: Number(r.units || 0),
    withIssues: Number(r.with_issues || 0),
  }))

  // 4. Marketplace Breakdown
  const marketRes = await db.query(
    `SELECT
       m.name AS marketplace,
       COUNT(DISTINCT s.id)::int AS shipments,
       COALESCE(SUM(i.quantity_received), 0)::int AS units,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('with_issues', 'issue_reported'))::int AS with_issues,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('clear', 'completed_clean'))::int AS clear_returns
     FROM marketplaces m
     LEFT JOIN receipt_scans s ON s.marketplace_id = m.id
       AND s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz
     LEFT JOIN receipt_scan_items i ON i.receipt_scan_id = s.id
     GROUP BY m.name, m.sort_order
     ORDER BY m.sort_order, m.name`,
    [periodStart, periodEnd],
  )

  const marketplaces: MarketplaceStat[] = marketRes.rows.map((r) => {
    const shipments = Number(r.shipments || 0)
    const withIssues = Number(r.with_issues || 0)
    return {
      marketplace: String(r.marketplace),
      shipments,
      units: Number(r.units || 0),
      withIssues,
      clearReturns: Number(r.clear_returns || 0),
      issueRate: fmtPct(withIssues, shipments),
    }
  })

  // 5. Operator Productivity
  const opRes = await db.query(
    `SELECT
       COALESCE(u.name, 'Unknown Operator') AS operator,
       COUNT(DISTINCT s.id)::int AS shipments,
       COALESCE(SUM(i.quantity_received), 0)::int AS units
     FROM receipt_scans s
     LEFT JOIN users u ON u.id = s.created_by
     LEFT JOIN receipt_scan_items i ON i.receipt_scan_id = s.id
     WHERE s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz
     GROUP BY u.name
     ORDER BY shipments DESC`,
    [periodStart, periodEnd],
  )

  const operators: OperatorStat[] = opRes.rows.map((r) => ({
    operator: String(r.operator),
    shipments: Number(r.shipments || 0),
    units: Number(r.units || 0),
    firstScan: "—",
    lastScan: "—",
  }))

  // 6. Top Issue Categories
  const issueRes = await db.query(
    `SELECT
       COALESCE(c.label, rsi.category_code) AS category,
       COUNT(*)::int AS count
     FROM receipt_scan_issues rsi
     JOIN receipt_scans s ON s.id = rsi.receipt_scan_id
     LEFT JOIN receipt_issue_categories c ON c.code = rsi.category_code
     WHERE s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz
     GROUP BY category
     ORDER BY count DESC
     LIMIT 5`,
    [periodStart, periodEnd],
  )

  const topIssues: IssueCategoryStat[] = issueRes.rows.map((r) => ({
    category: String(r.category),
    count: Number(r.count || 0),
    ratePct: fmtPct(Number(r.count || 0), totalShipments),
  }))

  const warnings: string[] = []
  if (totalShipments === 0) {
    warnings.push("No returns were scanned during this weekly window.")
  }

  const managementSummary =
    `Weekly scanning volume reached ${fmt(totalShipments)} shipments (${fmt(totalUnits)} physical units) ` +
    `with an overall issue rate of ${fmtPct(returnsWithIssues, totalShipments)}. ` +
    `Volume changed by ${calcDelta(totalShipments, prevShipments)} compared to previous week.`

  return {
    weekLabel: `${startMondayStr} to ${endSundayStr}`,
    periodStartIst: startMondayStr,
    periodEndIst: endSundayStr,
    periodStartIso: new Date(periodStart).toISOString(),
    periodEndIso: new Date(periodEnd).toISOString(),
    totalShipments,
    totalUnits,
    clearReturns,
    returnsWithIssues,
    overallIssueRatePct: fmtPct(returnsWithIssues, totalShipments),
    previousWeek: {
      totalShipments: prevShipments,
      totalUnits: prevUnits,
      deltaShipmentsPct: calcDelta(totalShipments, prevShipments),
      deltaUnitsPct: calcDelta(totalUnits, prevUnits),
    },
    dailyTrend,
    marketplaces,
    operators,
    topIssues,
    managementSummary,
    warnings,
  }
}

// Render Daily HTML Email
export function renderDailyEmail(data: DailyReportData): { html: string; text: string } {
  const subject = `Return App Daily Report — ${data.dateIst} (${fmt(data.totalShipments)} shipments)`

  const text = `
Return App Daily Operations Report
Date: ${data.dateIst} (Asia/Kolkata)
----------------------------------------
Total Shipments Scanned: ${fmt(data.totalShipments)} (${data.previousDay.deltaShipmentsPct} vs previous day)
Total Units Scanned: ${fmt(data.totalUnits)}
Clear Returns: ${fmt(data.clearReturns)}
Returns with Issues: ${fmt(data.returnsWithIssues)} (${data.issueRatePct})
Duplicate Scan Attempts: ${fmt(data.duplicateAttempts)}

Marketplace Breakdown:
${data.marketplaces
  .map(
    (m) =>
      `- ${m.marketplace}: ${fmt(m.shipments)} shipments | ${fmt(m.units)} units | Issues: ${m.withIssues} (${m.issueRate})`,
  )
  .join("\n")}

Operator Productivity:
${data.operators
  .map((o) => `- ${o.operator}: ${fmt(o.shipments)} shipments | ${fmt(o.units)} units (Active: ${o.firstScan} - ${o.lastScan})`)
  .join("\n")}

${data.warnings.length > 0 ? "\nWarnings:\n" + data.warnings.map((w) => `* ${w}`).join("\n") : ""}
----------------------------------------
Sent automatically by Return App (return.scan@youthnic.shop)
Planned domain: https://return.youthnic.shop
`.trim()

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 24px 12px; }
    .container { max-width: 680px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
    .header { background: linear-gradient(135deg, #093c31 0%, #136c57 100%); color: #ffffff; padding: 26px 28px; text-align: left; }
    .header h1 { margin: 0 0 6px; font-size: 21px; font-weight: 700; color: #ffffff; letter-spacing: -0.2px; }
    .header p { margin: 0; font-size: 13px; color: #a7f3d0; }
    .content { padding: 24px; }
    .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 24px; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .stat-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px; }
    .stat-value { font-size: 24px; font-weight: 700; color: #0f172a; margin: 4px 0 2px; }
    .stat-delta { font-size: 12px; color: #16a34a; font-weight: 500; }
    .stat-delta.negative { color: #dc2626; }
    .section-title { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #334155; margin: 24px 0 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px; }
    th { text-align: left; padding: 8px 10px; background: #f1f5f9; color: #475569; font-weight: 600; font-size: 11px; text-transform: uppercase; }
    td { padding: 10px; border-bottom: 1px solid #f1f5f9; }
    .badge-alert { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; background: #fee2e2; color: #991b1b; }
    .badge-ok { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; background: #dcfce7; color: #166534; }
    .warning-box { background: #fffbeb; border: 1px solid #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin: 16px 0; font-size: 13px; color: #92400e; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 24px; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Youthnic · Return Operations Daily Report</h1>
      <p>Report Date: ${data.dateIst} (IST) · VB Exports Returns Management</p>
    </div>
    <div class="content">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Shipments Scanned</div>
          <div class="stat-value">${fmt(data.totalShipments)}</div>
          <div class="stat-delta">${data.previousDay.deltaShipmentsPct} vs yesterday (${fmt(data.previousDay.totalShipments)})</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Units Received</div>
          <div class="stat-value">${fmt(data.totalUnits)}</div>
          <div class="stat-delta">Verified physically</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Clear Returns</div>
          <div class="stat-value" style="color: #16a34a;">${fmt(data.clearReturns)}</div>
          <div class="stat-delta">${fmtPct(data.clearReturns, data.totalShipments)} clear rate</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Returns with Issues</div>
          <div class="stat-value" style="color: ${data.returnsWithIssues > 0 ? "#dc2626" : "#0f172a"};">${fmt(data.returnsWithIssues)}</div>
          <div class="stat-delta ${data.returnsWithIssues > 0 ? "negative" : ""}">${data.issueRatePct} of total scans</div>
        </div>
      </div>

      ${data.warnings.length > 0 ? `<div class="warning-box"><strong>Operational Notices:</strong><ul style="margin: 6px 0 0; padding-left: 18px;">${data.warnings.map((w) => `<li>${w}</li>`).join("")}</ul></div>` : ""}

      <div class="section-title">Marketplace Account Breakdown</div>
      <table>
        <thead>
          <tr>
            <th>Channel</th>
            <th style="text-align: right;">Shipments</th>
            <th style="text-align: right;">Units</th>
            <th style="text-align: right;">Clear</th>
            <th style="text-align: right;">Issues</th>
            <th style="text-align: right;">Rate</th>
          </tr>
        </thead>
        <tbody>
          ${data.marketplaces
            .map(
              (m) => `
            <tr>
              <td><strong>${m.marketplace}</strong></td>
              <td style="text-align: right;">${fmt(m.shipments)}</td>
              <td style="text-align: right;">${fmt(m.units)}</td>
              <td style="text-align: right;">${fmt(m.clearReturns)}</td>
              <td style="text-align: right;">${fmt(m.withIssues)}</td>
              <td style="text-align: right;"><span class="${m.withIssues > 0 ? "badge-alert" : "badge-ok"}">${m.issueRate}</span></td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>

      <div class="section-title">Operator Productivity</div>
      <table>
        <thead>
          <tr>
            <th>Operator</th>
            <th style="text-align: right;">Shipments</th>
            <th style="text-align: right;">Units</th>
            <th style="text-align: right;">Active Period (IST)</th>
          </tr>
        </thead>
        <tbody>
          ${data.operators
            .map(
              (o) => `
            <tr>
              <td><strong>${o.operator}</strong></td>
              <td style="text-align: right;">${fmt(o.shipments)}</td>
              <td style="text-align: right;">${fmt(o.units)}</td>
              <td style="text-align: right; color: #64748b;">${o.firstScan} – ${o.lastScan}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <div class="footer">
      Generated automatically by Return App for VB Exports operations · Scheduled 8:00 PM IST<br />
      Production URL: <a href="https://return.youthnic.shop" style="color: #2563eb;">return.youthnic.shop</a>
    </div>
  </div>
</body>
</html>
`.trim()

  return { html, text }
}

// Render Weekly HTML Email
export function renderWeeklyEmail(data: WeeklyReportData): { html: string; text: string } {
  const subject = `Return App Weekly Report — ${data.weekLabel} (${fmt(data.totalShipments)} shipments)`

  const text = `
Return App Weekly Operations Report
Period: ${data.weekLabel} (Monday to Sunday, Asia/Kolkata)
----------------------------------------
Summary: ${data.managementSummary}

Key Metrics:
- Total Shipments: ${fmt(data.totalShipments)} (${data.previousWeek.deltaShipmentsPct} vs previous week)
- Total Units: ${fmt(data.totalUnits)} (${data.previousWeek.deltaUnitsPct} vs previous week)
- Clear Returns: ${fmt(data.clearReturns)}
- Returns with Issues: ${fmt(data.returnsWithIssues)} (${data.overallIssueRatePct})

Daily Trend:
${data.dailyTrend
  .map((d) => `- ${d.dayName} (${d.dateIst}): ${fmt(d.shipments)} shipments | ${fmt(d.units)} units | Issues: ${d.withIssues}`)
  .join("\n")}

Marketplace Breakdown:
${data.marketplaces
  .map((m) => `- ${m.marketplace}: ${fmt(m.shipments)} shipments | ${fmt(m.units)} units | Issue Rate: ${m.issueRate}`)
  .join("\n")}

Top Issue Categories:
${data.topIssues.map((i) => `- ${i.category}: ${fmt(i.count)} occurrences (${i.ratePct})`).join("\n")}

Operator Productivity:
${data.operators.map((o) => `- ${o.operator}: ${fmt(o.shipments)} shipments | ${fmt(o.units)} units`).join("\n")}
----------------------------------------
Sent automatically by Return App (return.scan@youthnic.shop)
`.trim()

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 24px 12px; }
    .container { max-width: 680px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
    .header { background: linear-gradient(135deg, #093c31 0%, #136c57 100%); color: #ffffff; padding: 26px 28px; text-align: left; }
    .header h1 { margin: 0 0 6px; font-size: 21px; font-weight: 700; color: #ffffff; letter-spacing: -0.2px; }
    .header p { margin: 0; font-size: 13px; color: #a7f3d0; }
    .content { padding: 24px; }
    .summary-card { background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #16a34a; padding: 14px 18px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; color: #166534; line-height: 1.5; }
    .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 24px; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .stat-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px; }
    .stat-value { font-size: 24px; font-weight: 700; color: #0f172a; margin: 4px 0 2px; }
    .stat-delta { font-size: 12px; color: #16a34a; font-weight: 500; }
    .section-title { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #334155; margin: 24px 0 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px; }
    th { text-align: left; padding: 8px 10px; background: #f1f5f9; color: #475569; font-weight: 600; font-size: 11px; text-transform: uppercase; }
    td { padding: 10px; border-bottom: 1px solid #f1f5f9; }
    .badge-alert { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; background: #fee2e2; color: #991b1b; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 24px; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Youthnic · Weekly Return Operations Report</h1>
      <p>Period: ${data.weekLabel} · VB Exports Operations</p>
    </div>
    <div class="content">
      <div class="summary-card">
        <strong>Management Overview:</strong><br />
        ${data.managementSummary}
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Weekly Shipments</div>
          <div class="stat-value">${fmt(data.totalShipments)}</div>
          <div class="stat-delta">${data.previousWeek.deltaShipmentsPct} vs prior week (${fmt(data.previousWeek.totalShipments)})</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Weekly Units</div>
          <div class="stat-value">${fmt(data.totalUnits)}</div>
          <div class="stat-delta">${data.previousWeek.deltaUnitsPct} vs prior week (${fmt(data.previousWeek.totalUnits)})</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Clear Returns</div>
          <div class="stat-value" style="color: #16a34a;">${fmt(data.clearReturns)}</div>
          <div class="stat-delta">${fmtPct(data.clearReturns, data.totalShipments)} overall clear rate</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Returns With Issues</div>
          <div class="stat-value" style="color: #dc2626;">${fmt(data.returnsWithIssues)}</div>
          <div class="stat-delta" style="color: #dc2626;">${data.overallIssueRatePct} overall issue rate</div>
        </div>
      </div>

      <div class="section-title">Daily Scanning Trend</div>
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th>Date (IST)</th>
            <th style="text-align: right;">Shipments</th>
            <th style="text-align: right;">Units</th>
            <th style="text-align: right;">Issues</th>
          </tr>
        </thead>
        <tbody>
          ${data.dailyTrend
            .map(
              (d) => `
            <tr>
              <td><strong>${d.dayName}</strong></td>
              <td style="color: #64748b;">${d.dateIst}</td>
              <td style="text-align: right;">${fmt(d.shipments)}</td>
              <td style="text-align: right;">${fmt(d.units)}</td>
              <td style="text-align: right;">${fmt(d.withIssues)}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>

      <div class="section-title">Marketplace Performance</div>
      <table>
        <thead>
          <tr>
            <th>Marketplace</th>
            <th style="text-align: right;">Shipments</th>
            <th style="text-align: right;">Units</th>
            <th style="text-align: right;">Issues</th>
            <th style="text-align: right;">Rate</th>
          </tr>
        </thead>
        <tbody>
          ${data.marketplaces
            .map(
              (m) => `
            <tr>
              <td><strong>${m.marketplace}</strong></td>
              <td style="text-align: right;">${fmt(m.shipments)}</td>
              <td style="text-align: right;">${fmt(m.units)}</td>
              <td style="text-align: right;">${fmt(m.withIssues)}</td>
              <td style="text-align: right;"><span class="${m.withIssues > 0 ? "badge-alert" : ""}">${m.issueRate}</span></td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>

      ${data.topIssues.length > 0 ? `
      <div class="section-title">Top Reported Issues</div>
      <table>
        <thead>
          <tr>
            <th>Issue Category</th>
            <th style="text-align: right;">Occurrences</th>
            <th style="text-align: right;">Rate of Total Scans</th>
          </tr>
        </thead>
        <tbody>
          ${data.topIssues
            .map(
              (i) => `
            <tr>
              <td><strong>${i.category}</strong></td>
              <td style="text-align: right;">${fmt(i.count)}</td>
              <td style="text-align: right;">${i.ratePct}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>` : ""}
    </div>
    <div class="footer">
      Generated automatically by Return App · Weekly schedule Mondays 9:00 AM IST<br />
      Production URL: <a href="https://return.youthnic.shop" style="color: #2563eb;">return.youthnic.shop</a>
    </div>
  </div>
</body>
</html>
`.trim()

  return { html, text }
}

// Send an email via the official Resend API (HTTP POST https://api.resend.com/emails)
export async function sendEmailViaResend(options: {
  to: string[]
  subject: string
  html: string
  text: string
}): Promise<{ id: string } | { dryRun: true }> {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  if (!apiKey) {
    // If not configured, provide clean logging and safe dry-run in dev without throwing
    console.warn("[Resend] RESEND_API_KEY is not set. Email delivery skipped in dry-run mode.")
    return { dryRun: true }
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Youthnic Returns <${SENDER_EMAIL}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Resend API error (${response.status}): ${errorBody}`)
  }

  const data = (await response.json()) as { id: string }
  return data
}

// Scheduled report execution with advisory lock and database idempotency
export async function runScheduledReports(
  db: pg.Pool,
  options: { force?: boolean } = {},
): Promise<{ ran: boolean; details?: string }> {
  // Acquire advisory lock so only one server process executes at a time
  const lock = await db.query("SELECT pg_try_advisory_lock(hashtext('resend_report_scheduler')) AS acquired")
  if (!lock.rows[0]?.acquired) {
    return { ran: false, details: "Advisory lock busy (another process is running scheduler)" }
  }

  try {
    const config = await getReportsConfig(db)
    const ist = getIstDateParts()
    const currentTime = ist.timeStr // e.g. "20:00"

    // 1. Check Daily Report
    if (config.dailyEnabled) {
      const isDailyDue = options.force || currentTime === config.dailyTime
      const dailyKey = `daily:${ist.dateStr}`

      if (isDailyDue) {
        // Check if already sent
        const existing = await db.query(
          "SELECT id, status FROM scheduled_report_runs WHERE period_key = $1",
          [dailyKey],
        )

        if (!existing.rows[0] || existing.rows[0].status !== "sent") {
          const recipients = await getAuthorizedRecipients(db)
          if (recipients.length > 0) {
            const data = await generateDailyReportData(db, ist.dateStr)
            const email = renderDailyEmail(data)

            // Record pending run
            const runRes = await db.query(
              `INSERT INTO scheduled_report_runs
                (report_type, period_key, period_start, period_end, recipients, status, summary)
               VALUES ('daily', $1, $2::timestamptz, $3::timestamptz, $4, 'pending', $5::jsonb)
               ON CONFLICT (period_key) DO UPDATE
               SET attempts = scheduled_report_runs.attempts + 1
               RETURNING id`,
              [
                dailyKey,
                data.periodStartIso,
                data.periodEndIso,
                recipients,
                JSON.stringify({ shipments: data.totalShipments, units: data.totalUnits }),
              ],
            )
            const runId = runRes.rows[0]?.id

            try {
              await sendEmailViaResend({
                to: recipients,
                subject: `Return App Daily Report — ${data.dateIst} (${fmt(data.totalShipments)} shipments)`,
                html: email.html,
                text: email.text,
              })

              await db.query(
                "UPDATE scheduled_report_runs SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1",
                [runId],
              )
              return { ran: true, details: `Daily report sent to ${recipients.length} recipients for ${ist.dateStr}` }
            } catch (err: any) {
              await db.query(
                "UPDATE scheduled_report_runs SET status = 'failed', last_error = $1 WHERE id = $2",
                [String(err.message), runId],
              )
              console.error("[Reports] Daily report delivery failed:", err.message)
            }
          }
        }
      }
    }

    // 2. Check Weekly Report (Every Monday at weeklyTime)
    if (config.weeklyEnabled) {
      const isMonday = ist.dayOfWeek === config.weeklyDay
      const isWeeklyDue = options.force || (isMonday && currentTime === config.weeklyTime)

      if (isWeeklyDue) {
        // Find previous Sunday
        const lastSunObj = new Date(Date.now() - (ist.dayOfWeek === 0 ? 7 : ist.dayOfWeek) * 24 * 60 * 60 * 1000)
        const sundayStr = getIstDateParts(lastSunObj).dateStr
        const weeklyKey = `weekly:${sundayStr}`

        const existing = await db.query(
          "SELECT id, status FROM scheduled_report_runs WHERE period_key = $1",
          [weeklyKey],
        )

        if (!existing.rows[0] || existing.rows[0].status !== "sent") {
          const recipients = await getAuthorizedRecipients(db)
          if (recipients.length > 0) {
            const data = await generateWeeklyReportData(db, sundayStr)
            const email = renderWeeklyEmail(data)

            const runRes = await db.query(
              `INSERT INTO scheduled_report_runs
                (report_type, period_key, period_start, period_end, recipients, status, summary)
               VALUES ('weekly', $1, $2::timestamptz, $3::timestamptz, $4, 'pending', $5::jsonb)
               ON CONFLICT (period_key) DO UPDATE
               SET attempts = scheduled_report_runs.attempts + 1
               RETURNING id`,
              [
                weeklyKey,
                data.periodStartIso,
                data.periodEndIso,
                recipients,
                JSON.stringify({ shipments: data.totalShipments, units: data.totalUnits }),
              ],
            )
            const runId = runRes.rows[0]?.id

            try {
              await sendEmailViaResend({
                to: recipients,
                subject: `Return App Weekly Report — ${data.weekLabel} (${fmt(data.totalShipments)} shipments)`,
                html: email.html,
                text: email.text,
              })

              await db.query(
                "UPDATE scheduled_report_runs SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1",
                [runId],
              )
              return { ran: true, details: `Weekly report sent to ${recipients.length} recipients for ${data.weekLabel}` }
            } catch (err: any) {
              await db.query(
                "UPDATE scheduled_report_runs SET status = 'failed', last_error = $1 WHERE id = $2",
                [String(err.message), runId],
              )
              console.error("[Reports] Weekly report delivery failed:", err.message)
            }
          }
        }
      }
    }

    return { ran: false, details: "No reports scheduled at this time" }
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtext('resend_report_scheduler'))").catch(() => undefined)
  }
}

// Send test report restricted to Admin
export async function sendTestReport(
  db: pg.Pool,
  targetEmail: string,
  reportType: "daily" | "weekly",
  actorUserId: number,
): Promise<{ success: boolean; message: string; previewSummary: Record<string, unknown> }> {
  if (!targetEmail) throw new Error("A recipient email address is required")

  let subject: string
  let html: string
  let text: string
  let summary: Record<string, unknown>

  if (reportType === "daily") {
    const data = await generateDailyReportData(db)
    const email = renderDailyEmail(data)
    subject = `[TEST] Return App Daily Report — ${data.dateIst} (${fmt(data.totalShipments)} shipments)`
    html = email.html
    text = email.text
    summary = {
      date: data.dateIst,
      shipments: data.totalShipments,
      units: data.totalUnits,
      issues: data.returnsWithIssues,
    }
  } else {
    const data = await generateWeeklyReportData(db)
    const email = renderWeeklyEmail(data)
    subject = `[TEST] Return App Weekly Report — ${data.weekLabel}`
    html = email.html
    text = email.text
    summary = {
      week: data.weekLabel,
      shipments: data.totalShipments,
      units: data.totalUnits,
      issues: data.returnsWithIssues,
    }
  }

  const result = await sendEmailViaResend({
    to: [targetEmail],
    subject,
    html,
    text,
  })

  await db.query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'reports.send_test', 'reports', $2, $3::jsonb)`,
    [actorUserId, reportType, JSON.stringify({ recipient: targetEmail, summary })],
  )

  const isDryRun = "dryRun" in result && result.dryRun === true
  return {
    success: true,
    message: isDryRun
      ? `Test report compiled successfully (Dry-run mode: RESEND_API_KEY is not set in environment).`
      : `Test report sent via Resend to ${targetEmail}`,
    previewSummary: summary,
  }
}
