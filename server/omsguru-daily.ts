// OMSGuru Daily Inventory Update Engine & Firebase Storage Integration for Return App.
//
// Automatically aggregates all physical returns received in good condition across all marketplaces for each day,
// groups by master product SKU code, formats the standard OMSGuru CSV, uploads to Firebase Storage
// under inventory-update-file/ (with 180-day retention pruning), and sends scheduled/on-demand Resend emails
// with CSV attachment and CC audit recipients.

import crypto from "node:crypto"
import type pg from "pg"
import { getIstDateParts, sendEmailViaResend, getAuthorizedRecipients } from "./email-reports.js"
import {
  uploadToFirebaseStorage,
  deleteFromFirebaseStorage,
  listFirebaseStorageFiles,
  isFirebaseConfigured,
} from "./firebase-storage.js"
import { recordUnmappedListingSkus } from "./product-master.js"

export type UnmappedScannedItem = {
  itemId: number
  marketplace: string
  trackingId: string
  orderNumber: string
  listingSku: string
  goodQty: number
}

export type OmsguruConfig = {
  dailyEnabled: boolean
  dailyTime: string // "19:45"
  dropshipWarehouseId: string // "6688"
  retentionDays: number // 180
  storageFolder: string // "inventory-update-file"
  ccEmails: string[]
}

export const DEFAULT_OMSGURU_CONFIG: OmsguruConfig = {
  dailyEnabled: true,
  dailyTime: "19:45",
  dropshipWarehouseId: "6688",
  retentionDays: 180,
  storageFolder: "inventory-update-file",
  ccEmails: [],
}

export type SkuUpdateItem = {
  sku: string
  qty: number
  marketplaces: Record<string, number>
}

export type OmsguruDailyUpdateRecord = {
  id: number
  requestId: string
  updateDate: string // YYYY-MM-DD
  dropshipWarehouseId: string
  totalSkus: number
  totalQty: number
  csvContent: string
  fileName: string
  storagePath: string
  storageUrl: string
  emailSent: boolean
  emailSentAt: string | null
  emailRecipients: string[]
  emailCc: string[]
  skuBreakdown: SkuUpdateItem[]
  generatedBy: number | null
  createdAt: string
}

const fmt = (n: number) => n.toLocaleString("en-IN")

function escapeCsv(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ""
  const str = String(value)
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function generateRequestId(dateStr: string): string {
  const compactDate = dateStr.replace(/-/g, "")
  const randomSuffix = crypto.randomBytes(3).toString("hex").toUpperCase()
  const ist = getIstDateParts()
  const compactTime = ist.timeStr.replace(/:/g, "")
  return `REQ-${compactDate}-${compactTime}-${randomSuffix}`
}

export async function getOmsguruConfig(db: pg.Pool): Promise<OmsguruConfig> {
  try {
    const result = await db.query(
      "SELECT setting_value FROM app_system_settings WHERE setting_key = 'omsguru_config'",
    )
    if (result.rows[0]?.setting_value) {
      const stored = result.rows[0].setting_value as Partial<OmsguruConfig>
      return {
        dailyEnabled: stored.dailyEnabled ?? DEFAULT_OMSGURU_CONFIG.dailyEnabled,
        dailyTime: stored.dailyTime || DEFAULT_OMSGURU_CONFIG.dailyTime,
        dropshipWarehouseId: stored.dropshipWarehouseId || DEFAULT_OMSGURU_CONFIG.dropshipWarehouseId,
        retentionDays: Number(stored.retentionDays || DEFAULT_OMSGURU_CONFIG.retentionDays),
        storageFolder: stored.storageFolder || DEFAULT_OMSGURU_CONFIG.storageFolder,
        ccEmails: Array.isArray(stored.ccEmails) ? stored.ccEmails : [],
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_OMSGURU_CONFIG
}

export async function updateOmsguruConfig(
  db: pg.Pool,
  config: Partial<OmsguruConfig>,
  actorUserId: number,
): Promise<OmsguruConfig> {
  const current = await getOmsguruConfig(db)
  const updated: OmsguruConfig = {
    dailyEnabled: config.dailyEnabled ?? current.dailyEnabled,
    dailyTime: config.dailyTime ?? current.dailyTime,
    dropshipWarehouseId: config.dropshipWarehouseId ?? current.dropshipWarehouseId,
    retentionDays: Number(config.retentionDays ?? current.retentionDays),
    storageFolder: config.storageFolder ?? current.storageFolder,
    ccEmails: Array.isArray(config.ccEmails) ? config.ccEmails : current.ccEmails,
  }

  await db.query(
    `INSERT INTO app_system_settings (setting_key, setting_value, updated_at, updated_by)
     VALUES ('omsguru_config', $1::jsonb, now(), $2)
     ON CONFLICT (setting_key) DO UPDATE
     SET setting_value = EXCLUDED.setting_value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(updated), actorUserId],
  )

  await db.query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'system.update_omsguru_config', 'omsguru_config', 'default', $2::jsonb)`,
    [actorUserId, JSON.stringify(updated)],
  )

  return updated
}

// Queries PostgreSQL for all items scanned on targetDate and sums only good received quantities
export async function calculateGoodReturnsForDay(
  db: pg.Pool | pg.PoolClient,
  dateStr: string,
): Promise<{
  skus: SkuUpdateItem[]
  totalSkus: number
  totalQty: number
  unmappedItems: UnmappedScannedItem[]
}> {
  const periodStart = `${dateStr} 00:00:00+05:30`
  const periodEnd = `${dateStr} 23:59:59.999+05:30`

  const sql = `
    SELECT
      rsi.id AS item_id,
      rs.scanned_at,
      COALESCE(rs.scanned_awb, er.tracking_id, '') AS tracking_id,
      COALESCE(er.order_number, '') AS order_number,
      COALESCE(m.name, rs.marketplace_snapshot, 'Unknown') AS marketplace,
      COALESCE(rsi.marketplace_sku, '') AS marketplace_sku,
      COALESCE(rsi.product_sku, '') AS product_sku,
      rsi.received_qty,
      COALESCE(issues.issue_qty, 0)::int AS issue_qty,
      COALESCE(s.code, '') AS sku_code
    FROM receipt_scans rs
    JOIN receipt_scan_items rsi ON rsi.receipt_scan_id = rs.id
    LEFT JOIN expected_returns er ON er.id = rs.expected_return_id
    LEFT JOIN marketplaces m ON m.id = er.marketplace_id
    LEFT JOIN expected_return_items eri ON eri.id = rsi.expected_return_item_id
    LEFT JOIN skus s ON s.id = eri.sku_id
    LEFT JOIN (
      SELECT receipt_scan_item_id, SUM(qty)::int AS issue_qty
      FROM receipt_scan_issues
      GROUP BY receipt_scan_item_id
    ) issues ON issues.receipt_scan_item_id = rsi.id
    WHERE rs.scanned_at >= $1::timestamptz AND rs.scanned_at <= $2::timestamptz
    ORDER BY rs.scanned_at ASC, rsi.id ASC
  `

  const res = await db.query(sql, [periodStart, periodEnd])
  const rows = res.rows

  // Collect missing master product SKUs that need product_master resolution
  const needsMaster: { listing: string; marketplace: string }[] = []
  for (const row of rows) {
    const rawSku = String(row.product_sku || "").trim()
    if (!rawSku || rawSku.toUpperCase() === "UNRESOLVED") {
      const listing = String(row.marketplace_sku || "").trim()
      if (listing) {
        needsMaster.push({ listing, marketplace: String(row.marketplace) })
      }
    }
  }

  const masterMap = new Map<string, string>()
  if (needsMaster.length) {
    const listingSet = [...new Set(needsMaster.map((n) => n.listing.toLowerCase().replace(/\s+/g, "")))]
    const pmRes = await db.query(
      `SELECT listing_sku, master_sku FROM product_master WHERE replace(lower(listing_sku), ' ', '') = ANY($1::text[])`,
      [listingSet],
    )
    for (const r of pmRes.rows) {
      masterMap.set(String(r.listing_sku).toLowerCase().replace(/\s+/g, ""), String(r.master_sku))
    }
  }

  // Aggregate by resolved Master Product SKU
  const aggregation = new Map<string, { qty: number; marketplaces: Record<string, number> }>()
  const unmappedItems: UnmappedScannedItem[] = []
  const unmappedByMarketplace = new Map<string, Set<string>>()

  for (const row of rows) {
    const received = Number(row.received_qty || 0)
    const issues = Number(row.issue_qty || 0)
    const goodQty = Math.max(0, received - issues)
    if (goodQty <= 0) continue // Skip items with issues or 0 good quantity

    let masterSku = String(row.product_sku || "").trim()
    if (!masterSku || masterSku.toUpperCase() === "UNRESOLVED") {
      const listing = String(row.marketplace_sku || "").trim()
      const normalizedKey = listing.toLowerCase().replace(/\s+/g, "")
      const fromMaster = masterMap.get(normalizedKey)
      const fromSkuCode = String(row.sku_code || "").trim()
      const resolved = fromMaster || (fromSkuCode && fromSkuCode !== listing ? fromSkuCode : "")

      if (resolved) {
        masterSku = resolved
      } else {
        masterSku = listing
        unmappedItems.push({
          itemId: Number(row.item_id),
          marketplace: String(row.marketplace || "Other"),
          trackingId: String(row.tracking_id || ""),
          orderNumber: String(row.order_number || ""),
          listingSku: listing,
          goodQty,
        })
        const mpSet = unmappedByMarketplace.get(String(row.marketplace || "Other")) ?? new Set()
        mpSet.add(listing)
        unmappedByMarketplace.set(String(row.marketplace || "Other"), mpSet)
      }
    }
    if (!masterSku) continue

    const existing = aggregation.get(masterSku) ?? { qty: 0, marketplaces: {} }
    existing.qty += goodQty
    const mp = String(row.marketplace || "Other")
    existing.marketplaces[mp] = (existing.marketplaces[mp] || 0) + goodQty
    aggregation.set(masterSku, existing)
  }

  // Auto-record any unmapped listing SKUs found in scans
  if (unmappedByMarketplace.size > 0) {
    for (const [mp, skusSet] of unmappedByMarketplace) {
      await recordUnmappedListingSkus(db, mp, [...skusSet])
    }
  }

  const skus: SkuUpdateItem[] = []
  let totalQty = 0

  const sortedKeys = [...aggregation.keys()].sort((a, b) => a.localeCompare(b))
  for (const sku of sortedKeys) {
    const data = aggregation.get(sku)!
    skus.push({
      sku,
      qty: data.qty,
      marketplaces: data.marketplaces,
    })
    totalQty += data.qty
  }

  return {
    skus,
    totalSkus: skus.length,
    totalQty,
    unmappedItems,
  }
}

// Builds standard CSV matching OMSGuru Bulk Inventory Adjustment template
export function buildOmsguruCsv(options: {
  warehouseId: string
  requestId: string
  skus: SkuUpdateItem[]
}): string {
  const headers = [
    "DropshipWarehouseId",
    "Item SkuCode",
    "InventoryAction",
    "QtyIncludesBlocked",
    "Qty",
    "RackSpace",
    "Last Purchase Price",
    "Notes",
  ]

  const lines: string[] = [headers.join(",")]

  for (const item of options.skus) {
    const row = [
      escapeCsv(options.warehouseId),
      escapeCsv(item.sku),
      "ADD",
      "", // QtyIncludesBlocked blank
      escapeCsv(item.qty),
      "", // RackSpace blank (defaults to DEFAULT rack)
      "", // Last Purchase Price blank
      escapeCsv(options.requestId),
    ]
    lines.push(row.join(","))
  }

  return lines.join("\r\n") + "\r\n"
}

// Prunes files and records older than retentionDays (default 180 days)
export async function pruneOldOmsguruFiles(db: pg.Pool, retentionDays = 180): Promise<number> {
  try {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const cutoffDateStr = getIstDateParts(cutoffDate).dateStr

    const oldRows = await db.query(
      "SELECT id, storage_path FROM omsguru_daily_inventory_updates WHERE update_date < $1",
      [cutoffDateStr],
    )

    let prunedCount = 0
    for (const row of oldRows.rows) {
      if (row.storage_path) {
        await deleteFromFirebaseStorage(row.storage_path)
      }
      prunedCount++
    }

    if (prunedCount > 0) {
      await db.query("DELETE FROM omsguru_daily_inventory_updates WHERE update_date < $1", [cutoffDateStr])
      console.log(`[OMSGuru Storage] Pruned ${prunedCount} daily inventory updates older than ${retentionDays} days.`)
    }

    return prunedCount
  } catch (err) {
    console.error("[OMSGuru Storage] Pruning error:", err)
    return 0
  }
}

// Main generator: Calculates today's good return sum, formats CSV, uploads to Firebase, and saves record
export async function generateOmsguruDailyUpdate(
  db: pg.Pool,
  options: {
    targetDate?: string // YYYY-MM-DD
    warehouseId?: string
    actorUserId?: number | null
  } = {},
): Promise<OmsguruDailyUpdateRecord> {
  const config = await getOmsguruConfig(db)
  const ist = getIstDateParts()
  const dateStr = options.targetDate || ist.dateStr
  const warehouseId = options.warehouseId || config.dropshipWarehouseId
  const requestId = generateRequestId(dateStr)

  // 1. Calculate good received returns
  const calculated = await calculateGoodReturnsForDay(db, dateStr)

  // 2. Build standard CSV
  const csvContent = buildOmsguruCsv({
    warehouseId,
    requestId,
    skus: calculated.skus,
  })

  const fileName = "UpdateInStockQtyAnd_orLastPurchasePrice.csv"
  const storageObjectPath = `${config.storageFolder}/UpdateInStockQtyAnd_orLastPurchasePrice_${dateStr}_${requestId}.csv`

  // 3. Upload to Firebase Storage
  let storageUrl = ""
  try {
    const uploadRes = await uploadToFirebaseStorage(storageObjectPath, csvContent, "text/csv; charset=utf-8")
    storageUrl = uploadRes.directUrl || uploadRes.url
  } catch (err) {
    console.warn("[OMSGuru Firebase] Storage upload skipped or failed:", err instanceof Error ? err.message : err)
  }

  // 4. Prune files older than 180 days
  await pruneOldOmsguruFiles(db, config.retentionDays)

  // 5. Insert record into PostgreSQL
  const insertRes = await db.query(
    `INSERT INTO omsguru_daily_inventory_updates
      (request_id, update_date, dropship_warehouse_id, total_skus, total_qty, csv_content,
       file_name, storage_path, storage_url, sku_breakdown, generated_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now())
     RETURNING *`,
    [
      requestId,
      dateStr,
      warehouseId,
      calculated.totalSkus,
      calculated.totalQty,
      csvContent,
      fileName,
      storageObjectPath,
      storageUrl,
      JSON.stringify(calculated.skus),
      options.actorUserId ?? null,
    ],
  )

  const row = insertRes.rows[0]
  return {
    id: Number(row.id),
    requestId: String(row.request_id),
    updateDate: String(row.update_date).slice(0, 10),
    dropshipWarehouseId: String(row.dropship_warehouse_id),
    totalSkus: Number(row.total_skus),
    totalQty: Number(row.total_qty),
    csvContent: String(row.csv_content),
    fileName: String(row.file_name),
    storagePath: String(row.storage_path),
    storageUrl: String(row.storage_url),
    emailSent: Boolean(row.email_sent),
    emailSentAt: row.email_sent_at ? new Date(row.email_sent_at).toISOString() : null,
    emailRecipients: Array.isArray(row.email_recipients) ? row.email_recipients : [],
    emailCc: Array.isArray(row.email_cc) ? row.email_cc : [],
    skuBreakdown: (row.sku_breakdown as SkuUpdateItem[]) || [],
    generatedBy: row.generated_by ? Number(row.generated_by) : null,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

// Renders rich HTML email template with Youthnic branding & stats summary
export function renderOmsguruUpdateEmail(
  record: OmsguruDailyUpdateRecord,
  config: OmsguruConfig,
): { subject: string; html: string; text: string } {
  const subject = `OMSGuru Daily Inventory Update — ${record.updateDate} (Req: ${record.requestId}) — ${fmt(record.totalQty)} Units (${fmt(record.totalSkus)} SKUs)`

  const text = `
Youthnic Returns — OMSGuru Daily Inventory Update
============================================================
Date: ${record.updateDate} (Asia/Kolkata)
Request ID: ${record.requestId}
Dropship Warehouse ID: ${record.dropshipWarehouseId}
Total Good Received Units: ${fmt(record.totalQty)}
Total Master SKUs to Update: ${fmt(record.totalSkus)}
Storage Archive: ${record.storageUrl || record.storagePath || "Saved in PostgreSQL"}
------------------------------------------------------------
This file includes the combined sum of good physical returns received across all marketplace accounts today. Damaged / issue-marked items are excluded.

Top SKUs:
${record.skuBreakdown
  .slice(0, 20)
  .map((s) => `- ${s.sku}: ${fmt(s.qty)} units (${Object.entries(s.marketplaces).map(([m, q]) => `${m}: ${q}`).join(", ")})`)
  .join("\n")}

Attached File: UpdateInStockQtyAnd_orLastPurchasePrice.csv
Ready for direct upload into OMSGuru under Bulk Inventory Adjustment.
============================================================
Generated automatically by Return App: https://return.youthnic.shop
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
    .header-table { width: 100%; border-collapse: collapse; background: linear-gradient(135deg, #063b2f 0%, #0d5948 50%, #0f6b56 100%); color: #ffffff; padding: 22px 26px; }
    .header-table td { padding: 20px 24px; vertical-align: middle; }
    .content { padding: 24px; }
    .hero-card { background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 10px; padding: 20px 22px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(16,185,129,0.06); }
    .ref-badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; background: #dcfce7; color: #166534; border: 1px solid #86efac; }
    .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 24px; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .stat-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px; }
    .stat-value { font-size: 24px; font-weight: 700; color: #0f172a; margin: 4px 0 2px; }
    .stat-sub { font-size: 12px; color: #16a34a; font-weight: 500; }
    .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #334155; margin: 24px 0 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
    table.data-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px; }
    table.data-table th { text-align: left; padding: 8px 10px; background: #f1f5f9; color: #475569; font-weight: 600; font-size: 11px; text-transform: uppercase; }
    table.data-table td { padding: 10px; border-bottom: 1px solid #f1f5f9; }
    .badge-mp { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; background: #e0f2fe; color: #0369a1; margin-right: 4px; margin-bottom: 2px; }
    .download-btn { display: inline-block; padding: 10px 18px; border-radius: 6px; font-size: 13px; font-weight: 700; background: #0f6b56; color: #ffffff !important; text-decoration: none; box-shadow: 0 2px 6px rgba(15,107,86,0.3); }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 18px 24px; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <table class="header-table" role="presentation" border="0" cellpadding="0" cellspacing="0">
      <tr>
        <td style="width: 52px; padding-right: 0;">
          <img src="https://return.youthnic.shop/logos/youthnic-icon.png" width="48" height="48" alt="Youthnic" style="border-radius: 12px; display: block; border: 1.5px solid rgba(255,255,255,0.3); box-shadow: 0 4px 10px rgba(0,0,0,0.25);" />
        </td>
        <td style="padding-left: 14px;">
          <div style="font-size: 10.5px; font-weight: 800; letter-spacing: 1.5px; color: #a7f3d0; text-transform: uppercase;">YOUTHNIC WAREHOUSE OPERATIONS</div>
          <h1 style="margin: 2px 0 0; font-size: 21px; font-weight: 800; color: #ffffff; letter-spacing: -0.3px;">OMSGuru Daily Inventory Update</h1>
          <p style="margin: 4px 0 0; font-size: 13px; color: #d1fae5;">Dropship Warehouse ID: <strong style="color: #ffffff;">${record.dropshipWarehouseId}</strong> · Date: <strong style="color: #ffffff;">${record.updateDate}</strong> (IST)</p>
        </td>
        <td style="text-align: right;">
          <span style="display: inline-block; padding: 6px 12px; background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.3); border-radius: 20px; font-size: 11.5px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px;">
            ✅ UPLOAD READY
          </span>
        </td>
      </tr>
    </table>

    <div class="content">
      <!-- Prominent Request Reference & Upload File Hero Card -->
      <div class="hero-card">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="vertical-align: top;">
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #166534; margin-bottom: 4px;">
                OFFICIAL REQUEST REFERENCE ID
              </div>
              <div style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 19px; font-weight: 800; color: #064e3b; letter-spacing: 0.5px;">
                ${record.requestId}
              </div>
              <div style="font-size: 12.5px; color: #15803d; margin-top: 3px;">
                Dropship Warehouse Node: <strong>${record.dropshipWarehouseId}</strong> · Action: <strong>ADD</strong> (Increment Stock)
              </div>
            </td>
            <td style="vertical-align: top; text-align: right;">
              <span class="ref-badge">
                100% Verified Physical Returns
              </span>
            </td>
          </tr>
        </table>

        <hr style="border: 0; border-top: 1px dashed #86efac; margin: 16px 0;" />

        <!-- Uploaded File Details -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="vertical-align: middle; width: 44px;">
              <div style="width: 42px; height: 42px; background: #16a34a; border-radius: 9px; display: table-cell; vertical-align: middle; text-align: center; color: #ffffff; font-size: 22px; line-height: 42px;">
                📄
              </div>
            </td>
            <td style="vertical-align: middle; padding-left: 12px;">
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #166534;">UPLOADED INVENTORY FILE (ATTACHED &amp; ARCHIVED)</div>
              <div style="font-size: 15px; font-weight: 700; color: #0f172a; margin-top: 2px;">
                <code>UpdateInStockQtyAnd_orLastPurchasePrice.csv</code>
              </div>
              <div style="font-size: 12px; color: #475569; margin-top: 2px;">
                Aggregated sum of good returns today across all marketplaces · <strong>${fmt(record.totalQty)}</strong> units across <strong>${fmt(record.totalSkus)}</strong> unique SKUs
              </div>
            </td>
            <td style="vertical-align: middle; text-align: right;">
              ${record.storageUrl ? `
              <a href="${record.storageUrl}" target="_blank" rel="noopener noreferrer" class="download-btn">
                ⬇ Download CSV
              </a>` : `
              <span style="font-size: 12px; font-weight: 700; color: #166534;">📎 File Attached</span>
              `}
            </td>
          </tr>
        </table>

        <!-- Storage Archive & Upload instructions -->
        <div style="margin-top: 14px; padding: 10px 14px; background: rgba(255,255,255,0.75); border-radius: 6px; font-size: 12px; color: #166534; line-height: 1.5;">
          <strong>ℹ️ Direct OMSGuru Upload Steps:</strong> Login to OMSGuru &gt; Inventory &gt; <strong>Bulk Inventory Adjustment</strong> &gt; Upload the attached CSV file (<code>UpdateInStockQtyAnd_orLastPurchasePrice.csv</code>) to apply today's stock to Dropship Warehouse <strong>${record.dropshipWarehouseId}</strong>.
          ${record.storageUrl ? `<br /><span style="color: #475569; font-size: 11.5px;">Cloud Storage: <a href="${record.storageUrl}" style="color: #0f6b56; font-weight: 600;">Download directly from Firebase Storage</a> (stored for 180 days).</span>` : ""}
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Good Units (ADD)</div>
          <div class="stat-value" style="color: #0f6b56;">${fmt(record.totalQty)}</div>
          <div class="stat-sub">100% verified physical stock</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unique Master SKUs</div>
          <div class="stat-value">${fmt(record.totalSkus)}</div>
          <div class="stat-sub">Aggregated across all channels</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Request ID Reference</div>
          <div class="stat-value" style="font-size: 15px; font-family: monospace; padding-top: 6px;">${record.requestId}</div>
          <div class="stat-sub">Traceability key</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Dropship Warehouse</div>
          <div class="stat-value" style="font-size: 20px;">${record.dropshipWarehouseId}</div>
          <div class="stat-sub">Default inventory node</div>
        </div>
      </div>

      <div class="section-title">Master Product SKUs Breakdown (${record.totalSkus} Total)</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Master SKU Code</th>
            <th style="text-align: right;">Total Qty</th>
            <th>Contributing Marketplaces</th>
          </tr>
        </thead>
        <tbody>
          ${record.skuBreakdown
            .slice(0, 30)
            .map(
              (item) => `
            <tr>
              <td><strong>${item.sku}</strong></td>
              <td style="text-align: right; font-weight: 700; color: #0f6b56;">${fmt(item.qty)}</td>
              <td>
                ${Object.entries(item.marketplaces)
                  .map(([mp, q]) => `<span class="badge-mp">${mp}: ${q}</span>`)
                  .join("")}
              </td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>

      ${record.skuBreakdown.length > 30 ? `<p style="font-size: 12px; color: #64748b;">...and ${record.skuBreakdown.length - 30} more SKUs in the attached CSV.</p>` : ""}

      <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 14px 18px; margin-top: 20px;">
        <span style="font-size: 12px; font-weight: 600; color: #475569;">📎 Attachment Included in this Email:</span><br />
        <code style="font-size: 13px; font-weight: 700; color: #0f172a;">UpdateInStockQtyAnd_orLastPurchasePrice.csv</code>
        <br />
        ${record.storageUrl ? `<small style="color: #64748b;">Archived in Firebase Storage for 180 days: <a href="${record.storageUrl}" style="color: #0f6b56; font-weight: 600;">Download Archive</a></small>` : ""}
      </div>
    </div>
    <div class="footer">
      Generated automatically by Youthnic Return Management App · Scheduled daily at 7:45 PM IST<br />
      Portal: <a href="https://return.youthnic.shop/register" style="color: #0f6b56; font-weight: 600;">return.youthnic.shop/register</a>
    </div>
  </div>
</body>
</html>
`.trim()

  return { subject, html, text }
}

// Sends the email with CSV attachment via Resend
export async function sendOmsguruDailyEmail(
  db: pg.Pool,
  updateId: number,
  options: { force?: boolean } = {},
): Promise<{ sent: boolean; recipients: string[]; cc: string[]; details?: string }> {
  const res = await db.query("SELECT * FROM omsguru_daily_inventory_updates WHERE id = $1", [updateId])
  const row = res.rows[0]
  if (!row) throw new Error(`OMSGuru update ${updateId} not found`)

  const config = await getOmsguruConfig(db)
  const recipients = await getAuthorizedRecipients(db)
  if (!recipients.length) {
    return { sent: false, recipients: [], cc: [], details: "No authorized recipients configured" }
  }

  const cc = config.ccEmails || []

  const record: OmsguruDailyUpdateRecord = {
    id: Number(row.id),
    requestId: String(row.request_id),
    updateDate: String(row.update_date).slice(0, 10),
    dropshipWarehouseId: String(row.dropship_warehouse_id),
    totalSkus: Number(row.total_skus),
    totalQty: Number(row.total_qty),
    csvContent: String(row.csv_content),
    fileName: String(row.file_name),
    storagePath: String(row.storage_path),
    storageUrl: String(row.storage_url),
    emailSent: Boolean(row.email_sent),
    emailSentAt: row.email_sent_at ? new Date(row.email_sent_at).toISOString() : null,
    emailRecipients: recipients,
    emailCc: cc,
    skuBreakdown: (row.sku_breakdown as SkuUpdateItem[]) || [],
    generatedBy: row.generated_by ? Number(row.generated_by) : null,
    createdAt: new Date(row.created_at).toISOString(),
  }

  const email = renderOmsguruUpdateEmail(record, config)

  // Encode CSV content to Base64 for Resend attachment
  const csvBase64 = Buffer.from(record.csvContent, "utf8").toString("base64")

  await sendEmailViaResend({
    to: recipients,
    cc: cc.length ? cc : undefined,
    subject: email.subject,
    html: email.html,
    text: email.text,
    attachments: [
      {
        filename: "UpdateInStockQtyAnd_orLastPurchasePrice.csv",
        content: csvBase64,
      },
    ],
  })

  await db.query(
    `UPDATE omsguru_daily_inventory_updates
     SET email_sent = true, email_sent_at = now(), email_recipients = $1, email_cc = $2
     WHERE id = $3`,
    [recipients, cc, updateId],
  )

  return { sent: true, recipients, cc }
}

// Scheduled runner: triggers daily at configured time (default 19:45 IST)
export async function runScheduledOmsguruUpdate(
  db: pg.Pool,
  options: { force?: boolean } = {},
): Promise<{ ran: boolean; details?: string }> {
  const lock = await db.query("SELECT pg_try_advisory_lock(hashtext('omsguru_daily_scheduler')) AS acquired")
  if (!lock.rows[0]?.acquired) {
    return { ran: false, details: "Advisory lock busy (another process is running OMSGuru scheduler)" }
  }

  try {
    const config = await getOmsguruConfig(db)
    if (!config.dailyEnabled && !options.force) {
      return { ran: false, details: "OMSGuru daily schedule is disabled" }
    }

    const ist = getIstDateParts()
    const currentTime = ist.timeStr // e.g. "19:45"
    const isDue = options.force || currentTime === config.dailyTime

    if (!isDue) {
      return { ran: false, details: `Not due yet (current IST: ${currentTime}, scheduled: ${config.dailyTime})` }
    }

    // Check if update was already generated and emailed today
    const existing = await db.query(
      "SELECT id, email_sent FROM omsguru_daily_inventory_updates WHERE update_date = $1",
      [ist.dateStr],
    )

    let updateRecord: OmsguruDailyUpdateRecord
    if (existing.rows[0]) {
      if (existing.rows[0].email_sent && !options.force) {
        return { ran: false, details: `OMSGuru daily update already sent for ${ist.dateStr}` }
      }
      updateRecord = await generateOmsguruDailyUpdate(db, { targetDate: ist.dateStr })
    } else {
      updateRecord = await generateOmsguruDailyUpdate(db, { targetDate: ist.dateStr })
    }

    // Send email
    const emailResult = await sendOmsguruDailyEmail(db, updateRecord.id, { force: options.force })
    return {
      ran: true,
      details: `Generated and sent OMSGuru daily update (${updateRecord.requestId}) with ${updateRecord.totalQty} units across ${updateRecord.totalSkus} SKUs to ${emailResult.recipients.length} recipients`,
    }
  } catch (err: any) {
    console.error("[OMSGuru Scheduler Error]", err)
    return { ran: false, details: `Error: ${err.message}` }
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtext('omsguru_daily_scheduler'))")
  }
}
