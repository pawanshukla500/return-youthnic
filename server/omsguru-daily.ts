// OMSGuru Daily Inventory Update Engine & Firebase Storage Integration for Return App.
//
// Automatically aggregates all physical returns received in good condition across all marketplaces for each day,
// groups by master product SKU code, formats the standard OMSGuru CSV, uploads to Firebase Storage
// under inventory-update-file/ (with 180-day retention pruning), and sends scheduled/on-demand Resend emails
// with CSV attachment and CC audit recipients.

import crypto from "node:crypto"
import type pg from "pg"
import { getIstDateParts, sendEmailViaResend } from "./email-reports.js"
import { compactSkuKey, listingSkuCandidates, marketplaceRank } from "./marketplace-rules.js"
import {
  uploadToFirebaseStorage,
  deleteFromFirebaseStorage,
  listFirebaseStorageFiles,
  isFirebaseConfigured,
} from "./firebase-storage.js"
import { autoResolveMissingListingSkus, recordUnmappedListingSkus } from "./product-master.js"

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
  dailyTime: string // "23:00" (11:00 PM IST)
  dropshipWarehouseId: string // "6688"
  retentionDays: number // 180
  storageFolder: string // "inventory-update-file"
  ccEmails: string[]
}

export const DEFAULT_OMSGURU_CONFIG: OmsguruConfig = {
  dailyEnabled: true,
  dailyTime: "23:00",
  dropshipWarehouseId: "6688",
  retentionDays: 180,
  storageFolder: "inventory-update-file",
  ccEmails: [],
}

// Accepts "23:00" or "23:00:00" and returns 24-hour HH:MM. Anything else is rejected.
export function normalizeDailyTime(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

// "23:00" becomes "11:00 PM" for the email and the Admin screen.
export function formatDailyTimeLabel(value: string): string {
  const clock = normalizeDailyTime(value) || DEFAULT_OMSGURU_CONFIG.dailyTime
  const [hourText, minuteText] = clock.split(":")
  const hour = Number(hourText)
  const suffix = hour >= 12 ? "PM" : "AM"
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12}:${minuteText} ${suffix}`
}

export type InventoryLine = {
  orderKey: string
  listingSku: string
  productSku: string
  marketplace: string
  receivedQty: number
  // Units marked with any non-missing issue, including Iron Send.
  issueQty: number
  itemId: number
  trackingId: string
  orderNumber: string
}

export type MasterListing = {
  marketplace: string
  listingSku: string
  masterSku: string
}

// One Product SkuCode for a channel listing. A marketplace-specific master row beats an all-marketplaces row.
// The parent listing (without an article suffix such as _You) is used when the exact listing is not stored.
export function resolveProductSkuCode(
  listingSku: string,
  storedProductSku: string,
  marketplace: string,
  masters: readonly MasterListing[],
): { sku: string; mapped: boolean } {
  const listing = listingSku.trim()
  const candidates = listingSkuCandidates(listing).map((candidate) => compactSkuKey(candidate))
  let best: { sku: string; score: number } | null = null
  for (let place = 0; place < candidates.length; place++) {
    const compact = candidates[place]
    if (!compact) continue
    for (const row of masters) {
      if (compactSkuKey(row.listingSku) !== compact) continue
      const rank = marketplaceRank(row.marketplace, marketplace)
      if (rank === 0) continue
      const score = (candidates.length - place) * 10 + rank
      const sku = row.masterSku.trim()
      if (!sku) continue
      if (!best || score > best.score) best = { sku, score }
    }
  }
  if (best) return { sku: best.sku, mapped: true }
  const stored = storedProductSku.trim()
  if (stored && stored.toUpperCase() !== "UNRESOLVED" && compactSkuKey(stored) !== compactSkuKey(listing)) {
    return { sku: stored, mapped: true }
  }
  return { sku: listing, mapped: false }
}

// Sums clear returns by Product SkuCode across every channel listing and marketplace.
// An order with any non-missing issue, including Iron Send, is left out entirely.
export function aggregateInventoryByProductSku(
  lines: readonly InventoryLine[],
  masters: readonly MasterListing[],
): {
  skus: SkuUpdateItem[]
  totalQty: number
  unmappedItems: UnmappedScannedItem[]
  unmappedByMarketplace: Map<string, Set<string>>
} {
  const blockedOrders = new Set<string>()
  for (const line of lines) {
    if (line.issueQty > 0 && line.orderKey) blockedOrders.add(line.orderKey)
  }

  const buckets = new Map<string, { sku: string; qty: number; marketplaces: Record<string, number> }>()
  const unmappedItems: UnmappedScannedItem[] = []
  const unmappedByMarketplace = new Map<string, Set<string>>()

  for (const line of lines) {
    if (line.orderKey && blockedOrders.has(line.orderKey)) continue
    if (line.issueQty > 0) continue
    const qty = Math.max(0, Math.floor(line.receivedQty))
    if (qty <= 0) continue

    const resolved = resolveProductSkuCode(line.listingSku, line.productSku, line.marketplace, masters)
    const masterSku = resolved.sku.trim()
    if (!masterSku) continue
    if (!resolved.mapped) {
      unmappedItems.push({
        itemId: line.itemId,
        marketplace: line.marketplace || "Other",
        trackingId: line.trackingId,
        orderNumber: line.orderNumber,
        listingSku: line.listingSku.trim(),
        goodQty: qty,
      })
      const mpSet = unmappedByMarketplace.get(line.marketplace || "Other") ?? new Set<string>()
      if (line.listingSku.trim()) mpSet.add(line.listingSku.trim())
      unmappedByMarketplace.set(line.marketplace || "Other", mpSet)
    }

    const key = compactSkuKey(masterSku)
    const existing = buckets.get(key) ?? { sku: masterSku, qty: 0, marketplaces: {} }
    existing.qty += qty
    const mp = line.marketplace || "Other"
    existing.marketplaces[mp] = (existing.marketplaces[mp] || 0) + qty
    buckets.set(key, existing)
  }

  const skus = [...buckets.values()]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map((entry) => ({ sku: entry.sku, qty: entry.qty, marketplaces: entry.marketplaces }))
  const totalQty = skus.reduce((sum, entry) => sum + entry.qty, 0)
  return { skus, totalQty, unmappedItems, unmappedByMarketplace }
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
      let dailyTime = normalizeDailyTime(stored.dailyTime || "") || DEFAULT_OMSGURU_CONFIG.dailyTime
      // Migrate from old 19:45 (7:45 PM) schedule to 23:00 (11:00 PM IST)
      if (stored.dailyTime === "19:45") {
        dailyTime = "23:00"
        db.query(
          "UPDATE app_system_settings SET setting_value = jsonb_set(setting_value, '{dailyTime}', '\"23:00\"') WHERE setting_key = 'omsguru_config'",
        ).catch(() => {})
      }
      return {
        dailyEnabled: stored.dailyEnabled ?? DEFAULT_OMSGURU_CONFIG.dailyEnabled,
        dailyTime,
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
  const requestedTime = config.dailyTime !== undefined ? normalizeDailyTime(config.dailyTime) : current.dailyTime
  if (config.dailyTime !== undefined && !requestedTime) {
    throw new Error("Daily time must be HH:MM in 24-hour form, for example 23:00.")
  }
  const updated: OmsguruConfig = {
    dailyEnabled: config.dailyEnabled ?? current.dailyEnabled,
    dailyTime: requestedTime || current.dailyTime,
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
      rs.id AS scan_id,
      rsi.id AS item_id,
      COALESCE(NULLIF(rs.scanned_tracking, ''), rs.tracking_id_snapshot, er.tracking_id, '') AS tracking_id,
      COALESCE(er.order_number, '') AS order_number,
      COALESCE(m.name, rs.marketplace_snapshot, 'Unknown') AS marketplace,
      COALESCE(rsi.marketplace_sku, '') AS marketplace_sku,
      COALESCE(rsi.product_sku, '') AS product_sku,
      rsi.received_qty,
      COALESCE(issues.issue_qty, 0)::int AS issue_qty
    FROM receipt_scans rs
    JOIN receipt_scan_items rsi ON rsi.receipt_scan_id = rs.id
    LEFT JOIN expected_returns er ON er.id = rs.expected_return_id
    LEFT JOIN marketplaces m ON m.id = er.marketplace_id
    -- Missing-item issues are left out of this count, because a missing unit is already absent from received_qty.
    -- Every other mark, including Iron Send, blocks the whole order from the inventory file.
    LEFT JOIN (
      SELECT x.receipt_scan_item_id, SUM(x.qty)::int AS issue_qty
      FROM receipt_scan_issues x
      LEFT JOIN receipt_issue_categories c ON c.code = x.category_code
      WHERE NOT COALESCE(c.is_missing, false)
      GROUP BY x.receipt_scan_item_id
    ) issues ON issues.receipt_scan_item_id = rsi.id
    WHERE rs.scanned_at >= $1::timestamptz AND rs.scanned_at <= $2::timestamptz
    ORDER BY rs.scanned_at ASC, rsi.id ASC
  `

  const res = await db.query(sql, [periodStart, periodEnd])
  const lines: InventoryLine[] = res.rows.map((row) => {
    const marketplace = String(row.marketplace || "Unknown")
    const orderNumber = String(row.order_number || "").trim()
    // One scanned return. An issue on any line of that return, including Iron Send, keeps the whole return out.
    const orderKey = `scan:${Number(row.scan_id)}`
    return {
      orderKey,
      listingSku: String(row.marketplace_sku || ""),
      productSku: String(row.product_sku || ""),
      marketplace,
      receivedQty: Number(row.received_qty || 0),
      issueQty: Number(row.issue_qty || 0),
      itemId: Number(row.item_id),
      trackingId: String(row.tracking_id || ""),
      orderNumber,
    }
  })

  const compacts = new Set<string>()
  for (const line of lines) {
    if (line.issueQty > 0) continue
    for (const candidate of listingSkuCandidates(line.listingSku)) {
      const compact = compactSkuKey(candidate)
      if (compact) compacts.add(compact)
    }
    const stored = compactSkuKey(line.productSku)
    if (stored && stored !== "unresolved") compacts.add(stored)
  }

  let masters: MasterListing[] = []
  if (compacts.size) {
    const pmRes = await db.query(
      `SELECT marketplace, listing_sku, master_sku
       FROM product_master
       WHERE replace(lower(listing_sku), ' ', '') = ANY($1::text[])`,
      [[...compacts]],
    )
    masters = pmRes.rows.map((row) => ({
      marketplace: String(row.marketplace || ""),
      listingSku: String(row.listing_sku || ""),
      masterSku: String(row.master_sku || ""),
    }))
  }

  const aggregated = aggregateInventoryByProductSku(lines, masters)
  const { unmappedItems, unmappedByMarketplace } = aggregated

  // Auto-record any unmapped listing SKUs found in scans
  if (unmappedByMarketplace.size > 0) {
    for (const [mp, skusSet] of unmappedByMarketplace) {
      await recordUnmappedListingSkus(db, mp, [...skusSet])
    }
  }

  return {
    skus: aggregated.skus,
    totalSkus: aggregated.skus.length,
    totalQty: aggregated.totalQty,
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

  // 0. Pre-flight scan & auto-link: map missing listing SKUs from OMSGuru channels and VMS database before generating inventory
  try {
    const linkSummary = await autoResolveMissingListingSkus(db)
    if (linkSummary.vmsMappingsCreated > 0 || linkSummary.omsguruBridged > 0 || linkSummary.pastedBlankImages > 0) {
      console.log(
        `[OMSGuru Daily Preflight] Auto-linked: ${linkSummary.omsguruBridged} OMSGuru mappings, ${linkSummary.vmsMappingsCreated} VMS mappings, ${linkSummary.pastedBlankImages} images pasted.`,
      )
    }
  } catch (linkErr) {
    console.warn("[OMSGuru Daily Preflight Linkup Warning]", linkErr)
  }

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

function formatDisplayDate(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split("-").map(Number)
    if (!y || !m || !d) return dateStr
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return `${d} ${months[m - 1]} ${y}`
  } catch {
    return dateStr
  }
}

// Renders rich HTML email template matching the modern TaskFlow Pro / Youthnic briefing layout
export function renderOmsguruUpdateEmail(
  record: OmsguruDailyUpdateRecord,
  config: OmsguruConfig,
): { subject: string; html: string; text: string } {
  const formattedDate = formatDisplayDate(record.updateDate)
  const clock = normalizeDailyTime(config.dailyTime) || DEFAULT_OMSGURU_CONFIG.dailyTime
  const clockLabel = formatDailyTimeLabel(clock)
  const subject = `OMSGuru Daily Inventory Update — ${record.updateDate} (Req: ${record.requestId}) — ${fmt(record.totalQty)} Units (${fmt(record.totalSkus)} SKUs)`

  // Compute marketplace breakdown metrics
  const mpTotals: Record<string, number> = {}
  for (const item of record.skuBreakdown) {
    for (const [mp, q] of Object.entries(item.marketplaces || {})) {
      mpTotals[mp] = (mpTotals[mp] || 0) + q
    }
  }
  const mpEntries = Object.entries(mpTotals).sort((a, b) => b[1] - a[1])
  const mpCount = mpEntries.length
  const mpSummaryText =
    mpEntries.length > 0
      ? mpEntries.map(([mp, q]) => `${mp} (${fmt(q)} units)`).join(" · ")
      : "No marketplace returns recorded today"

  const text = `
Youthnic Returns — OMSGuru Daily Inventory Update
============================================================
Date: ${record.updateDate} (Asia/Kolkata)
Scheduled Dispatch: ${clock} IST (${clockLabel})
Request ID: ${record.requestId}
Dropship Warehouse ID: ${record.dropshipWarehouseId}
Total Good Received Units: ${fmt(record.totalQty)}
Total Master SKUs to Update: ${fmt(record.totalSkus)}
Active Marketplaces (${mpCount}): ${mpSummaryText}
Storage Archive: ${record.storageUrl || record.storagePath || "Saved in PostgreSQL (180 days retention)"}
------------------------------------------------------------
This file sums Product SkuCode quantities from every channel listing across all marketplaces. An order with any issue mark, including Iron Send, is left out. A missing-only line still counts the units that physically arrived.

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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f1f5f9; color: #0f172a; margin: 0; padding: 24px 12px; }
    .container { max-width: 660px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.06), 0 8px 10px -6px rgba(0,0,0,0.02); }
    .header-banner { background: #093c31; background: linear-gradient(135deg, #06382c 0%, #0c4d3d 50%, #0f5c49 100%); color: #ffffff; padding: 28px 30px; }
    .content { padding: 30px 30px 24px 30px; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 8px; text-align: center; }
    .stat-number { font-size: 26px; font-weight: 800; line-height: 1; }
    .stat-label { font-size: 11px; font-weight: 800; color: #64748b; letter-spacing: 0.8px; text-transform: uppercase; margin-top: 8px; }
    .priority-focus-card { background: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #ea580c; border-radius: 8px; padding: 14px 18px; margin-bottom: 24px; }
    .hero-card { background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 12px; padding: 20px 22px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(16,185,129,0.06); }
    .ref-badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; background: #dcfce7; color: #166534; border: 1px solid #86efac; }
    .section-title { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.6px; color: #334155; margin: 26px 0 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
    table.data-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px; }
    table.data-table th { text-align: left; padding: 9px 12px; background: #f1f5f9; color: #475569; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    table.data-table td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; }
    .badge-mp { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #e0f2fe; color: #0369a1; margin-right: 4px; margin-bottom: 2px; }
    .download-btn { display: inline-block; padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 700; background: #0f6b56; color: #ffffff !important; text-decoration: none; box-shadow: 0 2px 6px rgba(15,107,86,0.3); }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 24px; font-size: 12px; color: #64748b; text-align: center; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header Banner matching the screenshot design -->
    <div class="header-banner">
      <!-- App Brand Row -->
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="width: 100%; margin-bottom: 20px;">
        <tr>
          <td style="width: 52px; vertical-align: middle;">
            <!-- White Squircle Badge with Youthnic Monogram -->
            <div style="width: 48px; height: 48px; background-color: #ffffff; border-radius: 12px; text-align: center; line-height: 48px; box-shadow: 0 4px 12px rgba(0,0,0,0.22); overflow: hidden; display: block;">
              <img src="https://return.youthnic.shop/logos/youthnic-badge.png" width="48" height="48" alt="Youthnic" style="display: block; border: 0; width: 48px; height: 48px; border-radius: 12px;" />
            </div>
          </td>
          <td style="padding-left: 14px; vertical-align: middle;">
            <div style="font-size: 19px; font-weight: 800; color: #ffffff; letter-spacing: -0.2px; line-height: 1.2;">
              TaskFlow Pro <span style="font-size: 13px; font-weight: 600; color: #a7f3d0; opacity: 0.9;">· Return Scan</span>
            </div>
            <div style="font-size: 11px; font-weight: 700; letter-spacing: 1.2px; color: #a7f3d0; text-transform: uppercase; margin-top: 3px;">
              YOUTHNIC · VB EXPORTS
            </div>
          </td>
          <td style="text-align: right; vertical-align: middle;">
            <span style="display: inline-block; padding: 6px 14px; background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.3); border-radius: 20px; font-size: 11px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px;">
              ● ${clock} IST DISPATCH
            </span>
          </td>
        </tr>
      </table>

      <!-- Briefing Headline & Subtitle -->
      <h1 style="margin: 0 0 6px 0; font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.4px; line-height: 1.25;">
        Your evening inventory briefing
      </h1>
      <div style="font-size: 13px; font-weight: 500; color: #d1fae5; letter-spacing: 0.1px;">
        Daily inventory update · ${formattedDate} · ${clock} IST (${clockLabel}) · Mon–Sun
      </div>
    </div>

    <!-- Main Content Area -->
    <div class="content">
      <!-- Greeting and Intro -->
      <h2 style="margin: 0 0 10px 0; font-size: 21px; font-weight: 800; color: #0f172a; letter-spacing: -0.3px;">
        Good evening, Team
      </h2>
      <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #475569;">
        Here is today's OMSGuru inventory update. Each row is one Product SkuCode, summed from every channel listing across all marketplaces. Orders with any issue mark, including Iron Send, are left out.
      </p>

      <!-- 4-Card Horizontal Stat Grid (Table layout for universal email client compatibility) -->
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
        <tr>
          <td width="23%" style="padding: 0 4px 0 0; vertical-align: top;">
            <div class="stat-card">
              <div class="stat-number" style="color: ${record.totalQty > 0 ? "#0f6b56" : "#dc2626"};">${fmt(record.totalQty)}</div>
              <div class="stat-label">GOOD UNITS</div>
            </div>
          </td>
          <td width="23%" style="padding: 0 4px; vertical-align: top;">
            <div class="stat-card">
              <div class="stat-number" style="color: #ea580c;">${fmt(record.totalSkus)}</div>
              <div class="stat-label">MASTER SKUS</div>
            </div>
          </td>
          <td width="23%" style="padding: 0 4px; vertical-align: top;">
            <div class="stat-card">
              <div class="stat-number" style="color: #0284c7;">${mpCount}</div>
              <div class="stat-label">CHANNELS</div>
            </div>
          </td>
          <td width="23%" style="padding: 0 0 0 4px; vertical-align: top;">
            <div class="stat-card">
              <div class="stat-number" style="color: #334155; font-size: 22px;">${record.dropshipWarehouseId}</div>
              <div class="stat-label">WAREHOUSE</div>
            </div>
          </td>
        </tr>
      </table>

      <!-- Priority Focus Card (Accent Left Border from screenshot) -->
      <div class="priority-focus-card">
        <div style="font-size: 13px; font-weight: 800; color: #0f172a; margin-bottom: 4px;">
          Priority focus
        </div>
        <div style="font-size: 12.5px; color: #64748b; line-height: 1.5;">
          Issue-marked orders and Iron Send are left out · <strong>${mpCount}</strong> marketplace channel${mpCount === 1 ? "" : "s"} · ${mpSummaryText}
        </div>
      </div>

      <!-- Prominent Request Reference & Upload File Hero Card -->
      <div class="hero-card">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="vertical-align: top;">
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #166534; margin-bottom: 4px;">
                OFFICIAL REQUEST REFERENCE ID
              </div>
              <div style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 18px; font-weight: 800; color: #064e3b; letter-spacing: 0.5px;">
                ${record.requestId}
              </div>
              <div style="font-size: 12.5px; color: #15803d; margin-top: 3px;">
                Dropship Warehouse ID: <strong>${record.dropshipWarehouseId}</strong> · Action: <strong>ADD</strong> (Increment Stock)
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
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #166534;">
                UPLOAD READY FILE (ATTACHED &amp; ARCHIVED)
              </div>
              <div style="font-size: 15px; font-weight: 700; color: #0f172a; margin-top: 2px;">
                <code>UpdateInStockQtyAnd_orLastPurchasePrice.csv</code>
              </div>
              <div style="font-size: 12px; color: #475569; margin-top: 2px;">
                Product SkuCode totals across all marketplaces · <strong>${fmt(record.totalQty)}</strong> units across <strong>${fmt(record.totalSkus)}</strong> product SKUs
              </div>
            </td>
            <td style="vertical-align: middle; text-align: right;">
              ${
                record.storageUrl
                  ? `
              <a href="${record.storageUrl}" target="_blank" rel="noopener noreferrer" class="download-btn">
                ⬇ Download CSV
              </a>`
                  : `
              <span style="font-size: 12px; font-weight: 700; color: #166534;">📎 File Attached</span>
              `
              }
            </td>
          </tr>
        </table>

        <!-- Storage Archive & Upload instructions -->
        <div style="margin-top: 14px; padding: 12px 14px; background: rgba(255,255,255,0.8); border-radius: 8px; font-size: 12px; color: #166534; line-height: 1.5;">
          <strong>ℹ️ Direct OMSGuru Upload Steps:</strong> Login to OMSGuru &gt; Inventory &gt; <strong>Bulk Inventory Adjustment</strong> &gt; Upload the attached CSV file (<code>UpdateInStockQtyAnd_orLastPurchasePrice.csv</code>) to apply today's stock to Dropship Warehouse <strong>${record.dropshipWarehouseId}</strong>.
          ${
            record.storageUrl
              ? `<br /><span style="color: #475569; font-size: 11.5px;">Cloud Storage: <a href="${record.storageUrl}" style="color: #0f6b56; font-weight: 600;">Download directly from Firebase Storage</a> (retained for 180 days).</span>`
              : `<br /><span style="color: #475569; font-size: 11.5px;">Cloud Archive: Saved permanently with 180 days retention policy.</span>`
          }
        </div>
      </div>

      <!-- Master SKU Breakdown Table -->
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
              <td><strong style="font-family: ui-monospace, SFMono-Regular, monospace;">${item.sku}</strong></td>
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

      ${record.skuBreakdown.length > 30 ? `<p style="font-size: 12px; color: #64748b; margin-top: 6px;">...and ${record.skuBreakdown.length - 30} more SKUs in the attached CSV.</p>` : ""}

      <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 14px 18px; margin-top: 20px;">
        <span style="font-size: 12px; font-weight: 700; color: #475569;">📎 Attachment Included in this Email:</span><br />
        <code style="font-size: 13px; font-weight: 700; color: #0f172a;">UpdateInStockQtyAnd_orLastPurchasePrice.csv</code>
        <br />
        <small style="color: #64748b;">Archived in Firebase Storage for 180 days${record.storageUrl ? `: <a href="${record.storageUrl}" style="color: #0f6b56; font-weight: 600;">Download Archive</a>` : ""}</small>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      Generated automatically by <strong>TaskFlow Pro · Return Scan</strong> (Youthnic · VB Exports)<br />
      Scheduled daily at <strong>${clockLabel} IST (${clock})</strong> · Portal: <a href="https://return.youthnic.shop/register" style="color: #0f6b56; font-weight: 600;">return.youthnic.shop/register</a>
    </div>
  </div>
</body>
</html>
`.trim()

  return { subject, html, text }
}

// Supervisors receive the inventory email. Admins are copied. Extra addresses in the OMSGuru settings are copied too.
export async function omsguruDispatchList(
  db: pg.Pool,
  extraCc: readonly string[] = [],
): Promise<{ to: string[]; cc: string[] }> {
  const res = await db.query(
    `SELECT email, role FROM users
     WHERE status = 'Active' AND lower(role) IN ('admin', 'supervisor') AND btrim(email) <> ''
     ORDER BY id`,
  )
  const to: string[] = []
  const cc: string[] = []
  const seen = new Set<string>()
  for (const row of res.rows) {
    const email = String(row.email || "").trim().toLowerCase()
    if (!email || seen.has(email)) continue
    if (String(row.role || "").toLowerCase() === "supervisor") {
      to.push(email)
      seen.add(email)
    }
  }
  for (const row of res.rows) {
    const email = String(row.email || "").trim().toLowerCase()
    if (!email || seen.has(email)) continue
    if (String(row.role || "").toLowerCase() === "admin") {
      cc.push(email)
      seen.add(email)
    }
  }
  for (const extra of extraCc) {
    const email = String(extra || "").trim().toLowerCase()
    if (!email.includes("@") || seen.has(email)) continue
    cc.push(email)
    seen.add(email)
  }
  return { to, cc }
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
  const dispatch = await omsguruDispatchList(db, config.ccEmails || [])
  const recipients = dispatch.to
  const cc = dispatch.cc
  if (!recipients.length) {
    return { sent: false, recipients: [], cc, details: "No active Supervisor is available to receive the inventory email" }
  }

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

// Scheduled runner: triggers daily at configured time (default 23:00 IST / 11:00 PM)
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
    const currentTime = ist.timeStr // e.g. "23:00"
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
