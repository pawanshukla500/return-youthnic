// Return Tracking Engine: Lifecycle monitoring, physical scan reconciliation,
// and Myntra SPF Policy v5.1 claim eligibility automation.
//
// Rule 1: Every query reading or updating return tracking data enforces allowed marketplace IDs.

import type pg from "pg"

export type Queryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>
}

function toIsoDateString(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString().slice(0, 10)
  const s = String(val)
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function toIsoString(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  const d = new Date(String(val))
  return isNaN(d.getTime()) ? null : d.toISOString()
}

export type ReturnTrackingRecord = {
  id: number
  marketplaceId: number
  marketplaceName: string
  sellerId: string
  orderId: string
  orderLineId: string
  sellerOrderId: string
  returnId: string
  trackingId: string
  forwardTrackingNumber: string
  returnTrackingNumber: string
  returnType: "Return" | "RTO"
  portalStatus: string
  portalSubStatus: string
  returnReason: string
  orderCreatedDate: string | null
  returnCreatedDate: string | null
  orderRtoDate: string | null
  effectiveReturnDate: string
  portalDeliveryDate: string | null
  sku: string
  myntraSkuCode: string
  quantity: number
  model: string
  warehouseId: string
  isPhysicallyReceived: boolean
  physicalScanId: number | null
  physicalScannedAt: string | null
  physicalOutcome: string
  claimEligibilityStatus: ClaimEligibilityStatus
  claimFilingDeadline: string | null
  claimId: number | null
  claimTicketCode: string
  ageDays: number
  daysRemaining: number | null
  isFalseDelivery: boolean
  createdAt: string
  updatedAt: string
}

export type ClaimEligibilityStatus =
  | "transit" // < 60 days, in transit, not yet eligible
  | "eligible_rnr" // 60 - 120 days, undelivered, eligible for RNR SPF claim
  | "expiring_soon" // 100 - 120 days, undelivered, urgent claim window expiring
  | "expired_unclaimed" // > 120 days, undelivered, 120d SLA window expired
  | "delayed_rts_eligible" // Delivered after >120 days, within 7-day claim window
  | "delayed_rts_expired" // Delivered after >120 days, but >7 days elapsed
  | "delivered_normal" // Physically received within 120 days
  | "claim_filed" // SPF claim raised / ticket pending
  | "claim_approved" // SPF claim approved
  | "claim_rejected" // SPF claim rejected

export type ReturnTrackingFilters = {
  marketplaceId?: string | number
  status?: string
  search?: string
  returnType?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  limit?: number
  sortKey?: string
  sortDir?: "asc" | "desc"
}

export type ReturnTrackingSummary = {
  totalTracked: number
  inTransit: number
  eligibleRnr: number
  expiringSoon: number
  expiredUnclaimed: number
  delayedRtsEligible: number
  delayedRtsExpired: number
  physicallyReceived: number
  falseDeliveryDiscrepancies: number
  claimsFiled: number
}

export type ReturnTrackingInput = {
  sellerId: string
  orderId: string
  orderLineId?: string
  sellerOrderId?: string
  returnId?: string
  trackingId?: string
  forwardTrackingNumber?: string
  returnTrackingNumber?: string
  returnType: "Return" | "RTO"
  portalStatus?: string
  portalSubStatus?: string
  returnReason?: string
  orderCreatedDate?: string | null
  returnCreatedDate?: string | null
  orderRtoDate?: string | null
  portalDeliveryDate?: string | null
  sku?: string
  myntraSkuCode?: string
  quantity?: number
  model?: string
  warehouseId?: string
  rawData?: Record<string, unknown>
}

// Helper: difference in calendar days between two ISO date strings or Date objects (d2 - d1)
export function daysBetween(date1: string | Date, date2: string | Date): number {
  const d1 = new Date(typeof date1 === "string" ? date1.slice(0, 10) : date1.toISOString().slice(0, 10))
  const d2 = new Date(typeof date2 === "string" ? date2.slice(0, 10) : date2.toISOString().slice(0, 10))
  const diffTime = d2.getTime() - d1.getTime()
  return Math.floor(diffTime / (1000 * 60 * 60 * 24))
}

export function addDaysIso(dateStr: string, days: number): string {
  const d = new Date(dateStr.slice(0, 10))
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function cleanDateStr(val?: string | null): string | null {
  if (!val) return null
  const s = val.trim()
  if (!s || s === "1970-01-01" || s.startsWith("0000")) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return null
}

// Determines the official baseline initiation date per Myntra Policy
export function calculateReturnDates(row: {
  type?: string
  return_created_date?: string | null
  order_rto_date?: string | null
  order_created_date?: string | null
}): { effectiveReturnDate: string; returnCreatedDate: string | null; orderRtoDate: string | null } {
  const isRto = String(row.type || "").toUpperCase() === "RTO"
  const retCreated = cleanDateStr(row.return_created_date)
  const orderRto = cleanDateStr(row.order_rto_date)
  const orderCreated = cleanDateStr(row.order_created_date)

  let effectiveReturnDate = ""
  if (isRto) {
    effectiveReturnDate = orderRto || retCreated || orderCreated || new Date().toISOString().slice(0, 10)
  } else {
    effectiveReturnDate = retCreated || orderRto || orderCreated || new Date().toISOString().slice(0, 10)
  }

  return {
    effectiveReturnDate,
    returnCreatedDate: retCreated,
    orderRtoDate: orderRto,
  }
}

// Calculates claim eligibility according to Myntra Seller Protection Fund Policy v5.1
export function computeClaimAging(
  record: {
    effectiveReturnDate: string
    isPhysicallyReceived: boolean
    physicalScannedAt?: string | Date | null
    portalDeliveryDate?: string | Date | null
    portalStatus?: string
    claimId?: number | null
    claimTicketCode?: string | null
  },
  referenceDate: Date = new Date(),
): {
  status: ClaimEligibilityStatus
  ageDays: number
  daysRemaining: number | null
  filingDeadline: string | null
} {
  const refIso = referenceDate.toISOString().slice(0, 10)
  const ageDays = daysBetween(record.effectiveReturnDate, refIso)

  // If a claim has already been filed or resolved
  if (record.claimTicketCode || record.claimId) {
    return {
      status: "claim_filed",
      ageDays,
      daysRemaining: null,
      filingDeadline: null,
    }
  }

  // Case A: Package physically arrived at the warehouse
  if (record.isPhysicallyReceived) {
    const deliveryDateStr = record.physicalScannedAt
      ? typeof record.physicalScannedAt === "string"
        ? record.physicalScannedAt.slice(0, 10)
        : record.physicalScannedAt.toISOString().slice(0, 10)
      : record.portalDeliveryDate
        ? typeof record.portalDeliveryDate === "string"
          ? record.portalDeliveryDate.slice(0, 10)
          : record.portalDeliveryDate.toISOString().slice(0, 10)
        : null

    if (deliveryDateStr) {
      const delayDays = daysBetween(record.effectiveReturnDate, deliveryDateStr)
      if (delayDays > 120) {
        // Annexure 1, Item 2: Delayed RTS/RTO Deliveries (>120 days). Window is 7 days from delivery date!
        const daysSinceDelivery = daysBetween(deliveryDateStr, refIso)
        const deadline = addDaysIso(deliveryDateStr, 7)
        if (daysSinceDelivery <= 7) {
          return {
            status: "delayed_rts_eligible",
            ageDays,
            daysRemaining: Math.max(0, 7 - daysSinceDelivery),
            filingDeadline: deadline,
          }
        }
        return {
          status: "delayed_rts_expired",
          ageDays,
          daysRemaining: 0,
          filingDeadline: deadline,
        }
      }
    }
    return {
      status: "delivered_normal",
      ageDays,
      daysRemaining: null,
      filingDeadline: null,
    }
  }

  // Case B: Package NOT physically received at the warehouse
  // Annexure 1, Item 8: Undelivered Shipments (RTS/RTO/Lost/Canceled)
  // Raise tickets under 'SPF' tab between 60 to 120 days from return/RTO/lost/canceled creation date.
  const claimDeadline = addDaysIso(record.effectiveReturnDate, 120)
  const daysUntil120 = 120 - ageDays

  if (ageDays < 60) {
    // Normal in-transit window
    return {
      status: "transit",
      ageDays,
      daysRemaining: 60 - ageDays, // days until claim eligibility opens
      filingDeadline: claimDeadline,
    }
  }

  if (ageDays >= 60 && ageDays < 100) {
    // Eligible for RNR SPF Claim
    return {
      status: "eligible_rnr",
      ageDays,
      daysRemaining: daysUntil120, // days remaining before window closes at 120d
      filingDeadline: claimDeadline,
    }
  }

  if (ageDays >= 100 && ageDays <= 120) {
    // Urgent: Claim window expiring soon
    return {
      status: "expiring_soon",
      ageDays,
      daysRemaining: Math.max(0, daysUntil120),
      filingDeadline: claimDeadline,
    }
  }

  // ageDays > 120
  return {
    status: "expired_unclaimed",
    ageDays,
    daysRemaining: 0,
    filingDeadline: claimDeadline,
  }
}

// Parses raw CSV lines handling quoted fields correctly
export function parseCsvRows(content: string): string[][] {
  const lines: string[][] = []
  let currentRow: string[] = []
  let currentField = ""
  let inQuotes = false

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    const nextCh = content[i + 1]

    if (inQuotes) {
      if (ch === '"') {
        if (nextCh === '"') {
          currentField += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        currentField += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ",") {
        currentRow.push(currentField.trim())
        currentField = ""
      } else if (ch === "\r") {
        if (nextCh === "\n") i++
        currentRow.push(currentField.trim())
        if (currentRow.some((f) => f.length > 0)) lines.push(currentRow)
        currentRow = []
        currentField = ""
      } else if (ch === "\n") {
        currentRow.push(currentField.trim())
        if (currentRow.some((f) => f.length > 0)) lines.push(currentRow)
        currentRow = []
        currentField = ""
      } else {
        currentField += ch
      }
    }
  }

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim())
    if (currentRow.some((f) => f.length > 0)) lines.push(currentRow)
  }

  return lines
}

// Parse Myntra Returns Report CSV into structured ReturnTrackingInput
export function parseMyntraReturnsCsv(content: string): {
  records: ReturnTrackingInput[]
  detectedSellerId: string
  warnings: string[]
} {
  const rows = parseCsvRows(content)
  if (!rows.length) return { records: [], detectedSellerId: "", warnings: ["File is empty"] }

  const headers = rows[0].map((h) => h.toLowerCase().replace(/[\s-]+/g, "_").replace(/^"|"$/g, ""))
  const colIndex = (name: string): number => headers.indexOf(name)

  const sellerIdx = colIndex("seller_id")
  const orderIdx = colIndex("order_id")
  const orderLineIdx = colIndex("order_line_id")
  const sellerOrderIdx = colIndex("seller_order_id")
  const returnIdx = colIndex("return_id")
  const typeIdx = colIndex("type")
  const statusIdx = colIndex("status")
  const retStatusIdx = colIndex("return_status")
  const returnTrackingIdx = colIndex("return_tracking_number")
  const forwardTrackingIdx = colIndex("forward_tracking_number")
  const skuIdx = colIndex("seller_sku_code")
  const myntraSkuIdx = colIndex("myntra_sku_code")
  const qtyIdx = colIndex("quantity")
  const reasonIdx = colIndex("return_reason")
  const orderCreatedIdx = colIndex("order_created_date")
  const returnCreatedIdx = colIndex("return_created_date")
  const orderRtoIdx = colIndex("order_rto_date")
  const lmdoDateIdx = colIndex("lmdo_last_modified_on")
  const modelIdx = colIndex("model")
  const whIdx = colIndex("warehouse_id")

  if (orderIdx < 0 && returnTrackingIdx < 0 && forwardTrackingIdx < 0) {
    return {
      records: [],
      detectedSellerId: "",
      warnings: ["File does not have required return report columns (order_id or tracking numbers)"],
    }
  }

  let detectedSellerId = ""
  const records: ReturnTrackingInput[] = []
  const warnings: string[] = []

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || !row.length) continue

    const sellerId = sellerIdx >= 0 ? row[sellerIdx] : ""
    if (sellerId && !detectedSellerId) detectedSellerId = sellerId

    const orderId = orderIdx >= 0 ? row[orderIdx] : ""
    const orderLineId = orderLineIdx >= 0 ? row[orderLineIdx] : ""
    const returnTrk = returnTrackingIdx >= 0 ? row[returnTrackingIdx].toUpperCase() : ""
    const forwardTrk = forwardTrackingIdx >= 0 ? row[forwardTrackingIdx].toUpperCase() : ""
    const trackingId = returnTrk || forwardTrk || orderId

    if (!trackingId && !orderId) {
      warnings.push(`Line ${r + 1}: Skipped row with missing order ID and tracking ID`)
      continue
    }

    const typeRaw = typeIdx >= 0 ? row[typeIdx] : "Return"
    const returnType: "Return" | "RTO" = typeRaw.toUpperCase().includes("RTO") ? "RTO" : "Return"

    const status = statusIdx >= 0 ? row[statusIdx] : ""
    const returnStatus = retStatusIdx >= 0 ? row[retStatusIdx] : ""
    const reason = reasonIdx >= 0 ? row[reasonIdx] : ""
    const orderCreated = orderCreatedIdx >= 0 ? cleanDateStr(row[orderCreatedIdx]) : null
    const returnCreated = returnCreatedIdx >= 0 ? cleanDateStr(row[returnCreatedIdx]) : null
    const orderRto = orderRtoIdx >= 0 ? cleanDateStr(row[orderRtoIdx]) : null
    const lmdoDate = lmdoDateIdx >= 0 ? cleanDateStr(row[lmdoDateIdx]) : null
    const sku = skuIdx >= 0 ? row[skuIdx] : ""
    const myntraSku = myntraSkuIdx >= 0 ? row[myntraSkuIdx] : ""
    const qty = qtyIdx >= 0 ? parseInt(row[qtyIdx], 10) || 1 : 1
    const model = modelIdx >= 0 ? row[modelIdx] : "PPMP"
    const warehouseId = whIdx >= 0 ? row[whIdx] : ""
    const sellerOrderId = sellerOrderIdx >= 0 ? row[sellerOrderIdx] : ""
    const returnId = returnIdx >= 0 ? row[returnIdx] : ""

    records.push({
      sellerId,
      orderId,
      orderLineId,
      sellerOrderId,
      returnId,
      trackingId,
      forwardTrackingNumber: forwardTrk,
      returnTrackingNumber: returnTrk,
      returnType,
      portalStatus: status,
      portalSubStatus: returnStatus,
      returnReason: reason,
      orderCreatedDate: orderCreated,
      returnCreatedDate: returnCreated,
      orderRtoDate: orderRto,
      portalDeliveryDate: lmdoDate,
      sku,
      myntraSkuCode: myntraSku,
      quantity: qty > 0 ? qty : 1,
      model,
      warehouseId,
      rawData: {
        rawStatus: status,
        rawSubStatus: returnStatus,
        rawReason: reason,
        lmdoDate,
      },
    })
  }

  return { records, detectedSellerId, warnings }
}

// Ingests return tracking inputs into the database with scan reconciliation
export async function ingestReturnTrackingRecords(
  db: pg.Pool,
  marketplaceId: number,
  records: ReturnTrackingInput[],
  uploadBatchId?: number | null,
): Promise<{
  inserted: number
  updated: number
  matchedScans: number
  summary: ReturnTrackingSummary
}> {
  if (!records.length) {
    return {
      inserted: 0,
      updated: 0,
      matchedScans: 0,
      summary: {
        totalTracked: 0,
        inTransit: 0,
        eligibleRnr: 0,
        expiringSoon: 0,
        expiredUnclaimed: 0,
        delayedRtsEligible: 0,
        delayedRtsExpired: 0,
        physicallyReceived: 0,
        falseDeliveryDiscrepancies: 0,
        claimsFiled: 0,
      },
    }
  }

  // 1. Fetch physical warehouse scans that match any tracking IDs or order numbers
  const trackingLookup = new Set<string>()
  const orderLookup = new Set<string>()
  for (const r of records) {
    if (r.trackingId) trackingLookup.add(r.trackingId)
    if (r.returnTrackingNumber) trackingLookup.add(r.returnTrackingNumber)
    if (r.forwardTrackingNumber) trackingLookup.add(r.forwardTrackingNumber)
    if (r.orderId) orderLookup.add(r.orderId)
  }

  const scanQuery = `
    SELECT
      rs.id AS scan_id,
      rs.scanned_at,
      rs.scanned_by,
      rs.outcome,
      rs.status AS scan_status,
      rs.tracking_id_snapshot,
      rs.order_number_snapshot,
      er.tracking_id AS er_tracking_id,
      er.alt_tracking_id AS er_alt_tracking_id,
      er.order_number AS er_order_number
    FROM receipt_scans rs
    LEFT JOIN expected_returns er ON er.id = rs.expected_return_id
    WHERE rs.tracking_id_snapshot = ANY($1::text[])
       OR rs.order_number_snapshot = ANY($2::text[])
       OR er.tracking_id = ANY($1::text[])
       OR er.alt_tracking_id = ANY($1::text[])
       OR er.order_number = ANY($2::text[])
  `

  const scanMatches = await db.query(scanQuery, [[...trackingLookup], [...orderLookup]])

  type ScanMatchInfo = {
    scanId: number
    scannedAt: Date
    scannedBy: number
    outcome: string
  }
  const scanByTracking = new Map<string, ScanMatchInfo>()
  const scanByOrder = new Map<string, ScanMatchInfo>()

  for (const s of scanMatches.rows) {
    const info: ScanMatchInfo = {
      scanId: s.scan_id,
      scannedAt: s.scanned_at,
      scannedBy: s.scanned_by,
      outcome: s.outcome || "clear",
    }
    if (s.tracking_id_snapshot) scanByTracking.set(s.tracking_id_snapshot.toUpperCase(), info)
    if (s.er_tracking_id) scanByTracking.set(s.er_tracking_id.toUpperCase(), info)
    if (s.er_alt_tracking_id) scanByTracking.set(s.er_alt_tracking_id.toUpperCase(), info)
    if (s.order_number_snapshot) scanByOrder.set(s.order_number_snapshot, info)
    if (s.er_order_number) scanByOrder.set(s.er_order_number, info)
  }

  // 2. Batch UPSERT into return_tracking_records
  let insertedCount = 0
  let matchedScansCount = 0
  const today = new Date()

  // Chunk in batches of 500
  const CHUNK_SIZE = 500
  for (let c = 0; c < records.length; c += CHUNK_SIZE) {
    const chunk = records.slice(c, c + CHUNK_SIZE)

    const valuesSql: string[] = []
    const params: unknown[] = [marketplaceId]
    let paramIndex = 2

    for (const r of chunk) {
      const dates = calculateReturnDates({
        type: r.returnType,
        return_created_date: r.returnCreatedDate,
        order_rto_date: r.orderRtoDate,
        order_created_date: r.orderCreatedDate,
      })

      // Check physical scan match
      const matchedScan =
        scanByTracking.get((r.returnTrackingNumber || "").toUpperCase()) ||
        scanByTracking.get((r.trackingId || "").toUpperCase()) ||
        scanByTracking.get((r.forwardTrackingNumber || "").toUpperCase()) ||
        scanByOrder.get(r.orderId)

      const isPhysicallyReceived = Boolean(matchedScan)
      if (isPhysicallyReceived) matchedScansCount++

      const aging = computeClaimAging(
        {
          effectiveReturnDate: dates.effectiveReturnDate,
          isPhysicallyReceived,
          physicalScannedAt: matchedScan?.scannedAt,
          portalDeliveryDate: r.portalDeliveryDate,
          portalStatus: r.portalStatus,
        },
        today,
      )

      valuesSql.push(`(
        $1,
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}
      )`)

      params.push(
        r.sellerId || "",
        r.orderId,
        r.orderLineId || "",
        r.sellerOrderId || "",
        r.returnId || "",
        r.trackingId,
        r.forwardTrackingNumber || "",
        r.returnTrackingNumber || "",
        r.returnType,
        r.portalStatus || "",
        r.portalSubStatus || "",
        r.returnReason || "",
        r.orderCreatedDate || null,
        dates.returnCreatedDate,
        dates.orderRtoDate,
        dates.effectiveReturnDate,
        r.portalDeliveryDate || null,
        r.sku || "",
        r.myntraSkuCode || "",
        r.quantity || 1,
        r.model || "PPMP",
        r.warehouseId || "",
        uploadBatchId || null,
        isPhysicallyReceived,
        matchedScan?.scanId || null,
        matchedScan?.scannedAt || null,
        matchedScan?.scannedBy || null,
        matchedScan?.outcome || "",
        aging.status,
        aging.filingDeadline,
        JSON.stringify(r.rawData || {}),
      )
    }

    const upsertSql = `
      INSERT INTO return_tracking_records (
        marketplace_id,
        seller_id, order_id, order_line_id, seller_order_id, return_id,
        tracking_id, forward_tracking_number, return_tracking_number, return_type,
        portal_status, portal_sub_status, return_reason,
        order_created_date, return_created_date, order_rto_date, effective_return_date, portal_delivery_date,
        sku, myntra_sku_code, quantity, model, warehouse_id, upload_batch_id,
        is_physically_received, physical_scan_id, physical_scanned_at, physical_scanned_by, physical_outcome,
        claim_eligibility_status, claim_filing_deadline, raw_data
      ) VALUES ${valuesSql.join(", ")}
      ON CONFLICT (marketplace_id, order_id, order_line_id, tracking_id) DO UPDATE SET
        portal_status = EXCLUDED.portal_status,
        portal_sub_status = EXCLUDED.portal_sub_status,
        return_reason = EXCLUDED.return_reason,
        portal_delivery_date = EXCLUDED.portal_delivery_date,
        is_physically_received = (return_tracking_records.is_physically_received OR EXCLUDED.is_physically_received),
        physical_scan_id = COALESCE(return_tracking_records.physical_scan_id, EXCLUDED.physical_scan_id),
        physical_scanned_at = COALESCE(return_tracking_records.physical_scanned_at, EXCLUDED.physical_scanned_at),
        physical_scanned_by = COALESCE(return_tracking_records.physical_scanned_by, EXCLUDED.physical_scanned_by),
        physical_outcome = COALESCE(NULLIF(return_tracking_records.physical_outcome, ''), EXCLUDED.physical_outcome),
        claim_eligibility_status = CASE
          WHEN return_tracking_records.claim_id IS NOT NULL THEN return_tracking_records.claim_eligibility_status
          ELSE EXCLUDED.claim_eligibility_status
        END,
        claim_filing_deadline = EXCLUDED.claim_filing_deadline,
        raw_data = EXCLUDED.raw_data,
        updated_at = now()
    `

    await db.query(upsertSql, params)
    insertedCount += chunk.length
  }

  // 3. Retrieve accurate summary counts for the marketplace
  const summary = await getReturnTrackingSummary(db, [marketplaceId])

  return {
    inserted: insertedCount,
    updated: 0,
    matchedScans: matchedScansCount,
    summary,
  }
}

// Summary aggregation for return tracking
export async function getReturnTrackingSummary(
  db: Queryable,
  allowedMarketplaceIds: number[],
  marketplaceIdFilter?: number,
): Promise<ReturnTrackingSummary> {
  const mktIds = marketplaceIdFilter
    ? allowedMarketplaceIds.filter((id) => id === marketplaceIdFilter)
    : allowedMarketplaceIds

  if (!mktIds.length) {
    return {
      totalTracked: 0,
      inTransit: 0,
      eligibleRnr: 0,
      expiringSoon: 0,
      expiredUnclaimed: 0,
      delayedRtsEligible: 0,
      delayedRtsExpired: 0,
      physicallyReceived: 0,
      falseDeliveryDiscrepancies: 0,
      claimsFiled: 0,
    }
  }

  const sql = `
    SELECT
      COUNT(*)::int AS total,
      COUNT(CASE WHEN claim_eligibility_status = 'transit' THEN 1 END)::int AS in_transit,
      COUNT(CASE WHEN claim_eligibility_status = 'eligible_rnr' THEN 1 END)::int AS eligible_rnr,
      COUNT(CASE WHEN claim_eligibility_status = 'expiring_soon' THEN 1 END)::int AS expiring_soon,
      COUNT(CASE WHEN claim_eligibility_status = 'expired_unclaimed' THEN 1 END)::int AS expired_unclaimed,
      COUNT(CASE WHEN claim_eligibility_status = 'delayed_rts_eligible' THEN 1 END)::int AS delayed_rts_eligible,
      COUNT(CASE WHEN claim_eligibility_status = 'delayed_rts_expired' THEN 1 END)::int AS delayed_rts_expired,
      COUNT(CASE WHEN is_physically_received = true THEN 1 END)::int AS physically_received,
      COUNT(CASE WHEN (portal_status ILIKE '%Delivered%' OR portal_status = 'DLS') AND is_physically_received = false THEN 1 END)::int AS false_delivery,
      COUNT(CASE WHEN claim_eligibility_status = 'claim_filed' OR claim_id IS NOT NULL THEN 1 END)::int AS claims_filed
    FROM return_tracking_records
    WHERE marketplace_id = ANY($1::int[])
  `

  const res = await db.query(sql, [mktIds])
  const r = res.rows[0] || {}

  return {
    totalTracked: Number(r.total || 0),
    inTransit: Number(r.in_transit || 0),
    eligibleRnr: Number(r.eligible_rnr || 0),
    expiringSoon: Number(r.expiring_soon || 0),
    expiredUnclaimed: Number(r.expired_unclaimed || 0),
    delayedRtsEligible: Number(r.delayed_rts_eligible || 0),
    delayedRtsExpired: Number(r.delayed_rts_expired || 0),
    physicallyReceived: Number(r.physically_received || 0),
    falseDeliveryDiscrepancies: Number(r.false_delivery || 0),
    claimsFiled: Number(r.claims_filed || 0),
  }
}

// Queries return tracking records with pagination and filters
export async function getReturnTrackingList(
  db: Queryable,
  allowedMarketplaceIds: number[],
  filters: ReturnTrackingFilters,
): Promise<{
  records: ReturnTrackingRecord[]
  total: number
  page: number
  limit: number
  summary: ReturnTrackingSummary
}> {
  const mktIdParam = filters.marketplaceId ? parseInt(String(filters.marketplaceId), 10) : undefined
  const activeMktIds = mktIdParam
    ? allowedMarketplaceIds.filter((id) => id === mktIdParam)
    : allowedMarketplaceIds

  if (!activeMktIds.length) {
    return {
      records: [],
      total: 0,
      page: filters.page || 1,
      limit: filters.limit || 50,
      summary: {
        totalTracked: 0,
        inTransit: 0,
        eligibleRnr: 0,
        expiringSoon: 0,
        expiredUnclaimed: 0,
        delayedRtsEligible: 0,
        delayedRtsExpired: 0,
        physicallyReceived: 0,
        falseDeliveryDiscrepancies: 0,
        claimsFiled: 0,
      },
    }
  }

  const whereClauses: string[] = ["r.marketplace_id = ANY($1::int[])"]
  const params: unknown[] = [activeMktIds]
  let pIdx = 2

  // Status Filter
  if (filters.status && filters.status !== "all") {
    if (filters.status === "false_delivery") {
      whereClauses.push(
        `(r.portal_status ILIKE '%Delivered%' OR r.portal_status = 'DLS') AND r.is_physically_received = false`,
      )
    } else if (filters.status === "physically_received") {
      whereClauses.push("r.is_physically_received = true")
    } else if (filters.status === "eligible_all") {
      whereClauses.push(
        "r.claim_eligibility_status IN ('eligible_rnr', 'expiring_soon', 'delayed_rts_eligible')",
      )
    } else {
      whereClauses.push(`r.claim_eligibility_status = $${pIdx++}`)
      params.push(filters.status)
    }
  }

  // Return Type Filter
  if (filters.returnType && filters.returnType !== "all") {
    whereClauses.push(`r.return_type = $${pIdx++}`)
    params.push(filters.returnType)
  }

  // Search Filter
  if (filters.search && filters.search.trim()) {
    const q = `%${filters.search.trim()}%`
    whereClauses.push(`(
      r.tracking_id ILIKE $${pIdx}
      OR r.forward_tracking_number ILIKE $${pIdx}
      OR r.return_tracking_number ILIKE $${pIdx}
      OR r.order_id ILIKE $${pIdx}
      OR r.sku ILIKE $${pIdx}
      OR r.myntra_sku_code ILIKE $${pIdx}
    )`)
    params.push(q)
    pIdx++
  }

  // Date Range Filters
  if (filters.dateFrom) {
    whereClauses.push(`r.effective_return_date >= $${pIdx++}`)
    params.push(filters.dateFrom)
  }
  if (filters.dateTo) {
    whereClauses.push(`r.effective_return_date <= $${pIdx++}`)
    params.push(filters.dateTo)
  }

  const whereSql = whereClauses.join(" AND ")

  // Count total matching rows
  const countSql = `
    SELECT COUNT(*)::int AS count
    FROM return_tracking_records r
    WHERE ${whereSql}
  `
  const countRes = await db.query(countSql, params)
  const total = Number(countRes.rows[0]?.count || 0)

  // Sorting
  const sortDir = filters.sortDir === "asc" ? "ASC" : "DESC"
  let orderBySql = "r.effective_return_date DESC, r.id DESC"
  if (filters.sortKey === "age") {
    orderBySql = `r.effective_return_date ${filters.sortDir === "asc" ? "DESC" : "ASC"}`
  } else if (filters.sortKey === "tracking") {
    orderBySql = `r.tracking_id ${sortDir}`
  } else if (filters.sortKey === "order") {
    orderBySql = `r.order_id ${sortDir}`
  } else if (filters.sortKey === "status") {
    orderBySql = `r.claim_eligibility_status ${sortDir}`
  }

  // Pagination
  const page = Math.max(1, filters.page || 1)
  const limit = Math.max(1, Math.min(200, filters.limit || 50))
  const offset = (page - 1) * limit

  params.push(limit, offset)
  const listSql = `
    SELECT
      r.id,
      r.marketplace_id,
      m.name AS marketplace_name,
      r.seller_id,
      r.order_id,
      r.order_line_id,
      r.seller_order_id,
      r.return_id,
      r.tracking_id,
      r.forward_tracking_number,
      r.return_tracking_number,
      r.return_type,
      r.portal_status,
      r.portal_sub_status,
      r.return_reason,
      r.order_created_date,
      r.return_created_date,
      r.order_rto_date,
      r.effective_return_date,
      r.portal_delivery_date,
      r.sku,
      r.myntra_sku_code,
      r.quantity,
      r.model,
      r.warehouse_id,
      r.is_physically_received,
      r.physical_scan_id,
      r.physical_scanned_at,
      r.physical_outcome,
      r.claim_eligibility_status,
      r.claim_filing_deadline,
      r.claim_id,
      r.claim_ticket_code,
      r.created_at,
      r.updated_at
    FROM return_tracking_records r
    JOIN marketplaces m ON m.id = r.marketplace_id
    WHERE ${whereSql}
    ORDER BY ${orderBySql}
    LIMIT $${pIdx++} OFFSET $${pIdx++}
  `

  const listRes = await db.query(listSql, params)
  const todayIso = new Date().toISOString().slice(0, 10)

  const records: ReturnTrackingRecord[] = (listRes.rows as any[]).map((row) => {
    const effectiveDate = toIsoDateString(row.effective_return_date) || ""
    const ageDays = daysBetween(effectiveDate, todayIso)
    const isFalseDelivery =
      !row.is_physically_received &&
      (String(row.portal_status).toLowerCase().includes("delivered") || row.portal_status === "DLS")

    let daysRemaining: number | null = null
    const deadlineIso = toIsoDateString(row.claim_filing_deadline)
    if (deadlineIso) {
      daysRemaining = Math.max(0, daysBetween(todayIso, deadlineIso))
    }

    return {
      id: Number(row.id),
      marketplaceId: Number(row.marketplace_id),
      marketplaceName: String(row.marketplace_name || ""),
      sellerId: String(row.seller_id || ""),
      orderId: String(row.order_id || ""),
      orderLineId: String(row.order_line_id || ""),
      sellerOrderId: String(row.seller_order_id || ""),
      returnId: String(row.return_id || ""),
      trackingId: String(row.tracking_id || ""),
      forwardTrackingNumber: String(row.forward_tracking_number || ""),
      returnTrackingNumber: String(row.return_tracking_number || ""),
      returnType: row.return_type as "Return" | "RTO",
      portalStatus: String(row.portal_status || ""),
      portalSubStatus: String(row.portal_sub_status || ""),
      returnReason: String(row.return_reason || ""),
      orderCreatedDate: toIsoDateString(row.order_created_date),
      returnCreatedDate: toIsoDateString(row.return_created_date),
      orderRtoDate: toIsoDateString(row.order_rto_date),
      effectiveReturnDate: effectiveDate,
      portalDeliveryDate: toIsoDateString(row.portal_delivery_date),
      sku: String(row.sku || ""),
      myntraSkuCode: String(row.myntra_sku_code || ""),
      quantity: Number(row.quantity || 1),
      model: String(row.model || "PPMP"),
      warehouseId: String(row.warehouse_id || ""),
      isPhysicallyReceived: Boolean(row.is_physically_received),
      physicalScanId: row.physical_scan_id ? Number(row.physical_scan_id) : null,
      physicalScannedAt: toIsoString(row.physical_scanned_at),
      physicalOutcome: String(row.physical_outcome || ""),
      claimEligibilityStatus: row.claim_eligibility_status as ClaimEligibilityStatus,
      claimFilingDeadline: deadlineIso,
      claimId: row.claim_id ? Number(row.claim_id) : null,
      claimTicketCode: String(row.claim_ticket_code || ""),
      ageDays,
      daysRemaining,
      isFalseDelivery,
      createdAt: toIsoString(row.created_at) || new Date().toISOString(),
      updatedAt: toIsoString(row.updated_at) || new Date().toISOString(),
    }
  })

  const summary = await getReturnTrackingSummary(db, allowedMarketplaceIds, mktIdParam)

  return {
    records,
    total,
    page,
    limit,
    summary,
  }
}

// Inward scan reconciliation hook: updates return_tracking_records when a return is scanned at the bench
export async function syncScanToReturnTracking(
  db: Queryable,
  scanId: number,
  trackingId: string,
  orderNumber: string,
  userId: number,
  outcome: string,
): Promise<number> {
  const normTrk = trackingId.trim().toUpperCase()
  const sql = `
    UPDATE return_tracking_records
    SET
      is_physically_received = true,
      physical_scan_id = $1,
      physical_scanned_at = now(),
      physical_scanned_by = $2,
      physical_outcome = $3,
      claim_eligibility_status = CASE
        WHEN claim_eligibility_status IN ('eligible_rnr', 'expiring_soon', 'transit') THEN 'delivered_normal'
        ELSE claim_eligibility_status
      END,
      updated_at = now()
    WHERE tracking_id = $4
       OR forward_tracking_number = $4
       OR return_tracking_number = $4
       OR (order_id = $5 AND $5 <> '')
  `
  const res = await db.query(sql, [scanId, userId, outcome, normTrk, orderNumber.trim()])
  return res.rowCount || 0
}

// 1-Click File SPF Claim from Return Tracking Record
export async function fileSpfClaimFromTracking(
  db: pg.Pool,
  trackingRecordId: number,
  userId: number,
  reason: string,
): Promise<{ claimId: number; trackingRecordId: number }> {
  // Fetch tracking record
  const trkRes = await db.query(
    `SELECT id, marketplace_id, order_id, tracking_id, sku, return_type, claim_eligibility_status, claim_id
     FROM return_tracking_records
     WHERE id = $1`,
    [trackingRecordId],
  )
  if (!trkRes.rows.length) {
    throw new Error("Return tracking record not found")
  }
  const rec = trkRes.rows[0]
  if (rec.claim_id) {
    return { claimId: rec.claim_id, trackingRecordId: rec.id }
  }

  // Insert claim record linked to return_tracking_id
  const claimReason = reason || (rec.claim_eligibility_status === "delayed_rts_eligible"
    ? "Delayed RTS / RTO Delivery (>120 days)"
    : "Return Not Received / Undelivered Return (RNR)")

  const insRes = await db.query(
    `INSERT INTO claims (
      marketplace_id, return_tracking_id, claim_reason, status, created_by
    ) VALUES ($1, $2, $3, 'pending_evidence', $4)
    RETURNING id`,
    [rec.marketplace_id, rec.id, claimReason, userId],
  )
  const claimId = insRes.rows[0].id

  // Update tracking record with claim_id
  await db.query(
    `UPDATE return_tracking_records
     SET claim_id = $1, claim_eligibility_status = 'claim_filed', updated_at = now()
     WHERE id = $2`,
    [claimId, rec.id],
  )

  return { claimId, trackingRecordId: rec.id }
}
