import assert from "node:assert/strict"
import test from "node:test"
import { queryPaymentReadOnly, getPaymentConnectionSettings } from "../payment/db.js"
import { syncPaymentAmounts, runScheduledPaymentSync, getPaymentSyncStatus } from "../payment/sync.js"
import { mapRegisterRow, registerRecords, type RawRegisterRow } from "../register-rules.js"

test("Payment DB Read-Only Guard: rejects any destructive SQL before execution", async () => {
  const destructiveQueries = [
    "INSERT INTO orders (order_id) VALUES ('123')",
    "UPDATE orders SET final_invoice_amount = 500 WHERE id = 1",
    "DELETE FROM settlements WHERE id = 1",
    "DROP TABLE orders",
    "ALTER TABLE myntra_order_details ADD COLUMN test text",
    "TRUNCATE meesho_settlement_items",
    "GRANT ALL PRIVILEGES ON ALL TABLES TO public",
    "REVOKE ALL ON orders FROM postgres",
  ]

  for (const sql of destructiveQueries) {
    await assert.rejects(
      async () => {
        await queryPaymentReadOnly(sql)
      },
      {
        message: "Refusing query: External Payment database access is strictly READ-ONLY.",
      },
      `Should have rejected destructive query: ${sql}`,
    )
  }
})

test("Payment DB Connection Settings: enforces TLS and prevents sslmode=no-verify", () => {
  const originalUrl = process.env.PAYMENT_DATABASE_URL
  try {
    // 1. Missing URL throws clean error without leaking secrets
    delete process.env.PAYMENT_DATABASE_URL
    assert.throws(
      () => getPaymentConnectionSettings(),
      { message: "PAYMENT_DATABASE_URL is not set in environment." },
    )

    // 2. sslmode=no-verify is strictly refused (Rule 7)
    process.env.PAYMENT_DATABASE_URL = "postgresql://user:pass@db.example.com:5432/dashborad?sslmode=no-verify"
    assert.throws(
      () => getPaymentConnectionSettings(),
      { message: "sslmode=no-verify is not allowed. The payment database certificate must be verified." },
    )

    // 3. Remote host enforces TLS with rejectUnauthorized: true
    process.env.PAYMENT_DATABASE_URL = "postgresql://user:pass@db.example.com:5432/dashborad?sslmode=require"
    const settings = getPaymentConnectionSettings()
    assert.equal(typeof settings.ssl === "object" && settings.ssl.rejectUnauthorized, true)
    assert.ok(!settings.connectionString.includes("sslmode=require"))

    // 4. Localhost allows ssl: false for dev/testing
    process.env.PAYMENT_DATABASE_URL = "postgresql://user:pass@localhost:5432/dashborad"
    const localSettings = getPaymentConnectionSettings()
    assert.equal(localSettings.ssl, false)
  } finally {
    if (originalUrl !== undefined) {
      process.env.PAYMENT_DATABASE_URL = originalUrl
    } else {
      delete process.env.PAYMENT_DATABASE_URL
    }
  }
})

test("Register Rules: Column 12 Amount maps numerical sales_amount and exports cleanly", () => {
  const baseRaw: RawRegisterRow = {
    row_key: "SYN-ROW-1",
    source: "item",
    scan_id: 101,
    scanned_at: new Date("2026-10-13T10:00:00Z"),
    scan_day: "2026-10-13",
    scan_time: "15:30",
    scan_status: "Clear",
    scanner_name: "Warehouse Scanner 1",
    marketplace_id: 1,
    marketplace: "Flipkart",
    tracking_id: "SYN-TRACK-101",
    order_number: "SYN-ORD-101",
    order_item_id: "SYN-ITEM-101",
    marketplace_sku: "SYN-SKU-1",
    product_sku: "SYN-MASTER-1",
    product_sku_source: "product_master",
    marketplace_sku_identifier: "FSN12345",
    product_name: "Youthnic Kurti",
    return_type: "Customer Return",
    return_reason: "Size Issue",
    expected_qty: 1,
    received_qty: 1,
    line_no: 1,
    issues: [],
  }

  // 1. When sales_amount is null, row.amount is null
  const rowUnsynced = mapRegisterRow({ ...baseRaw, sales_amount: null })
  assert.equal(rowUnsynced.amount, null)

  // 2. When sales_amount is present, row.amount is converted to number
  const rowSynced = mapRegisterRow({ ...baseRaw, sales_amount: "1299.50" })
  assert.equal(rowSynced.amount, 1299.5)

  // 3. Export records puts Amount in cell index 11 (Column 12)
  const recordsUnsynced = registerRecords([rowUnsynced], "approved")
  assert.equal(recordsUnsynced[0][11], "") // empty string for null amount

  const recordsSynced = registerRecords([rowSynced], "approved")
  assert.equal(recordsSynced[0][11], 1299.5) // numerical amount
})

test("Payment Sync Status: returns pending and synced metrics", async () => {
  const mockPool: any = {
    query: async (sql: string) => {
      if (sql.includes("FROM receipt_scan_items")) {
        return { rows: [{ pending: "42", synced: "128" }] }
      }
      if (sql.includes("FROM payment_sync_runs")) {
        return {
          rows: [
            {
              id: 1,
              status: "success",
              started_at: new Date("2026-10-13T04:30:00Z"),
              completed_at: new Date("2026-10-13T04:31:00Z"),
              scans_checked: 42,
              scans_matched: 38,
              scans_updated: 38,
              total_amount_synced: "45890.00",
              error_message: null,
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const status = await getPaymentSyncStatus(mockPool)
  assert.equal(status.pendingCount, 42)
  assert.equal(status.syncedCount, 128)
  assert.ok(status.lastRun)
  assert.equal(status.lastRun?.status, "success")
  assert.equal(status.lastRun?.totalAmount, 45890)
})

test("Payment Scheduler IST Timing: skips when not 04:30 IST or if already run today", async () => {
  const originalUrl = process.env.PAYMENT_DATABASE_URL
  try {
    process.env.PAYMENT_DATABASE_URL = "postgresql://user:pass@localhost:5432/dashborad"

    const mockPool: any = {
      query: async (sql: string) => {
        if (sql.includes("SELECT COUNT(*) AS count FROM payment_sync_runs")) {
          return { rows: [{ count: "1" }] } // already completed today
        }
        return { rows: [] }
      },
    }

    const res = await runScheduledPaymentSync(mockPool)
    // Should be skipped either because it's not 04:30 or already completed
    assert.equal(res.ran, false)
  } finally {
    if (originalUrl !== undefined) {
      process.env.PAYMENT_DATABASE_URL = originalUrl
    } else {
      delete process.env.PAYMENT_DATABASE_URL
    }
  }
})
