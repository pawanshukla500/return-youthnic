// Centralized Return Reason Categorization, Garment Sizing Intelligence, and Analytics Engine.
// Standardizes disparate return reasons across Myntra, Amazon, Meesho, Flipkart, and AJio
// into canonical root causes, distinguishes seller mistakes from customer remorse/logistics,
// and isolates garment size defects for pattern-making actionable intelligence.

import type pg from "pg"
import type { AccountScope } from "./access.js"
import { accountCondition } from "./access.js"

export type CanonicalCategoryCode =
  | "SELLER_FAULT_DEFECTIVE"
  | "SELLER_FAULT_WRONG_ITEM"
  | "SELLER_FAULT_MISSING_ITEM"
  | "SELLER_FAULT_QUALITY"
  | "SIZE_FIT_TOO_SMALL"
  | "SIZE_FIT_TOO_LARGE"
  | "SIZE_FIT_GENERAL"
  | "CUSTOMER_REMORSE"
  | "LOGISTICS_COURIER_RTO"
  | "OTHER_UNKNOWN"

export type CanonicalReasonInfo = {
  categoryCode: CanonicalCategoryCode
  label: string
  department: string
  isSellerFault: boolean
  isSizeIssue: boolean
  severity: "critical" | "high" | "medium" | "low"
  description: string
  actionRecommendation: string
}

export const CANONICAL_REASONS: Record<CanonicalCategoryCode, CanonicalReasonInfo> = {
  SELLER_FAULT_DEFECTIVE: {
    categoryCode: "SELLER_FAULT_DEFECTIVE",
    label: "Defective / Damaged Merchandise",
    department: "Quality Control & Manufacturing",
    isSellerFault: true,
    isSizeIssue: false,
    severity: "high",
    description: "Damaged, torn, stained, defective product, stitching defect or manufacturing fault.",
    actionRecommendation: "Urgent: Halt lot production if clustered. Inspect batch cutting/stitching and packing station QC before release.",
  },
  SELLER_FAULT_WRONG_ITEM: {
    categoryCode: "SELLER_FAULT_WRONG_ITEM",
    label: "Wrong Item / Mis-shipment",
    department: "Dispatch & Packing Bench",
    isSellerFault: true,
    isSizeIssue: false,
    severity: "critical",
    description: "Completely different product, wrong color, wrong size sent, or misshipment delivered to buyer.",
    actionRecommendation: "Urgent: Inspect picker/packer barcode scanning at dispatch. Verify SKU tags match garment labels in warehouse.",
  },
  SELLER_FAULT_MISSING_ITEM: {
    categoryCode: "SELLER_FAULT_MISSING_ITEM",
    label: "Missing Components / Accessories",
    department: "Packing & Assembly",
    isSellerFault: true,
    isSizeIssue: false,
    severity: "high",
    description: "Incomplete package: missing dupatta, belt, accessory, or partial set contents delivered.",
    actionRecommendation: "Enforce multi-piece set verification checklist during secondary polybag packaging.",
  },
  SELLER_FAULT_QUALITY: {
    categoryCode: "SELLER_FAULT_QUALITY",
    label: "Poor Quality / Fabric / Finish Discrepancy",
    department: "Fabric Sourcing & Finishing",
    isSellerFault: true,
    isSizeIssue: false,
    severity: "medium",
    description: "Customer dissatisfied with product quality, fabric feel, or image looks significantly better than reality.",
    actionRecommendation: "Audit fabric GSM, hand-feel, wash durability, and catalogue photography color accuracy.",
  },
  SIZE_FIT_TOO_SMALL: {
    categoryCode: "SIZE_FIT_TOO_SMALL",
    label: "Size Too Small (Runs Small)",
    department: "Pattern & Sizing Team",
    isSellerFault: false,
    isSizeIssue: true,
    severity: "medium",
    description: "Garment fits tighter or smaller than customer expected according to size chart.",
    actionRecommendation: "Pattern revision: Review chest/waist/hip specs; consider +0.5 to +1 inch ease or advise buyers to size up.",
  },
  SIZE_FIT_TOO_LARGE: {
    categoryCode: "SIZE_FIT_TOO_LARGE",
    label: "Size Too Big (Runs Large)",
    department: "Pattern & Sizing Team",
    isSellerFault: false,
    isSizeIssue: true,
    severity: "medium",
    description: "Garment fits looser or larger than customer expected according to size chart.",
    actionRecommendation: "Pattern revision: Review ease grading; consider trimming excess garment chest/waist circumference.",
  },
  SIZE_FIT_GENERAL: {
    categoryCode: "SIZE_FIT_GENERAL",
    label: "General Fit & Silhouette Issue",
    department: "Pattern & Sizing Team",
    isSellerFault: false,
    isSizeIssue: true,
    severity: "low",
    description: "Customer did not like the fit, cut, or drape of the garment.",
    actionRecommendation: "Analyze fit feedback across customer demographics to refine garment cut and silhouette styling.",
  },
  CUSTOMER_REMORSE: {
    categoryCode: "CUSTOMER_REMORSE",
    label: "Customer Mind Changed / Preference",
    department: "Merchandising & Sales",
    isSellerFault: false,
    isSizeIssue: false,
    severity: "low",
    description: "Buyer remorse: no longer needed, found cheaper elsewhere, did not suit styling/color preference, accidental order.",
    actionRecommendation: "No seller mistake. Monitor conversion and pricing competitiveness on channel.",
  },
  LOGISTICS_COURIER_RTO: {
    categoryCode: "LOGISTICS_COURIER_RTO",
    label: "Logistics / Delayed / In-Transit / RTO",
    department: "Logistics & Carrier SLA",
    isSellerFault: false,
    isSizeIssue: false,
    severity: "low",
    description: "Delayed delivery, carrier damaged transit packaging, customer refused delivery, or cancelled before dispatch.",
    actionRecommendation: "Hold carrier accountable for transit damage and delivery SLA violations via SLA penalty claims.",
  },
  OTHER_UNKNOWN: {
    categoryCode: "OTHER_UNKNOWN",
    label: "Uncategorized / Other Reason",
    department: "Operations",
    isSellerFault: false,
    isSizeIssue: false,
    severity: "low",
    description: "Generic reason, approval flow, or unclassified feedback.",
    actionRecommendation: "Review raw reason and map to specific canonical category if volume increases.",
  },
}

// ---------------------------------------------------------------------------------------------------------------
// Apparel Garment Size Extractor
// ---------------------------------------------------------------------------------------------------------------

const STANDARD_SIZES: Record<string, string> = {
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
  xxl: "XXL",
  "2xl": "XXL",
  "3xl": "3XL",
  xxxl: "3XL",
  "4xl": "4XL",
  xxxxl: "4XL",
  "5xl": "5XL",
  "6xl": "6XL",
  free: "Free Size",
  freesize: "Free Size",
  fs: "Free Size",
}

/**
 * Extracts normalized apparel size (XS, S, M, L, XL, XXL, 3XL, 4XL, 5XL, Free Size)
 * from listing SKUs, SKU codes, product titles, or item labels.
 * Examples:
 *   "BT218-Cat-Light Blue_S_You" -> "S"
 *   "BT218-Cat-Light Blue_XL_You" -> "XL"
 *   "BT267-Raman-Teal_M_You" -> "M"
 *   "KURTI-SET-PINK-3XL" -> "3XL"
 *   "Women Kurta Set - Free Size" -> "Free Size"
 *   "Size: XXL" -> "XXL"
 */
export function extractGarmentSize(raw: string | null | undefined): string {
  if (!raw) return ""
  const text = String(raw).trim()
  if (!text) return ""

  // 1. Check for free size explicitly
  if (/\b(free\s*size|freesize)\b/i.test(text)) {
    return "Free Size"
  }

  // 2. Check for underscore/hyphen delimited tokens in listing SKUs:
  // e.g. _S_, _M_, _L_, _XL_, _XXL_, _2XL_, _3XL_, _4XL_, _5XL_, _XS_
  const tokenMatch = text.match(/[_\-\s](xs|s|m|l|xl|xxl|2xl|3xl|xxxl|4xl|5xl|6xl)[_\-\s]/i)
  if (tokenMatch && tokenMatch[1]) {
    const key = tokenMatch[1].toLowerCase()
    if (STANDARD_SIZES[key]) return STANDARD_SIZES[key]
  }

  // 3. Trailing size token at the end of SKU or label:
  // e.g. "BT218-Cat-Blue_S", "KURTI-BLACK-XL", "Kurta Set M"
  const trailingMatch = text.match(/[_\-\s](xs|s|m|l|xl|xxl|2xl|3xl|xxxl|4xl|5xl|6xl)$/i)
  if (trailingMatch && trailingMatch[1]) {
    const key = trailingMatch[1].toLowerCase()
    if (STANDARD_SIZES[key]) return STANDARD_SIZES[key]
  }

  // 4. "Size: X" or "Size X" in product titles or labels
  const sizePrefixMatch = text.match(/\bsize[:\s\-]+([a-z0-9]+)\b/i)
  if (sizePrefixMatch && sizePrefixMatch[1]) {
    const key = sizePrefixMatch[1].toLowerCase()
    if (STANDARD_SIZES[key]) return STANDARD_SIZES[key]
  }

  return ""
}

// ---------------------------------------------------------------------------------------------------------------
// Return Reason Normalization Engine
// ---------------------------------------------------------------------------------------------------------------

/**
 * Normalizes marketplace raw return reason text to canonical root-cause categorization.
 * Handles single raw strings, compound/dot-separated sub-reasons (Meesho & Flipkart),
 * and provides robust keyword-based heuristics if unforeseen variations occur.
 */
export function normalizeReturnReason(marketplace: string, rawReason: string | null | undefined): CanonicalReasonInfo {
  if (!rawReason || !String(rawReason).trim() || String(rawReason).trim().toLowerCase() === "null" || String(rawReason).trim().toLowerCase() === "na") {
    return CANONICAL_REASONS.OTHER_UNKNOWN
  }

  const raw = String(rawReason).trim()
  const lower = raw.toLowerCase()

  // 1. Direct and composite phrase matching

  // SIZE ISSUES: TOO SMALL / TIGHT
  if (
    lower.includes("too small") ||
    lower.includes("too_small") ||
    lower.includes("smaller than expected") ||
    lower.includes("smaller_than_expected") ||
    lower.includes("too tight") ||
    lower.includes("size correct but too tight")
  ) {
    return CANONICAL_REASONS.SIZE_FIT_TOO_SMALL
  }

  // SIZE ISSUES: TOO LARGE / BIG / LOOSE
  if (
    lower.includes("too large") ||
    lower.includes("too_large") ||
    lower.includes("too big") ||
    lower.includes("larger than expected") ||
    lower.includes("larger_than_expected") ||
    lower.includes("too loose") ||
    lower.includes("size correct but too loose")
  ) {
    return CANONICAL_REASONS.SIZE_FIT_TOO_LARGE
  }

  // SIZE ISSUES: GENERAL FIT
  if (
    lower.includes("not like the fit") ||
    lower.includes("does not fit well") ||
    lower.includes("does_not_fit_well") ||
    lower.includes("item doesn't fit") ||
    lower.includes("item doesnt fit") ||
    lower.includes("size_fit_issues") ||
    lower.includes("size fit issues") ||
    lower.includes("size / fit related issues") ||
    lower.includes("fit related issues")
  ) {
    return CANONICAL_REASONS.SIZE_FIT_GENERAL
  }

  // SELLER FAULT: WRONG ITEM / MISSHIPMENT / WRONG COLOR / WRONG SIZE SENT
  if (
    lower.includes("different product") ||
    lower.includes("different_product") ||
    lower.includes("completely different product") ||
    lower.includes("different from what was ordered") ||
    lower.includes("different from website description") ||
    lower.includes("misshipment") ||
    lower.includes("delivered wrong size") ||
    lower.includes("delivered_wrong_size") ||
    lower.includes("wrong product") ||
    lower.includes("color is different") ||
    lower.includes("size is different") ||
    lower.includes("design is different")
  ) {
    return CANONICAL_REASONS.SELLER_FAULT_WRONG_ITEM
  }

  // SELLER FAULT: DEFECTIVE / DAMAGED PRODUCT / STAINS / TORN
  if (
    lower.includes("product was damaged") ||
    lower.includes("damaged_product") ||
    lower.includes("received_damaged") ||
    lower.includes("product was defective") ||
    lower.includes("defective product") ||
    lower.includes("received defective") ||
    lower.includes("received_defective") ||
    lower.includes("defective/does not work") ||
    lower.includes("stains") ||
    lower.includes("torn") ||
    lower.includes("dirty and had stains")
  ) {
    return CANONICAL_REASONS.SELLER_FAULT_DEFECTIVE
  }

  // SELLER FAULT: MISSING ITEM / INCOMPLETE / MISSING ACCESSORY
  if (
    lower.includes("missing parts") ||
    lower.includes("missing_item") ||
    lower.includes("incomplete product") ||
    lower.includes("missing quantity") ||
    lower.includes("missing accessory")
  ) {
    return CANONICAL_REASONS.SELLER_FAULT_MISSING_ITEM
  }

  // SELLER FAULT: QUALITY / FABRIC / IMAGE BETTER THAN PRODUCT
  if (
    lower.includes("poor quality") ||
    lower.includes("quality_issue") ||
    lower.includes("quality issue") ||
    lower.includes("not_happy_with_product_quality") ||
    lower.includes("performance or quality not adequate") ||
    lower.includes("performance is not good") ||
    lower.includes("other quality related issues") ||
    lower.includes("product image was better") ||
    lower.includes("product looked old") ||
    lower.includes("not as shown by photo") ||
    lower.includes("product_not_as_displayed")
  ) {
    return CANONICAL_REASONS.SELLER_FAULT_QUALITY
  }

  // LOGISTICS / COURIER / RTO / TRANSIT DAMAGE / DELAYED
  if (
    lower.includes("delivery was delayed") ||
    lower.includes("missed estimated delivery") ||
    lower.includes("damaged due to inappropriate packaging") ||
    lower.includes("damaged during shipping") ||
    lower.includes("damaged_shipment") ||
    lower.includes("primary packaging damaged") ||
    lower.includes("order_cancelled") ||
    lower.includes("shield_cancellation") ||
    lower.includes("cancelled_by_client") ||
    lower.includes("attempts_exhausted") ||
    lower.includes("obd_cancelled") ||
    lower.includes("not_serviceable") ||
    lower.includes("smart_pickup") ||
    lower.includes("client_instructions_for_rto") ||
    lower.includes("aged_beyond_limit") ||
    lower.includes("misroute") ||
    lower.includes("return to origin") ||
    lower.includes("shipment_eob_ageing") ||
    lower.includes("virtual_shipped") ||
    lower.includes("item never arrived") ||
    lower.includes("arrived in addition")
  ) {
    return CANONICAL_REASONS.LOGISTICS_COURIER_RTO
  }

  // CUSTOMER REMORSE / PREFERENCE / MIND CHANGED / FOUND BETTER PRICE
  if (
    lower.includes("do not need it anymore") ||
    lower.includes("don't need the product") ||
    lower.includes("no longer needed") ||
    lower.includes("longer needed") ||
    lower.includes("not needed/wanted") ||
    lower.includes("product_not_required") ||
    lower.includes("better price") ||
    lower.includes("customer_remorse") ||
    lower.includes("rejected_by_customer") ||
    lower.includes("customer rejection") ||
    lower.includes("refuse_to_accept") ||
    lower.includes("ordered_by_mistake") ||
    lower.includes("accidental order") ||
    lower.includes("did not like color") ||
    lower.includes("did_not_like_color") ||
    lower.includes("did not like the product") ||
    lower.includes("did_not_like_the_product") ||
    lower.includes("does_not_look_good") ||
    lower.includes("does not look good") ||
    lower.includes("style not as expected") ||
    lower.includes("want_to_change_style") ||
    lower.includes("orc_validated") ||
    lower.includes("orc validated") ||
    lower.includes("changed my mind") ||
    lower.includes("incompatible")
  ) {
    return CANONICAL_REASONS.CUSTOMER_REMORSE
  }

  return CANONICAL_REASONS.OTHER_UNKNOWN
}

// ---------------------------------------------------------------------------------------------------------------
// Database Sync / Backfill
// ---------------------------------------------------------------------------------------------------------------

/**
 * Backfills canonical_reason_code, is_seller_fault, is_size_issue, and detected_size
 * on existing expected_returns rows that haven't been categorized yet.
 * Safe, idempotent, non-blocking.
 */
export async function syncCanonicalReturnReasons(db: pg.Pool): Promise<{ backfilledRows: number }> {
  // Query rows missing canonical reason or size
  const rows = await db.query<{
    id: number
    marketplace: string
    return_reason: string | null
    product_title: string | null
    item_label: string | null
    channel_listing_id: string | null
  }>(`
    SELECT
      er.id,
      m.name AS marketplace,
      er.return_reason,
      er.product_title,
      eri.label AS item_label,
      eri.channel_listing_id
    FROM expected_returns er
    JOIN marketplaces m ON m.id = er.marketplace_id
    LEFT JOIN LATERAL (
      SELECT label, channel_listing_id
      FROM expected_return_items
      WHERE expected_return_id = er.id
      ORDER BY sort_order, id
      LIMIT 1
    ) eri ON true
    WHERE er.canonical_reason_code IS NULL OR er.detected_size IS NULL
    LIMIT 10000
  `)

  if (!rows.rows.length) return { backfilledRows: 0 }

  let updated = 0
  for (const row of rows.rows) {
    const canonical = normalizeReturnReason(row.marketplace, row.return_reason)
    const detectedSize =
      extractGarmentSize(row.channel_listing_id) ||
      extractGarmentSize(row.item_label) ||
      extractGarmentSize(row.product_title) ||
      null

    await db.query(
      `
      UPDATE expected_returns
      SET
        canonical_reason_code = $1,
        is_seller_fault = $2,
        is_size_issue = $3,
        detected_size = COALESCE(detected_size, $4)
      WHERE id = $5
      `,
      [canonical.categoryCode, canonical.isSellerFault, canonical.isSizeIssue, detectedSize, row.id],
    )
    updated++
  }

  return { backfilledRows: updated }
}

// ---------------------------------------------------------------------------------------------------------------
// Analytics Types & Queries
// ---------------------------------------------------------------------------------------------------------------

export type ReasonCategorySummary = {
  categoryCode: string
  label: string
  department: string
  isSellerFault: boolean
  isSizeIssue: boolean
  severity: string
  count: number
  percentage: string
  actionRecommendation: string
}

export type MarketplaceReasonSlice = {
  marketplace: string
  totalReturns: number
  sellerFaultCount: number
  sellerFaultPct: string
  sizeIssueCount: number
  sizeIssuePct: string
  customerRemorseCount: number
}

export type WeeklyReasonSummary = {
  totalReturns: number
  sellerFaultCount: number
  sellerFaultPct: string
  sizeIssueCount: number
  sizeIssuePct: string
  customerRemorseCount: number
  customerRemorsePct: string
  logisticsRtoCount: number
  logisticsRtoPct: string
  otherCount: number
  categories: ReasonCategorySummary[]
  marketplaces: MarketplaceReasonSlice[]
}

export type SellerFaultSkuEntry = {
  productSku: string
  productTitle: string
  sellerFaultCount: number
  totalReturnCount: number
  faultRatePct: string
  primaryDefect: string
  breakdown: {
    defective: number
    wrongItem: number
    missingItem: number
    poorQuality: number
  }
  marketplaces: string[]
  sampleOrderNumbers: string[]
  severity: "critical" | "high" | "medium"
  recommendation: string
}

export type GarmentSizeDigestEntry = {
  productSku: string
  productTitle: string
  totalSizeReturns: number
  sizeCounts: Record<string, number>
  tooSmallCount: number
  tooSmallPct: string
  tooLargeCount: number
  tooLargePct: string
  generalFitCount: number
  generalFitPct: string
  primaryProblematicSize: string
  actionableRecommendation: string
}

/**
 * Fetches the return reasons overview for the given account scope and optional date window.
 * Strictly adheres to Rule 1 (Account scope on every data route).
 */
export async function getWeeklyReasonSummary(
  db: pg.Pool,
  scope: AccountScope,
  dateFrom?: string,
  dateTo?: string,
): Promise<WeeklyReasonSummary> {
  const params: unknown[] = []
  const mktCond = accountCondition(scope, "er.marketplace_id", params)

  let dateCond = ""
  if (dateFrom && dateTo) {
    params.push(dateFrom, dateTo)
    dateCond = `AND er.created_at::date >= $${params.length - 1} AND er.created_at::date <= $${params.length}`
  }

  // 1. Overall and category aggregations
  const catRes = await db.query<{
    category_code: string
    count: number
  }>(
    `
    SELECT
      COALESCE(er.canonical_reason_code, 'OTHER_UNKNOWN') AS category_code,
      COUNT(*)::int AS count
    FROM expected_returns er
    WHERE ${mktCond} ${dateCond}
    GROUP BY COALESCE(er.canonical_reason_code, 'OTHER_UNKNOWN')
    ORDER BY count DESC
    `,
    params,
  )

  let totalReturns = 0
  const countMap: Record<string, number> = {}
  for (const r of catRes.rows) {
    countMap[r.category_code] = r.count
    totalReturns += r.count
  }

  let sellerFaultCount = 0
  let sizeIssueCount = 0
  let customerRemorseCount = countMap["CUSTOMER_REMORSE"] || 0
  let logisticsRtoCount = countMap["LOGISTICS_COURIER_RTO"] || 0
  let otherCount = countMap["OTHER_UNKNOWN"] || 0

  const categories: ReasonCategorySummary[] = Object.values(CANONICAL_REASONS).map((def) => {
    const cnt = countMap[def.categoryCode] || 0
    if (def.isSellerFault) sellerFaultCount += cnt
    if (def.isSizeIssue) sizeIssueCount += cnt
    const pct = totalReturns > 0 ? ((cnt / totalReturns) * 100).toFixed(1) + "%" : "0.0%"
    return {
      categoryCode: def.categoryCode,
      label: def.label,
      department: def.department,
      isSellerFault: def.isSellerFault,
      isSizeIssue: def.isSizeIssue,
      severity: def.severity,
      count: cnt,
      percentage: pct,
      actionRecommendation: def.actionRecommendation,
    }
  })

  // Sort categories by count descending
  categories.sort((a, b) => b.count - a.count)

  // 2. Marketplace breakdown
  const mktParams = [...params]
  const mktRes = await db.query<{
    marketplace: string
    total_returns: number
    seller_fault_count: number
    size_issue_count: number
    remorse_count: number
  }>(
    `
    SELECT
      m.name AS marketplace,
      COUNT(*)::int AS total_returns,
      COUNT(*) FILTER (WHERE er.is_seller_fault = true)::int AS seller_fault_count,
      COUNT(*) FILTER (WHERE er.is_size_issue = true)::int AS size_issue_count,
      COUNT(*) FILTER (WHERE er.canonical_reason_code = 'CUSTOMER_REMORSE')::int AS remorse_count
    FROM expected_returns er
    JOIN marketplaces m ON m.id = er.marketplace_id
    WHERE ${mktCond} ${dateCond}
    GROUP BY m.name
    ORDER BY total_returns DESC
    `,
    mktParams,
  )

  const marketplaces: MarketplaceReasonSlice[] = mktRes.rows.map((row) => ({
    marketplace: row.marketplace,
    totalReturns: row.total_returns,
    sellerFaultCount: row.seller_fault_count,
    sellerFaultPct:
      row.total_returns > 0 ? ((row.seller_fault_count / row.total_returns) * 100).toFixed(1) + "%" : "0.0%",
    sizeIssueCount: row.size_issue_count,
    sizeIssuePct:
      row.total_returns > 0 ? ((row.size_issue_count / row.total_returns) * 100).toFixed(1) + "%" : "0.0%",
    customerRemorseCount: row.remorse_count,
  }))

  return {
    totalReturns,
    sellerFaultCount,
    sellerFaultPct: totalReturns > 0 ? ((sellerFaultCount / totalReturns) * 100).toFixed(1) + "%" : "0.0%",
    sizeIssueCount,
    sizeIssuePct: totalReturns > 0 ? ((sizeIssueCount / totalReturns) * 100).toFixed(1) + "%" : "0.0%",
    customerRemorseCount,
    customerRemorsePct: totalReturns > 0 ? ((customerRemorseCount / totalReturns) * 100).toFixed(1) + "%" : "0.0%",
    logisticsRtoCount,
    logisticsRtoPct: totalReturns > 0 ? ((logisticsRtoCount / totalReturns) * 100).toFixed(1) + "%" : "0.0%",
    otherCount,
    categories,
    marketplaces,
  }
}

/**
 * Top SKUs driving Seller Fault returns (Defects, Wrong item delivered, Missing pieces, Finishing issues).
 * Gives executive attention to internal factory/warehouse mistakes so corrective action is taken immediately.
 */
export async function getTopSellerFaultSKUs(
  db: pg.Pool,
  scope: AccountScope,
  dateFrom?: string,
  dateTo?: string,
  limit = 15,
): Promise<SellerFaultSkuEntry[]> {
  const params: unknown[] = []
  const mktCond = accountCondition(scope, "er.marketplace_id", params)

  let dateCond = ""
  if (dateFrom && dateTo) {
    params.push(dateFrom, dateTo)
    dateCond = `AND er.created_at::date >= $${params.length - 1} AND er.created_at::date <= $${params.length}`
  }

  params.push(limit)
  const limitParam = `$${params.length}`

  const query = `
    WITH item_sku AS (
      SELECT
        er.id AS return_id,
        COALESCE(NULLIF(pm.master_sku, ''), NULLIF(s.code, ''), 'UNKNOWN-SKU') AS master_sku,
        COALESCE(NULLIF(s.name, ''), NULLIF(er.product_title, ''), 'Product') AS title,
        er.canonical_reason_code,
        er.is_seller_fault,
        m.name AS marketplace,
        er.order_number
      FROM expected_returns er
      JOIN marketplaces m ON m.id = er.marketplace_id
      LEFT JOIN LATERAL (
        SELECT eri.sku_id, eri.channel_listing_id
        FROM expected_return_items eri
        WHERE eri.expected_return_id = er.id
        ORDER BY eri.sort_order, eri.id
        LIMIT 1
      ) first_item ON true
      LEFT JOIN skus s ON s.id = first_item.sku_id
      LEFT JOIN product_master pm ON pm.listing_sku = first_item.channel_listing_id
      WHERE ${mktCond} ${dateCond}
    )
    SELECT
      master_sku,
      title,
      COUNT(*) FILTER (WHERE is_seller_fault = true)::int AS seller_faults,
      COUNT(*)::int AS total_returns,
      COUNT(*) FILTER (WHERE canonical_reason_code = 'SELLER_FAULT_DEFECTIVE')::int AS defective_count,
      COUNT(*) FILTER (WHERE canonical_reason_code = 'SELLER_FAULT_WRONG_ITEM')::int AS wrong_item_count,
      COUNT(*) FILTER (WHERE canonical_reason_code = 'SELLER_FAULT_MISSING_ITEM')::int AS missing_count,
      COUNT(*) FILTER (WHERE canonical_reason_code = 'SELLER_FAULT_QUALITY')::int AS quality_count,
      ARRAY_AGG(DISTINCT marketplace) AS marketplaces,
      (ARRAY_AGG(order_number) FILTER (WHERE is_seller_fault = true))[1:3] AS sample_orders
    FROM item_sku
    GROUP BY master_sku, title
    HAVING COUNT(*) FILTER (WHERE is_seller_fault = true) > 0
    ORDER BY seller_faults DESC, total_returns DESC
    LIMIT ${limitParam}
  `

  const res = await db.query<{
    master_sku: string
    title: string
    seller_faults: number
    total_returns: number
    defective_count: number
    wrong_item_count: number
    missing_count: number
    quality_count: number
    marketplaces: string[]
    sample_orders: string[]
  }>(query, params)

  return res.rows.map((row) => {
    // Determine primary defect
    let primary = "Defective Product"
    const maxVal = Math.max(row.defective_count, row.wrong_item_count, row.missing_count, row.quality_count)
    if (maxVal === row.wrong_item_count) primary = "Wrong Item Sent"
    else if (maxVal === row.missing_count) primary = "Missing Accessory"
    else if (maxVal === row.quality_count) primary = "Quality / Finishing Discrepancy"

    let severity: "critical" | "high" | "medium" = "medium"
    if (row.wrong_item_count > 0 || row.seller_faults >= 5) severity = "critical"
    else if (row.defective_count > 0) severity = "high"

    let recommendation = "Review production quality check."
    if (primary === "Wrong Item Sent") {
      recommendation = "Packing audit: verify barcode scan matches product SKU tag at warehouse packaging station."
    } else if (primary === "Defective Product") {
      recommendation = "Manufacturing alert: inspect batch stitching & fabric cuts for damage before shipment."
    } else if (primary === "Missing Accessory") {
      recommendation = "Secondary packaging check: enforce dupatta/set contents verification before sealing polybag."
    }

    const faultRate = row.total_returns > 0 ? ((row.seller_faults / row.total_returns) * 100).toFixed(1) + "%" : "0.0%"

    return {
      productSku: row.master_sku,
      productTitle: row.title,
      sellerFaultCount: row.seller_faults,
      totalReturnCount: row.total_returns,
      faultRatePct: faultRate,
      primaryDefect: primary,
      breakdown: {
        defective: row.defective_count,
        wrongItem: row.wrong_item_count,
        missingItem: row.missing_count,
        poorQuality: row.quality_count,
      },
      marketplaces: row.marketplaces || [],
      sampleOrderNumbers: row.sample_orders || [],
      severity,
      recommendation,
    }
  })
}

/**
 * Garment Sizing Digest: Grouped by Product SKU and Size.
 * Calculates Too Small % vs Too Large % and provides automated pattern-making recommendations.
 */
export async function getGarmentSizeDigest(
  db: pg.Pool,
  scope: AccountScope,
  dateFrom?: string,
  dateTo?: string,
  limit = 20,
): Promise<GarmentSizeDigestEntry[]> {
  const params: unknown[] = []
  const mktCond = accountCondition(scope, "er.marketplace_id", params)

  let dateCond = ""
  if (dateFrom && dateTo) {
    params.push(dateFrom, dateTo)
    dateCond = `AND er.created_at::date >= $${params.length - 1} AND er.created_at::date <= $${params.length}`
  }

  params.push(limit)
  const limitParam = `$${params.length}`

  const query = `
    WITH size_returns AS (
      SELECT
        er.id,
        COALESCE(NULLIF(pm.master_sku, ''), NULLIF(s.code, ''), 'UNKNOWN-SKU') AS master_sku,
        COALESCE(NULLIF(s.name, ''), NULLIF(er.product_title, ''), 'Product') AS title,
        COALESCE(NULLIF(er.detected_size, ''), 'Unknown') AS size_label,
        er.canonical_reason_code
      FROM expected_returns er
      LEFT JOIN LATERAL (
        SELECT eri.sku_id, eri.channel_listing_id
        FROM expected_return_items eri
        WHERE eri.expected_return_id = er.id
        ORDER BY eri.sort_order, eri.id
        LIMIT 1
      ) first_item ON true
      LEFT JOIN skus s ON s.id = first_item.sku_id
      LEFT JOIN product_master pm ON pm.listing_sku = first_item.channel_listing_id
      WHERE er.is_size_issue = true AND ${mktCond} ${dateCond}
    )
    SELECT
      master_sku,
      title,
      COUNT(*)::int AS total_size_returns,
      COUNT(*) FILTER (WHERE canonical_reason_code = 'SIZE_FIT_TOO_SMALL')::int AS too_small_count,
      COUNT(*) FILTER (WHERE canonical_reason_code = 'SIZE_FIT_TOO_LARGE')::int AS too_large_count,
      COUNT(*) FILTER (WHERE canonical_reason_code = 'SIZE_FIT_GENERAL')::int AS general_fit_count,
      jsonb_object_agg(size_label, size_cnt) AS size_breakdown
    FROM (
      SELECT
        master_sku,
        title,
        size_label,
        COUNT(*)::int AS size_cnt,
        canonical_reason_code
      FROM size_returns
      GROUP BY master_sku, title, size_label, canonical_reason_code
    ) grouped_sub
    GROUP BY master_sku, title
    ORDER BY total_size_returns DESC
    LIMIT ${limitParam}
  `

  const res = await db.query<{
    master_sku: string
    title: string
    total_size_returns: number
    too_small_count: number
    too_large_count: number
    general_fit_count: number
    size_breakdown: Record<string, number>
  }>(query, params)

  return res.rows.map((row) => {
    const total = row.total_size_returns
    const tooSmallPctNum = total > 0 ? (row.too_small_count / total) * 100 : 0
    const tooLargePctNum = total > 0 ? (row.too_large_count / total) * 100 : 0
    const generalFitPctNum = total > 0 ? (row.general_fit_count / total) * 100 : 0

    // Find the most returned size
    let topSize = "All Sizes"
    let maxCnt = 0
    const sizeCounts: Record<string, number> = row.size_breakdown || {}
    for (const [sz, cnt] of Object.entries(sizeCounts)) {
      if (sz !== "Unknown" && cnt > maxCnt) {
        maxCnt = cnt
        topSize = sz
      }
    }

    let actionableRecommendation = "Monitor fit feedback."
    if (tooSmallPctNum >= 50) {
      actionableRecommendation = `Garment runs small (${tooSmallPctNum.toFixed(0)}% too small). Pattern team: increase bust/waist ease by +0.75" to +1.0" or recommend sizing up on marketplace size chart.`
    } else if (tooLargePctNum >= 50) {
      actionableRecommendation = `Garment runs large (${tooLargePctNum.toFixed(0)}% too big). Pattern team: reduce ease grading by -0.75" or advise customers to select one size smaller.`
    } else {
      actionableRecommendation = `General fit discrepancy. Review cut & silhouette across sizes ${topSize !== "All Sizes" ? "(especially Size " + topSize + ")" : ""}.`
    }

    return {
      productSku: row.master_sku,
      productTitle: row.title,
      totalSizeReturns: total,
      sizeCounts,
      tooSmallCount: row.too_small_count,
      tooSmallPct: tooSmallPctNum.toFixed(1) + "%",
      tooLargeCount: row.too_large_count,
      tooLargePct: tooLargePctNum.toFixed(1) + "%",
      generalFitCount: row.general_fit_count,
      generalFitPct: generalFitPctNum.toFixed(1) + "%",
      primaryProblematicSize: topSize,
      actionableRecommendation,
    }
  })
}
