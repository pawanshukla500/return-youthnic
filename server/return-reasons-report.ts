// Weekly Return Reason & Garment Sizing Intelligence Report Generator.
// Distinguishes Seller Mistakes (Defective, Wrong Item, Missing Components, Fabric Quality)
// from Customer Remorse and Logistics, isolates apparel size-level defects, and compiles
// an executive HTML email digest for weekly distribution to management & production teams.

import type pg from "pg"
import { ALL_ACCOUNTS } from "./access.js"
import {
  getWeeklyReasonSummary,
  getTopSellerFaultSKUs,
  getGarmentSizeDigest,
  type WeeklyReasonSummary,
  type SellerFaultSkuEntry,
  type GarmentSizeDigestEntry,
} from "./return-reasons.js"
import { getAuthorizedRecipients, sendEmailViaResend } from "./email-reports.js"

export type WeeklyReasonsReportData = {
  weekLabel: string
  periodStartIst: string
  periodEndIst: string
  periodStartIso: string
  periodEndIso: string
  summary: WeeklyReasonSummary
  sellerFaultSkus: SellerFaultSkuEntry[]
  sizeDigest: GarmentSizeDigestEntry[]
}

function formatDateDisplay(d: Date): string {
  return d.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/**
 * Compiles the Weekly Return Reasons & Sizing Report data across all authorized accounts.
 */
export async function generateWeeklyReasonsReportData(
  db: pg.Pool,
  targetDateIst?: string,
): Promise<WeeklyReasonsReportData> {
  const now = targetDateIst ? new Date(`${targetDateIst}T12:00:00+05:30`) : new Date()

  // Calculate standard weekly window: past 7 days (or previous full Monday-Sunday)
  const endDate = new Date(now)
  const startDate = new Date(now)
  startDate.setDate(endDate.getDate() - 7)

  const startStr = startDate.toISOString().split("T")[0]
  const endStr = endDate.toISOString().split("T")[0]
  const weekLabel = `${formatDateDisplay(startDate)} – ${formatDateDisplay(endDate)}`

  const [summary, sellerFaultSkus, sizeDigest] = await Promise.all([
    getWeeklyReasonSummary(db, ALL_ACCOUNTS, startStr, endStr),
    getTopSellerFaultSKUs(db, ALL_ACCOUNTS, startStr, endStr, 15),
    getGarmentSizeDigest(db, ALL_ACCOUNTS, startStr, endStr, 20),
  ])

  return {
    weekLabel,
    periodStartIst: startStr,
    periodEndIst: endStr,
    periodStartIso: startDate.toISOString(),
    periodEndIso: endDate.toISOString(),
    summary,
    sellerFaultSkus,
    sizeDigest,
  }
}

/**
 * Formats a number with comma separators.
 */
function fmt(num: number): string {
  return num.toLocaleString("en-IN")
}

/**
 * Renders the Weekly Return Reason & Sizing Digest HTML and plain text email.
 */
export function renderWeeklyReasonsEmail(data: WeeklyReasonsReportData): { html: string; text: string } {
  const { summary, sellerFaultSkus, sizeDigest, weekLabel } = data

  const sellerFaultCount = summary.sellerFaultCount
  const sellerFaultPct = summary.sellerFaultPct
  const sizeIssueCount = summary.sizeIssueCount
  const sizeIssuePct = summary.sizeIssuePct

  // Seller fault banner color
  const hasUrgentFaults = sellerFaultSkus.some((s) => s.severity === "critical" || s.severity === "high")
  const bannerBg = hasUrgentFaults ? "#fff1f0" : "#f6ffed"
  const bannerBorder = hasUrgentFaults ? "#ffa39e" : "#b7eb8f"
  const bannerText = hasUrgentFaults ? "#cf1322" : "#389e0d"

  // 1. Seller Fault Table Rows
  const sellerFaultRows = sellerFaultSkus
    .map((sku) => {
      const sevBadge =
        sku.severity === "critical"
          ? `<span style="background:#ff4d4f;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold;">CRITICAL</span>`
          : sku.severity === "high"
          ? `<span style="background:#fa8c16;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold;">HIGH</span>`
          : `<span style="background:#faad14;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold;">MEDIUM</span>`

      return `
      <tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:10px 12px;font-weight:600;color:#1e293b;">
          ${sku.productSku}<br/>
          <small style="color:#64748b;font-weight:normal;">${sku.productTitle}</small>
        </td>
        <td style="padding:10px 12px;color:#cf1322;font-weight:600;">
          ${sku.primaryDefect}
        </td>
        <td style="padding:10px 12px;text-align:center;font-weight:bold;">
          ${fmt(sku.sellerFaultCount)} <small style="color:#64748b;">(${sku.faultRatePct})</small>
        </td>
        <td style="padding:10px 12px;text-align:center;">
          ${sevBadge}
        </td>
        <td style="padding:10px 12px;font-size:12px;color:#334155;line-height:1.4;">
          ${sku.recommendation}
        </td>
      </tr>`
    })
    .join("")

  // 2. Garment Sizing Table Rows
  const sizeRows = sizeDigest
    .map((entry) => {
      // Format size badges
      const sizePills = Object.entries(entry.sizeCounts)
        .filter(([sz]) => sz !== "Unknown")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([sz, cnt]) => `<span style="display:inline-block;background:#f1f5f9;color:#334155;padding:1px 6px;border-radius:4px;font-size:11px;margin:2px 3px 2px 0;"><strong>${sz}:</strong> ${cnt}</span>`)
        .join("")

      let trendBadge = `<span style="background:#e0e7ff;color:#3730a3;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;">Fit Issue</span>`
      if (parseFloat(entry.tooSmallPct) >= 50) {
        trendBadge = `<span style="background:#fee2e2;color:#991b1b;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:bold;">Runs Small (${entry.tooSmallPct})</span>`
      } else if (parseFloat(entry.tooLargePct) >= 50) {
        trendBadge = `<span style="background:#fef3c7;color:#92400e;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:bold;">Runs Large (${entry.tooLargePct})</span>`
      }

      return `
      <tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:10px 12px;font-weight:600;color:#1e293b;">
          ${entry.productSku}<br/>
          <small style="color:#64748b;font-weight:normal;">${entry.productTitle}</small>
        </td>
        <td style="padding:10px 12px;text-align:center;font-weight:bold;color:#4338ca;">
          ${fmt(entry.totalSizeReturns)}
        </td>
        <td style="padding:10px 12px;">
          ${sizePills || "<span style='color:#94a3b8;'>—</span>"}
        </td>
        <td style="padding:10px 12px;text-align:center;">
          ${trendBadge}
        </td>
        <td style="padding:10px 12px;font-size:12px;color:#1e293b;line-height:1.4;">
          ${entry.actionableRecommendation}
        </td>
      </tr>`
    })
    .join("")

  // 3. Marketplace Comparison Rows
  const marketplaceRows = summary.marketplaces
    .map(
      (m) => `
      <tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:8px 12px;font-weight:600;color:#1e293b;">${m.marketplace}</td>
        <td style="padding:8px 12px;text-align:center;font-weight:bold;">${fmt(m.totalReturns)}</td>
        <td style="padding:8px 12px;text-align:center;color:#cf1322;font-weight:600;">${fmt(m.sellerFaultCount)} (${m.sellerFaultPct})</td>
        <td style="padding:8px 12px;text-align:center;color:#4338ca;font-weight:600;">${fmt(m.sizeIssueCount)} (${m.sizeIssuePct})</td>
        <td style="padding:8px 12px;text-align:center;color:#64748b;">${fmt(m.customerRemorseCount)}</td>
      </tr>`,
    )
    .join("")

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Return Reason & Sizing Defect Digest</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;background-color:#f8fafc;color:#1e293b;line-height:1.5;">
  <div style="max-width:850px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">

    <!-- Header Banner -->
    <div style="background:#136c57;padding:24px 30px;color:#ffffff;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td>
            <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;opacity:0.85;font-weight:600;">Youthnic · VB Exports Operations</div>
            <h1 style="margin:4px 0 0 0;font-size:22px;font-weight:700;color:#ffffff;">Weekly Return Reason & Sizing Digest</h1>
            <div style="font-size:13px;opacity:0.9;margin-top:4px;">Period: ${weekLabel}</div>
          </td>
          <td style="text-align:right;vertical-align:bottom;">
            <div style="font-size:12px;background:rgba(255,255,255,0.15);padding:6px 12px;border-radius:6px;display:inline-block;">Multi-Marketplace Intelligence</div>
          </td>
        </tr>
      </table>
    </div>

    <div style="padding:24px 30px;">

      <!-- Executive KPI Cards -->
      <table style="width:100%;border-collapse:separate;border-spacing:12px 0;margin:0 -12px 24px -12px;">
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center;width:25%;">
            <div style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;">Total Returns</div>
            <div style="font-size:24px;font-weight:700;color:#0f172a;margin-top:4px;">${fmt(summary.totalReturns)}</div>
            <div style="font-size:11px;color:#94a3b8;margin-top:2px;">All 5 Marketplaces</div>
          </td>

          <td style="background:#fff1f0;border:1px solid #ffa39e;border-radius:8px;padding:16px;text-align:center;width:25%;">
            <div style="font-size:11px;text-transform:uppercase;color:#cf1322;font-weight:700;">Seller Mistakes</div>
            <div style="font-size:24px;font-weight:700;color:#cf1322;margin-top:4px;">${fmt(sellerFaultCount)}</div>
            <div style="font-size:11px;color:#cf1322;margin-top:2px;font-weight:600;">${sellerFaultPct} of returns</div>
          </td>

          <td style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:16px;text-align:center;width:25%;">
            <div style="font-size:11px;text-transform:uppercase;color:#4338ca;font-weight:700;">Fit & Size Issues</div>
            <div style="font-size:24px;font-weight:700;color:#4338ca;margin-top:4px;">${fmt(sizeIssueCount)}</div>
            <div style="font-size:11px;color:#4338ca;margin-top:2px;font-weight:600;">${sizeIssuePct} of returns</div>
          </td>

          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center;width:25%;">
            <div style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;">Buyer Remorse</div>
            <div style="font-size:24px;font-weight:700;color:#475569;margin-top:4px;">${fmt(summary.customerRemorseCount)}</div>
            <div style="font-size:11px;color:#94a3b8;margin-top:2px;">${summary.customerRemorsePct} (No seller fault)</div>
          </td>
        </tr>
      </table>

      <!-- Seller Fault Executive Banner -->
      <div style="background:${bannerBg};border:1px solid ${bannerBorder};border-radius:8px;padding:14px 18px;margin-bottom:28px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="vertical-align:top;width:24px;font-size:18px;">⚠️</td>
            <td style="padding-left:10px;">
              <strong style="color:${bannerText};font-size:14px;">Attention: Mistakes Happened From Our Side (${sellerFaultCount} units, ${sellerFaultPct})</strong>
              <div style="color:#475569;font-size:12px;margin-top:3px;line-height:1.4;">
                These returns occurred due to factory manufacturing flaws, warehouse mis-shipments, defective fabric, or incomplete accessory packs. Corrective QC protocols must be enforced immediately.
              </div>
            </td>
          </tr>
        </table>
      </div>

      <!-- Section 1: Top Seller Fault SKUs -->
      <div style="margin-bottom:32px;">
        <h2 style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 12px 0;border-left:4px solid #cf1322;padding-left:10px;">
          1. Priority Focus: Top SKUs With Seller / Factory Mistakes
        </h2>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;">
            <thead>
              <tr style="background:#f1f5f9;border-bottom:1px solid #e2e8f0;color:#475569;font-weight:600;text-align:left;">
                <th style="padding:10px 12px;">Product SKU</th>
                <th style="padding:10px 12px;">Primary Defect</th>
                <th style="padding:10px 12px;text-align:center;">Fault Units</th>
                <th style="padding:10px 12px;text-align:center;">Severity</th>
                <th style="padding:10px 12px;">Recommended Corrective Action</th>
              </tr>
            </thead>
            <tbody>
              ${sellerFaultRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#64748b;">No seller fault returns detected during this period. Excellent performance!</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Section 2: Garment Sizing & Fit Intelligence Digest -->
      <div style="margin-bottom:32px;">
        <h2 style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 12px 0;border-left:4px solid #4338ca;padding-left:10px;">
          2. Sizing & Fit Intelligence Digest: Which Size Has Issues?
        </h2>
        <p style="font-size:12px;color:#64748b;margin:0 0 12px 0;">
          Directional analysis comparing <strong>Runs Small</strong> (under-sized / tight) vs <strong>Runs Large</strong> (over-sized / loose) to enable data-driven garment grading and size-chart calibration.
        </p>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;">
            <thead>
              <tr style="background:#f1f5f9;border-bottom:1px solid #e2e8f0;color:#475569;font-weight:600;text-align:left;">
                <th style="padding:10px 12px;">Product SKU</th>
                <th style="padding:10px 12px;text-align:center;">Size Returns</th>
                <th style="padding:10px 12px;">Size Breakdown</th>
                <th style="padding:10px 12px;text-align:center;">Sizing Trend</th>
                <th style="padding:10px 12px;">Pattern & Grading Guidance</th>
              </tr>
            </thead>
            <tbody>
              ${sizeRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#64748b;">No size-related returns recorded in this period.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Section 3: Marketplace Return Reason Comparison -->
      <div style="margin-bottom:24px;">
        <h2 style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 12px 0;border-left:4px solid #136c57;padding-left:10px;">
          3. Multi-Marketplace Return Distribution
        </h2>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;">
            <thead>
              <tr style="background:#f1f5f9;border-bottom:1px solid #e2e8f0;color:#475569;font-weight:600;text-align:left;">
                <th style="padding:8px 12px;">Marketplace</th>
                <th style="padding:8px 12px;text-align:center;">Total Returns</th>
                <th style="padding:8px 12px;text-align:center;">Seller Mistakes</th>
                <th style="padding:8px 12px;text-align:center;">Sizing Issues</th>
                <th style="padding:8px 12px;text-align:center;">Buyer Remorse</th>
              </tr>
            </thead>
            <tbody>
              ${marketplaceRows}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Footer -->
      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center;">
        Generated by Return Operations Intelligence · Youthnic VB Exports · Hostinger VPS & PostgreSQL<br/>
        Report is synchronized weekly. To configure recipients or trigger on-demand digests, visit the Web Admin Portal.
      </div>

    </div>
  </div>
</body>
</html>`

  const text = `
===================================================================
YOUTHNIC · VB EXPORTS - WEEKLY RETURN REASON & SIZING DIGEST
Period: ${weekLabel}
===================================================================

EXECUTIVE SUMMARY
- Total Returns: ${fmt(summary.totalReturns)}
- Seller Mistakes: ${fmt(sellerFaultCount)} (${sellerFaultPct}) [ATTENTION REQUIRED]
- Garment Sizing Issues: ${fmt(sizeIssueCount)} (${sizeIssuePct})
- Buyer Remorse / Preference: ${fmt(summary.customerRemorseCount)} (${summary.customerRemorsePct})
- Logistics & Courier RTO: ${fmt(summary.logisticsRtoCount)} (${summary.logisticsRtoPct})

TOP SKUS WITH SELLER / FACTORY MISTAKES:
${sellerFaultSkus
  .map(
    (s, idx) =>
      `${idx + 1}. [${s.productSku}] ${s.productTitle}\n   - Defect: ${s.primaryDefect} (${s.sellerFaultCount} units, ${s.faultRatePct})\n   - Action: ${s.recommendation}`,
  )
  .join("\n\n")}

GARMENT SIZING & FIT INTELLIGENCE DIGEST:
${sizeDigest
  .map(
    (e, idx) =>
      `${idx + 1}. [${e.productSku}] ${e.productTitle}\n   - Total Fit Returns: ${e.totalSizeReturns}\n   - Trend: Too Small ${e.tooSmallPct} | Too Large ${e.tooLargePct}\n   - Guidance: ${e.actionableRecommendation}`,
  )
  .join("\n\n")}

MARKETPLACE BREAKDOWN:
${summary.marketplaces
  .map(
    (m) =>
      `- ${m.marketplace}: Total ${fmt(m.totalReturns)} | Seller Mistakes ${fmt(m.sellerFaultCount)} (${m.sellerFaultPct}) | Sizing ${fmt(m.sizeIssueCount)} (${m.sizeIssuePct})`,
  )
  .join("\n")}
===================================================================
`

  return { html, text }
}

/**
 * Triggers the weekly return reason & sizing digest email.
 * Uses Resend API with idempotency and audit trail.
 */
export async function sendWeeklyReasonsReport(
  db: pg.Pool,
  targetEmails?: string[],
  actorUserId?: number,
): Promise<{ success: boolean; message: string; summary: Record<string, unknown> }> {
  const recipients = targetEmails && targetEmails.length > 0 ? targetEmails : await getAuthorizedRecipients(db)

  if (!recipients.length) {
    throw new Error("No recipients configured for return reason digest report")
  }

  const data = await generateWeeklyReasonsReportData(db)
  const email = renderWeeklyReasonsEmail(data)

  const subject = `Weekly Return Reason & Sizing Digest — ${data.weekLabel} (${fmt(data.summary.sellerFaultCount)} Seller Mistakes)`

  const result = await sendEmailViaResend({
    to: recipients,
    subject,
    html: email.html,
    text: email.text,
  })

  // Record audit log entry
  if (actorUserId) {
    await db.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'reports.send_reasons_digest', 'return_reasons_report', 'weekly', $2::jsonb)`,
      [
        actorUserId,
        JSON.stringify({
          recipients,
          weekLabel: data.weekLabel,
          sellerFaultCount: data.summary.sellerFaultCount,
          sizeIssueCount: data.summary.sizeIssueCount,
        }),
      ],
    )
  }

  const isDryRun = "dryRun" in result && (result as any).dryRun === true

  return {
    success: true,
    message: isDryRun
      ? `Report generated successfully (Dry-run mode: RESEND_API_KEY is not configured).`
      : `Weekly Return Reason & Sizing Digest sent to ${recipients.length} recipients.`,
    summary: {
      week: data.weekLabel,
      totalReturns: data.summary.totalReturns,
      sellerFaults: data.summary.sellerFaultCount,
      sizeIssues: data.summary.sizeIssueCount,
      recipients,
    },
  }
}
