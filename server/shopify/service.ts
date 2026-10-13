import type pg from "pg"
import { istDay } from "../dates.js"
import { allowsAccount, type AccountScope, NO_ACCESS_MESSAGE } from "../access.js"
import { ServiceError } from "../register-service.js"

function csvCell(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value)
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export type ShopifyMetrics = {
  formula: {
    created: number
    received: number
    pending: number
  }
  breakdown: {
    returns: {
      created: number
      received: number
      pending: number
    }
    rtos: {
      created: number
      received: number
      pending: number
    }
  }
  receiptRate: string
  totalActiveScannable: number
  lastSyncedLabel: string
  dailyStats: {
    date: string
    dayLabel: string
    createdReturns: number
    createdRtos: number
    totalCreated: number
    receivedReturns: number
    receivedRtos: number
    totalReceived: number
    pending: number
  }[]
}

export type ShopifyRecord = {
  id: number
  trackingId: string
  altTrackingId: string
  orderNumber: string
  returnType: "Customer Return" | "RTO"
  status: "Pending" | "Received"
  createdAt: string
  receivedAt: string | null
  scannedBy: string | null
  customerName: string
  customerCity: string
  customerPhone: string
  returnReason: string
  productTitle: string
  itemCount: number
  items: {
    sku: string
    title: string
    qty: number
    imageUrl: string
  }[]
  scanIssue: string | null
  scanTicket: string | null
}

export async function getShopifyMetrics(db: pg.Pool, scope?: AccountScope): Promise<ShopifyMetrics> {
  const market = await db.query<{ id: number; last_synced_label: string }>(
    `SELECT id, last_synced_label FROM marketplaces WHERE name = 'Shopify' LIMIT 1`,
  )
  const marketplaceId = market.rows[0]?.id ?? 0
  if (scope && marketplaceId > 0 && !allowsAccount(scope, marketplaceId)) {
    throw new ServiceError(403, NO_ACCESS_MESSAGE)
  }
  const lastSyncedLabel = market.rows[0]?.last_synced_label || "Not synced yet"

  // 1. Total Created by Return Type in Shopify
  const createdRes = await db.query<{ return_type: string; count: string }>(
    `SELECT return_type, count(*)::text as count
     FROM expected_returns
     WHERE marketplace_id = $1
     GROUP BY return_type`,
    [marketplaceId],
  )

  let returnsCreated = 0
  let rtosCreated = 0
  for (const row of createdRes.rows) {
    if (row.return_type === "Customer Return") {
      returnsCreated = Number(row.count)
    } else if (row.return_type === "RTO") {
      rtosCreated = Number(row.count)
    }
  }
  const totalCreated = returnsCreated + rtosCreated

  // 2. Total Received (Scanned in warehouse) by Return Type
  const receivedRes = await db.query<{ return_type: string; count: string }>(
    `SELECT er.return_type, count(rs.id)::text as count
     FROM receipt_scans rs
     JOIN expected_returns er ON er.id = rs.expected_return_id
     WHERE er.marketplace_id = $1
     GROUP BY er.return_type`,
    [marketplaceId],
  )

  let returnsReceived = 0
  let rtosReceived = 0
  for (const row of receivedRes.rows) {
    if (row.return_type === "Customer Return") {
      returnsReceived = Number(row.count)
    } else if (row.return_type === "RTO") {
      rtosReceived = Number(row.count)
    }
  }
  const totalReceived = returnsReceived + rtosReceived

  // 3. Formula: Created - Received = Pending
  const returnsPending = Math.max(0, returnsCreated - returnsReceived)
  const rtosPending = Math.max(0, rtosCreated - rtosReceived)
  const totalPending = Math.max(0, totalCreated - totalReceived)

  const receiptRate =
    totalCreated > 0
      ? `${((totalReceived / totalCreated) * 100).toFixed(1)}%`
      : "100.0%"

  // 4. Count currently active scannable returns in lookup data
  const activeRes = await db.query<{ count: string }>(
    `SELECT count(*)::text as count FROM expected_returns 
     WHERE marketplace_id = $1 AND lookup_status = 'active'`,
    [marketplaceId],
  )
  const totalActiveScannable = Number(activeRes.rows[0]?.count ?? 0)

  // 5. Daily Trend (grouped by IST date of creation)
  const dailyRes = await db.query<{
    day: string
    created_returns: string
    created_rtos: string
    received_returns: string
    received_rtos: string
  }>(
    `SELECT 
       TO_CHAR(timezone('Asia/Kolkata', er.created_at), 'YYYY-MM-DD') AS day,
       COUNT(*) FILTER (WHERE er.return_type = 'Customer Return')::text AS created_returns,
       COUNT(*) FILTER (WHERE er.return_type = 'RTO')::text AS created_rtos,
       COUNT(rs.id) FILTER (WHERE er.return_type = 'Customer Return')::text AS received_returns,
       COUNT(rs.id) FILTER (WHERE er.return_type = 'RTO')::text AS received_rtos
     FROM expected_returns er
     LEFT JOIN receipt_scans rs ON rs.expected_return_id = er.id
     WHERE er.marketplace_id = $1
     GROUP BY day
     ORDER BY day DESC
     LIMIT 14`,
    [marketplaceId],
  )

  const dailyStats = dailyRes.rows.map((r) => {
    const cRet = Number(r.created_returns)
    const cRto = Number(r.created_rtos)
    const totC = cRet + cRto
    const rRet = Number(r.received_returns)
    const rRto = Number(r.received_rtos)
    const totR = rRet + rRto
    const pend = Math.max(0, totC - totR)
    return {
      date: r.day,
      dayLabel: r.day,
      createdReturns: cRet,
      createdRtos: cRto,
      totalCreated: totC,
      receivedReturns: rRet,
      receivedRtos: rRto,
      totalReceived: totR,
      pending: pend,
    }
  })

  return {
    formula: {
      created: totalCreated,
      received: totalReceived,
      pending: totalPending,
    },
    breakdown: {
      returns: {
        created: returnsCreated,
        received: returnsReceived,
        pending: returnsPending,
      },
      rtos: {
        created: rtosCreated,
        received: rtosReceived,
        pending: rtosPending,
      },
    },
    receiptRate,
    totalActiveScannable,
    lastSyncedLabel,
    dailyStats,
  }
}

export type ShopifyRecordFilters = {
  tab?: "all" | "pending" | "received" | "returns" | "rtos"
  search?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}

export async function getShopifyRecords(
  db: pg.Pool,
  filters: ShopifyRecordFilters = {},
  scope?: AccountScope,
): Promise<{ rows: ShopifyRecord[]; total: number }> {
  const market = await db.query<{ id: number }>(
    `SELECT id FROM marketplaces WHERE name = 'Shopify' LIMIT 1`,
  )
  const marketplaceId = market.rows[0]?.id ?? 0
  if (scope && marketplaceId > 0 && !allowsAccount(scope, marketplaceId)) {
    throw new ServiceError(403, NO_ACCESS_MESSAGE)
  }

  const clauses: string[] = ["er.marketplace_id = $1"]
  const params: unknown[] = [marketplaceId]

  if (filters.tab === "pending") {
    clauses.push("rs.id IS NULL")
  } else if (filters.tab === "received") {
    clauses.push("rs.id IS NOT NULL")
  } else if (filters.tab === "returns") {
    clauses.push("er.return_type = 'Customer Return'")
  } else if (filters.tab === "rtos") {
    clauses.push("er.return_type = 'RTO'")
  }

  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim().toLowerCase()}%`)
    const idx = params.length
    clauses.push(
      `(lower(er.tracking_id) LIKE $${idx} OR lower(COALESCE(er.alt_tracking_id, '')) LIKE $${idx} OR lower(er.order_number) LIKE $${idx} OR lower(COALESCE(er.product_title, '')) LIKE $${idx})`,
    )
  }

  if (filters.dateFrom?.trim()) {
    params.push(filters.dateFrom.trim())
    clauses.push(`TO_CHAR(timezone('Asia/Kolkata', er.created_at), 'YYYY-MM-DD') >= $${params.length}`)
  }
  if (filters.dateTo?.trim()) {
    params.push(filters.dateTo.trim())
    clauses.push(`TO_CHAR(timezone('Asia/Kolkata', er.created_at), 'YYYY-MM-DD') <= $${params.length}`)
  }

  const whereClause = clauses.join(" AND ")

  const countRes = await db.query<{ count: string }>(
    `SELECT count(er.id)::text as count
     FROM expected_returns er
     LEFT JOIN receipt_scans rs ON rs.expected_return_id = er.id
     WHERE ${whereClause}`,
    params,
  )
  const total = Number(countRes.rows[0]?.count ?? 0)

  const limit = Math.min(filters.limit || 50, 200)
  const offset = filters.offset || 0

  params.push(limit, offset)
  const limitIdx = params.length - 1
  const offsetIdx = params.length

  const rowsRes = await db.query<{
    id: number
    tracking_id: string
    alt_tracking_id: string | null
    order_number: string
    return_type: string
    created_at: Date
    received_at: Date | null
    scanned_by_name: string | null
    customer_city: string | null
    customer_phone: string | null
    return_reason: string | null
    product_title: string | null
    outcome: string | null
    issue_label: string | null
    ticket_code: string | null
  }>(
    `SELECT 
       er.id,
       er.tracking_id,
       er.alt_tracking_id,
       er.order_number,
       er.return_type,
       er.created_at,
       rs.scanned_at as received_at,
       u.name as scanned_by_name,
       er.customer_city,
       er.customer_phone,
       er.return_reason,
       er.product_title,
       rs.outcome,
       rs.issue_label,
       ct.ticket_code
     FROM expected_returns er
     LEFT JOIN receipt_scans rs ON rs.expected_return_id = er.id
     LEFT JOIN users u ON u.id = rs.scanned_by
     LEFT JOIN claim_tickets ct ON ct.receipt_scan_id = rs.id
     WHERE ${whereClause}
     ORDER BY er.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  )

  const expectedIds = rowsRes.rows.map((r) => r.id)
  const itemsMap = new Map<number, { sku: string; title: string; qty: number; imageUrl: string }[]>()

  if (expectedIds.length > 0) {
    const itemRes = await db.query<{
      expected_return_id: number
      sku: string
      title: string
      qty: number
      image_url: string
    }>(
      `SELECT 
         eri.expected_return_id,
         COALESCE(s.code, eri.channel_listing_id, '') AS sku,
         eri.label AS title,
         eri.qty,
         COALESCE(s.image_url, '') AS image_url
       FROM expected_return_items eri
       LEFT JOIN skus s ON s.id = eri.sku_id
       WHERE eri.expected_return_id = ANY($1::int[])
       ORDER BY eri.sort_order ASC`,
      [expectedIds],
    )

    for (const item of itemRes.rows) {
      const list = itemsMap.get(item.expected_return_id) || []
      list.push({
        sku: item.sku,
        title: item.title,
        qty: item.qty,
        imageUrl: item.image_url,
      })
      itemsMap.set(item.expected_return_id, list)
    }
  }

  const rows: ShopifyRecord[] = rowsRes.rows.map((r) => {
    const items = itemsMap.get(r.id) || []
    const isReceived = Boolean(r.received_at)
    return {
      id: r.id,
      trackingId: r.tracking_id,
      altTrackingId: r.alt_tracking_id || "",
      orderNumber: r.order_number,
      returnType: r.return_type as "Customer Return" | "RTO",
      status: isReceived ? "Received" : "Pending",
      createdAt: istDay(r.created_at),
      receivedAt: r.received_at ? istDay(r.received_at) : null,
      scannedBy: r.scanned_by_name || null,
      customerName: "Shopify Customer",
      customerCity: r.customer_city || "",
      customerPhone: r.customer_phone || "",
      returnReason: r.return_reason || (r.return_type === "RTO" ? "RTO" : "Customer Return"),
      productTitle: r.product_title || items[0]?.title || "",
      itemCount: items.reduce((sum, it) => sum + it.qty, 0) || 1,
      items,
      scanIssue: r.issue_label || (r.outcome === "issue" ? "Issue Reported" : null),
      scanTicket: r.ticket_code || null,
    }
  })

  return { rows, total }
}

export async function exportShopifyCsv(
  db: pg.Pool,
  filters: ShopifyRecordFilters = {},
  scope?: AccountScope,
): Promise<string> {
  const result = await getShopifyRecords(db, { ...filters, limit: 10000, offset: 0 }, scope)
  const headers = [
    "Date Created",
    "Marketplace",
    "Return Type",
    "Status",
    "Order ID",
    "Tracking ID (Delhivery AWB)",
    "Forward AWB",
    "Customer City",
    "Customer Phone",
    "Product Title",
    "SKU",
    "Quantity",
    "Return Reason",
    "Received Date",
    "Scanned By",
    "Warehouse Scan Outcome",
    "Claim Ticket",
  ]

  const lines: string[] = [headers.map(csvCell).join(",")]
  for (const row of result.rows) {
    const itemSkus = row.items.map((i) => i.sku).join("; ")
    const totalQty = row.items.reduce((sum, i) => sum + i.qty, 0) || 1
    const fields = [
      row.createdAt,
      "Shopify",
      row.returnType,
      row.status,
      row.orderNumber,
      row.trackingId,
      row.altTrackingId,
      row.customerCity,
      row.customerPhone,
      row.productTitle,
      itemSkus,
      String(totalQty),
      row.returnReason,
      row.receivedAt || "Not Received (Pending)",
      row.scannedBy || "—",
      row.scanIssue || (row.status === "Received" ? "Clear" : "—"),
      row.scanTicket || "—",
    ]
    lines.push(fields.map(csvCell).join(","))
  }

  return lines.join("\r\n")
}
