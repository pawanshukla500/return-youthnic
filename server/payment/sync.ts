import type pg from "pg"
import { getPaymentPool, paymentDatabaseUrl, queryPaymentReadOnly } from "./db.js"
import { getIstDateParts } from "../email-reports.js"

export type SyncResult = {
  ran: boolean
  status: "success" | "failed" | "skipped" | "locked"
  checked: number
  matched: number
  updated: number
  totalAmount: number
  details: string
  error?: string
}

export type PaymentSyncStatus = {
  configured: boolean
  pendingCount: number
  syncedCount: number
  lastRun: {
    id: number
    status: string
    startedAt: string
    completedAt: string | null
    checked: number
    matched: number
    updated: number
    totalAmount: number
    error: string | null
  } | null
  scheduledTime: string
}

type ScanItemToSync = {
  scanItemId: number
  returnItemId: number | null
  orderItemId: string
  orderLineId: string
  eriOrderLineId: string
  displayOrderItemId: string
  orderNumber: string
  marketplaceCode: string
  marketplaceName: string
}

function normalizeKey(val: string | null | undefined): string {
  if (!val) return ""
  return String(val)
    .trim()
    .replace(/^="(.*)"$/, "$1")
    .replace(/^'/, "")
    .replace(/\s+/g, "")
}

/**
 * Synchronizes sale amounts from the external Payment Database for scanned returns.
 * Safe, idempotent, uses PostgreSQL advisory locking, and updates both receipt_scan_items
 * and expected_return_items.
 */
export async function syncPaymentAmounts(
  db: pg.Pool,
  options: { forceAll?: boolean; trigger?: "cron" | "manual" | "script" | "interval" } = {},
): Promise<SyncResult> {
  const trigger = options.trigger || "cron"

  if (!paymentDatabaseUrl()) {
    return {
      ran: false,
      status: "skipped",
      checked: 0,
      matched: 0,
      updated: 0,
      totalAmount: 0,
      details: "PAYMENT_DATABASE_URL is not configured in environment.",
    }
  }

  // Acquire advisory lock to prevent concurrent sync executions
  const lockRes = await db.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('payment_amount_sync_lock')) AS locked",
  )
  if (!lockRes.rows[0]?.locked) {
    return {
      ran: false,
      status: "locked",
      checked: 0,
      matched: 0,
      updated: 0,
      totalAmount: 0,
      details: "Another payment sync operation is currently running.",
    }
  }

  let runId: number | null = null
  try {
    const runInsert = await db.query<{ id: number }>(
      `INSERT INTO payment_sync_runs (trigger_type, status)
       VALUES ($1, 'running')
       RETURNING id`,
      [trigger],
    )
    runId = Number(runInsert.rows[0].id)

    // 1. Fetch unscanned/unpaid receipt_scan_items
    const itemsQuery = `
      SELECT
        rsi.id AS "scanItemId",
        rsi.expected_return_item_id AS "returnItemId",
        COALESCE(rsi.order_item_id, '') AS "orderItemId",
        COALESCE(rsi.order_line_id, '') AS "orderLineId",
        COALESCE(eri.order_line_id, '') AS "eriOrderLineId",
        COALESCE(eri.display_order_item_id, '') AS "displayOrderItemId",
        COALESCE(rs.order_number_snapshot, er.order_number, '') AS "orderNumber",
        COALESCE(m.code, '') AS "marketplaceCode",
        COALESCE(m.name, '') AS "marketplaceName"
      FROM receipt_scan_items rsi
      JOIN receipt_scans rs ON rs.id = rsi.receipt_scan_id
      LEFT JOIN expected_returns er ON er.id = rs.expected_return_id
      LEFT JOIN expected_return_items eri ON eri.id = rsi.expected_return_item_id
      LEFT JOIN marketplaces m ON m.id = er.marketplace_id
      ${options.forceAll ? "" : "WHERE rsi.sales_amount IS NULL OR rsi.sales_amount = 0"}
      ORDER BY rsi.id ASC
    `
    const { rows: candidateItems } = await db.query<ScanItemToSync>(itemsQuery)

    if (candidateItems.length === 0) {
      await db.query(
        `UPDATE payment_sync_runs
         SET status = 'success', completed_at = now(), scans_checked = 0, scans_matched = 0, scans_updated = 0
         WHERE id = $1`,
        [runId],
      )
      return {
        ran: true,
        status: "success",
        checked: 0,
        matched: 0,
        updated: 0,
        totalAmount: 0,
        details: "No scanned return items require payment sync.",
      }
    }

    // 2. Discover available tables in the Payment Database
    const tablesRes = await queryPaymentReadOnly<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'public' 
       AND table_name IN ('orders', 'unified_settlements', 'settlements', 'myntra_order_details', 'meesho_settlement_items', 'fk_settlement_orders', 'amazon_settlement_lines')`,
    )
    const availableTables = new Set(tablesRes.rows.map((r) => r.table_name))

    // Collect candidate lookup keys
    const itemKeyToRows = new Map<string, ScanItemToSync[]>()
    const orderKeyToRows = new Map<string, ScanItemToSync[]>()

    for (const item of candidateItems) {
      const keys = [
        normalizeKey(item.orderItemId),
        normalizeKey(item.orderLineId),
        normalizeKey(item.eriOrderLineId),
        normalizeKey(item.displayOrderItemId),
      ].filter((k) => k && k !== "—" && !/^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(k))

      for (const key of keys) {
        const existing = itemKeyToRows.get(key) || []
        existing.push(item)
        itemKeyToRows.set(key, existing)
      }

      const orderKey = normalizeKey(item.orderNumber)
      if (orderKey && orderKey !== "—") {
        const existing = orderKeyToRows.get(orderKey) || []
        existing.push(item)
        orderKeyToRows.set(orderKey, existing)
      }
    }

    const allItemKeys = Array.from(itemKeyToRows.keys())
    const allOrderKeys = Array.from(orderKeyToRows.keys())

    // Matched amount map: key -> { amount: number, source: string }
    const itemAmountMap = new Map<string, { amount: number; source: string }>()
    const orderAmountMap = new Map<string, { amount: number; source: string }>()

    // Helper to query in chunks
    const CHUNK_SIZE = 400

    // 2a. Query `orders` table if present (consolidated marketplace orders)
    if (availableTables.has("orders")) {
      for (let i = 0; i < allItemKeys.length; i += CHUNK_SIZE) {
        const chunk = allItemKeys.slice(i, i + CHUNK_SIZE)
        const res = await queryPaymentReadOnly<{
          order_item_id: string
          order_id: string
          amount: string | number
        }>(
          `SELECT order_item_id, order_id, 
                  COALESCE(final_invoice_amount, total_share_amount, my_share, settlement_amount) AS amount
           FROM orders 
           WHERE order_item_id = ANY($1) AND COALESCE(final_invoice_amount, total_share_amount, my_share, settlement_amount) IS NOT NULL`,
          [chunk],
        )
        for (const r of res.rows) {
          const amt = Number(r.amount)
          if (amt > 0) {
            itemAmountMap.set(normalizeKey(r.order_item_id), { amount: amt, source: "orders.order_item_id" })
            if (r.order_id && !orderAmountMap.has(normalizeKey(r.order_id))) {
              orderAmountMap.set(normalizeKey(r.order_id), { amount: amt, source: "orders.order_id" })
            }
          }
        }
      }

      for (let i = 0; i < allOrderKeys.length; i += CHUNK_SIZE) {
        const chunk = allOrderKeys.slice(i, i + CHUNK_SIZE)
        const res = await queryPaymentReadOnly<{
          order_id: string
          amount: string | number
        }>(
          `SELECT order_id, 
                  COALESCE(final_invoice_amount, total_share_amount, my_share, settlement_amount) AS amount
           FROM orders 
           WHERE order_id = ANY($1) AND COALESCE(final_invoice_amount, total_share_amount, my_share, settlement_amount) IS NOT NULL`,
          [chunk],
        )
        for (const r of res.rows) {
          const amt = Number(r.amount)
          if (amt > 0 && !orderAmountMap.has(normalizeKey(r.order_id))) {
            orderAmountMap.set(normalizeKey(r.order_id), { amount: amt, source: "orders.order_id" })
          }
        }
      }
    }

    // 2b. Query `unified_settlements` or `settlements` if present
    const settTable = availableTables.has("unified_settlements")
      ? "unified_settlements"
      : availableTables.has("settlements")
        ? "settlements"
        : null

    if (settTable) {
      for (let i = 0; i < allItemKeys.length; i += CHUNK_SIZE) {
        const chunk = allItemKeys.slice(i, i + CHUNK_SIZE)
        const res = await queryPaymentReadOnly<{
          order_item_id: string
          order_id: string
          sale_amount: string | number
        }>(
          `SELECT order_item_id, order_id, COALESCE(sale_amount, bank_settlement) AS sale_amount
           FROM ${settTable}
           WHERE order_item_id = ANY($1) AND COALESCE(sale_amount, bank_settlement) > 0`,
          [chunk],
        )
        for (const r of res.rows) {
          const amt = Number(r.sale_amount)
          const k = normalizeKey(r.order_item_id)
          if (amt > 0 && !itemAmountMap.has(k)) {
            itemAmountMap.set(k, { amount: amt, source: `${settTable}.order_item_id` })
          }
        }
      }
    }

    // 2c. Query `myntra_order_details` if present
    if (availableTables.has("myntra_order_details")) {
      for (let i = 0; i < allItemKeys.length; i += CHUNK_SIZE) {
        const chunk = allItemKeys.slice(i, i + CHUNK_SIZE)
        const res = await queryPaymentReadOnly<{
          order_line_id: string
          order_release_id: string
          final_amount: string | number
        }>(
          `SELECT order_line_id, order_release_id, COALESCE(final_amount, total_mrp) AS final_amount
           FROM myntra_order_details
           WHERE order_line_id = ANY($1) AND COALESCE(final_amount, total_mrp) > 0`,
          [chunk],
        )
        for (const r of res.rows) {
          const amt = Number(r.final_amount)
          const k = normalizeKey(r.order_line_id)
          if (amt > 0 && !itemAmountMap.has(k)) {
            itemAmountMap.set(k, { amount: amt, source: "myntra_order_details.order_line_id" })
          }
          if (r.order_release_id && !orderAmountMap.has(normalizeKey(r.order_release_id))) {
            orderAmountMap.set(normalizeKey(r.order_release_id), { amount: amt, source: "myntra_order_details.order_release_id" })
          }
        }
      }
    }

    // 2d. Query `meesho_settlement_items` if present
    if (availableTables.has("meesho_settlement_items")) {
      for (let i = 0; i < allItemKeys.length; i += CHUNK_SIZE) {
        const chunk = allItemKeys.slice(i, i + CHUNK_SIZE)
        const res = await queryPaymentReadOnly<{
          order_item_id: string
          sale_amount: string | number
        }>(
          `SELECT order_item_id, COALESCE(sale_amount, bank_settlement) AS sale_amount
           FROM meesho_settlement_items
           WHERE order_item_id = ANY($1) AND COALESCE(sale_amount, bank_settlement) > 0`,
          [chunk],
        )
        for (const r of res.rows) {
          const amt = Number(r.sale_amount)
          const k = normalizeKey(r.order_item_id)
          if (amt > 0 && !itemAmountMap.has(k)) {
            itemAmountMap.set(k, { amount: amt, source: "meesho_settlement_items.order_item_id" })
          }
        }
      }
    }

    // 3. Match items and update Return App database
    let matchedCount = 0
    let updatedCount = 0
    let totalAmount = 0
    const matchedScanItemIds = new Set<number>()

    const client = await db.connect()
    try {
      await client.query("BEGIN")

      for (const item of candidateItems) {
        if (matchedScanItemIds.has(item.scanItemId)) continue

        let match: { amount: number; source: string } | undefined

        // Try item-level keys first
        for (const key of [
          normalizeKey(item.orderItemId),
          normalizeKey(item.orderLineId),
          normalizeKey(item.eriOrderLineId),
          normalizeKey(item.displayOrderItemId),
        ]) {
          if (key && itemAmountMap.has(key)) {
            match = itemAmountMap.get(key)
            break
          }
        }

        // Fallback to order-level key
        if (!match) {
          const ordKey = normalizeKey(item.orderNumber)
          if (ordKey && orderAmountMap.has(ordKey)) {
            match = orderAmountMap.get(ordKey)
          }
        }

        if (match && match.amount > 0) {
          matchedCount++
          matchedScanItemIds.add(item.scanItemId)
          totalAmount += match.amount

          // Update receipt_scan_items
          await client.query(
            `UPDATE receipt_scan_items
             SET sales_amount = $1, payment_synced_at = now(), payment_source = $2
             WHERE id = $3`,
            [match.amount, match.source, item.scanItemId],
          )

          // Update corresponding expected_return_items if linked
          if (item.returnItemId) {
            await client.query(
              `UPDATE expected_return_items
               SET sales_amount = $1, payment_synced_at = now(), payment_source = $2
               WHERE id = $3`,
              [match.amount, match.source, item.returnItemId],
            )
          }
          updatedCount++
        }
      }

      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }

    // 4. Record successful sync run
    await db.query(
      `UPDATE payment_sync_runs
       SET status = 'success', completed_at = now(),
           scans_checked = $1, scans_matched = $2, scans_updated = $3,
           total_amount_synced = $4,
           summary = $5
       WHERE id = $6`,
      [
        candidateItems.length,
        matchedCount,
        updatedCount,
        totalAmount,
        JSON.stringify({
          scansChecked: candidateItems.length,
          scansMatched: matchedCount,
          scansUpdated: updatedCount,
          totalAmountSynced: totalAmount,
          tablesChecked: Array.from(availableTables),
        }),
        runId,
      ],
    )

    return {
      ran: true,
      status: "success",
      checked: candidateItems.length,
      matched: matchedCount,
      updated: updatedCount,
      totalAmount,
      details: `Checked ${candidateItems.length} scanned return items; matched and synced payment amounts for ${matchedCount} items (totaling ₹${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}).`,
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    if (runId) {
      await db.query(
        `UPDATE payment_sync_runs
         SET status = 'failed', completed_at = now(), error_message = $1
         WHERE id = $2`,
        [errorMsg, runId],
      )
    }
    return {
      ran: false,
      status: "failed",
      checked: 0,
      matched: 0,
      updated: 0,
      totalAmount: 0,
      details: `Payment amount sync failed: ${errorMsg}`,
      error: errorMsg,
    }
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtext('payment_amount_sync_lock'))")
  }
}

/**
 * Returns current sync status and metrics for the Admin UI.
 */
export async function getPaymentSyncStatus(db: pg.Pool): Promise<PaymentSyncStatus> {
  const configured = Boolean(paymentDatabaseUrl())

  const countsRes = await db.query<{ pending: string; synced: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE sales_amount IS NULL OR sales_amount = 0) AS pending,
      COUNT(*) FILTER (WHERE sales_amount IS NOT NULL AND sales_amount > 0) AS synced
    FROM receipt_scan_items
  `)
  const pendingCount = Number(countsRes.rows[0]?.pending || 0)
  const syncedCount = Number(countsRes.rows[0]?.synced || 0)

  const lastRunRes = await db.query<{
    id: number
    status: string
    started_at: Date
    completed_at: Date | null
    scans_checked: number
    scans_matched: number
    scans_updated: number
    total_amount_synced: string
    error_message: string | null
  }>(`
    SELECT id, status, started_at, completed_at, scans_checked, scans_matched, scans_updated, total_amount_synced, error_message
    FROM payment_sync_runs
    ORDER BY created_at DESC
    LIMIT 1
  `)

  const r = lastRunRes.rows[0]
  const lastRun = r
    ? {
        id: Number(r.id),
        status: String(r.status),
        startedAt: new Date(r.started_at).toISOString(),
        completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
        checked: Number(r.scans_checked),
        matched: Number(r.scans_matched),
        updated: Number(r.scans_updated),
        totalAmount: Number(r.total_amount_synced || 0),
        error: r.error_message,
      }
    : null

  return {
    configured,
    pendingCount,
    syncedCount,
    lastRun,
    scheduledTime: "04:30 AM IST (Daily & Semi-weekly)",
  }
}

/**
 * In-process scheduler hook called every 60s from server/index.ts.
 * Checks if current time is 04:30 AM IST and executes if not yet run today.
 */
export async function runScheduledPaymentSync(db: pg.Pool): Promise<{ ran: boolean; details: string }> {
  if (!paymentDatabaseUrl()) {
    return { ran: false, details: "PAYMENT_DATABASE_URL not configured." }
  }

  const ist = getIstDateParts()
  const currentTime = ist.timeStr // e.g. "04:30"
  const TARGET_TIME = "04:30"

  // Only trigger at 04:30 IST
  if (currentTime !== TARGET_TIME) {
    return { ran: false, details: `Not due yet (current IST: ${currentTime}, scheduled: ${TARGET_TIME})` }
  }

  // Check if a sync already completed today
  const existingToday = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM payment_sync_runs
     WHERE status = 'success'
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date`,
    [ist.dateStr],
  )
  if (Number(existingToday.rows[0]?.count || 0) > 0) {
    return { ran: false, details: `Payment sync already completed today for ${ist.dateStr}` }
  }

  const result = await syncPaymentAmounts(db, { trigger: "cron" })
  return { ran: result.ran, details: result.details }
}
