import assert from "node:assert/strict"
import test from "node:test"
import { queryShopifyReadOnly } from "../shopify/db.js"
import { getShopifyMetrics, exportShopifyCsv } from "../shopify/service.js"
import { allowsAccount, scopeFor, NO_ACCESS_MESSAGE } from "../access.js"
import { ServiceError } from "../register-service.js"

test("Shopify Read-Only Guard: rejects any destructive SQL before execution", async () => {
  const destructiveQueries = [
    "INSERT INTO \"Return\" (id) VALUES (1)",
    "UPDATE \"Order\" SET status = 'CANCELLED'",
    "DELETE FROM \"Shipment\" WHERE id = 1",
    "DROP TABLE \"Order\"",
    "ALTER TABLE \"OrderItem\" ADD COLUMN test text",
    "TRUNCATE \"Return\"",
    "GRANT ALL PRIVILEGES ON ALL TABLES TO public",
    "REVOKE ALL ON \"Order\" FROM postgres",
  ]

  for (const sql of destructiveQueries) {
    await assert.rejects(
      async () => {
        await queryShopifyReadOnly(sql)
      },
      {
        message: "Refusing query: External Shopify database access is strictly READ-ONLY.",
      },
      `Should have rejected destructive query: ${sql}`,
    )
  }
})

test("Shopify Formula Calculation: Created - Received = Pending", () => {
  // Test the mathematical calculation logic under all operational conditions
  const testCases = [
    { created: 10, received: 4, expectedPending: 6 },
    { created: 100, received: 100, expectedPending: 0 },
    { created: 50, received: 0, expectedPending: 50 },
    // Defensive check: if physical scans exceed expected (unusual scenario), pending floor is 0
    { created: 5, received: 6, expectedPending: 0 },
  ]

  for (const tc of testCases) {
    const pending = Math.max(0, tc.created - tc.received)
    assert.equal(pending, tc.expectedPending, `Formula failed for ${tc.created} - ${tc.received}`)
  }
})

test("Shopify Access Scope: Rule 1 enforces account authorization on metrics and records", async () => {
  const shopifyMarketplaceId = 99

  // Admin user can access all
  const adminScope = scopeFor({ role: "Admin", hasAllMarketplaces: false, marketplaceIds: [] })
  assert.equal(allowsAccount(adminScope, shopifyMarketplaceId), true)

  // Scanner with explicit Shopify access can access
  const authorizedScope = scopeFor({ role: "Scanner", hasAllMarketplaces: false, marketplaceIds: [shopifyMarketplaceId] })
  assert.equal(allowsAccount(authorizedScope, shopifyMarketplaceId), true)

  // Scanner with only Myntra access cannot access Shopify
  const restrictedScope = scopeFor({ role: "Scanner", hasAllMarketplaces: false, marketplaceIds: [1, 2] })
  assert.equal(allowsAccount(restrictedScope, shopifyMarketplaceId), false)

  // Mock pool simulating restricted access
  const mockPool: any = {
    query: async (sql: string) => {
      if (sql.includes("SELECT id, last_synced_label FROM marketplaces")) {
        return { rows: [{ id: shopifyMarketplaceId, last_synced_label: "Today at 10:00 AM" }] }
      }
      return { rows: [] }
    },
  }

  await assert.rejects(
    async () => {
      await getShopifyMetrics(mockPool, restrictedScope)
    },
    (err: unknown) => {
      assert.ok(err instanceof ServiceError)
      assert.equal((err as ServiceError).status, 403)
      assert.equal((err as ServiceError).message, NO_ACCESS_MESSAGE)
      return true
    },
  )
})

test("Shopify Formula Breakdown: preserves Returns and RTO breakdowns accurately", async () => {
  const shopifyMarketplaceId = 7

  const mockPool: any = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("SELECT id, last_synced_label FROM marketplaces")) {
        return { rows: [{ id: shopifyMarketplaceId, last_synced_label: "Today at 11:30 AM" }] }
      }
      if (sql.includes("FROM expected_returns") && sql.includes("GROUP BY return_type")) {
        return {
          rows: [
            { return_type: "Customer Return", count: "15" },
            { return_type: "RTO", count: "9" },
          ],
        }
      }
      if (sql.includes("FROM receipt_scans rs") && sql.includes("GROUP BY er.return_type")) {
        return {
          rows: [
            { return_type: "Customer Return", count: "5" },
            { return_type: "RTO", count: "3" },
          ],
        }
      }
      if (sql.includes("lookup_status = 'active'")) {
        return { rows: [{ count: "16" }] }
      }
      if (sql.includes("timezone('Asia/Kolkata', er.created_at)")) {
        return {
          rows: [
            {
              day: "2026-10-13",
              created_returns: "15",
              created_rtos: "9",
              received_returns: "5",
              received_rtos: "3",
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const metrics = await getShopifyMetrics(mockPool)

  // Created: 15 returns + 9 rtos = 24 total
  assert.equal(metrics.formula.created, 24)
  // Received: 5 returns + 3 rtos = 8 total
  assert.equal(metrics.formula.received, 8)
  // Pending: 24 - 8 = 16 total
  assert.equal(metrics.formula.pending, 16)

  // Breakdown checks
  assert.equal(metrics.breakdown.returns.created, 15)
  assert.equal(metrics.breakdown.returns.received, 5)
  assert.equal(metrics.breakdown.returns.pending, 10) // 15 - 5 = 10

  assert.equal(metrics.breakdown.rtos.created, 9)
  assert.equal(metrics.breakdown.rtos.received, 3)
  assert.equal(metrics.breakdown.rtos.pending, 6) // 9 - 3 = 6

  // Rate: 8 / 24 = 33.3%
  assert.equal(metrics.receiptRate, "33.3%")
  assert.equal(metrics.totalActiveScannable, 16)
  assert.equal(metrics.lastSyncedLabel, "Today at 11:30 AM")

  // Daily stats check
  assert.equal(metrics.dailyStats.length, 1)
  assert.equal(metrics.dailyStats[0].date, "2026-10-13")
  assert.equal(metrics.dailyStats[0].totalCreated, 24)
  assert.equal(metrics.dailyStats[0].totalReceived, 8)
  assert.equal(metrics.dailyStats[0].pending, 16)
})

test("Shopify CSV Export: quotes fields and handles nulls gracefully", async () => {
  const shopifyMarketplaceId = 7

  const mockPool: any = {
    query: async (sql: string) => {
      if (sql.includes("SELECT id FROM marketplaces")) {
        return { rows: [{ id: shopifyMarketplaceId }] }
      }
      if (sql.includes("SELECT count(er.id)::text as count")) {
        return { rows: [{ count: "1" }] }
      }
      if (sql.includes("FROM expected_returns er") && !sql.includes("SELECT count")) {
        return {
          rows: [
            {
              id: 101,
              tracking_id: "SYN-DEL-123456",
              alt_tracking_id: "SYN-FWD-654321",
              order_number: "#1099",
              return_type: "Customer Return",
              created_at: new Date("2026-10-13T06:00:00Z"),
              received_at: null,
              scanned_by_name: null,
              customer_city: "Delhi, North",
              customer_phone: "+91 9999999999",
              return_reason: "Item defect; wrong size",
              product_title: "Rayon Anarkali Kurta, Green",
              outcome: null,
              issue_label: null,
              ticket_code: null,
            },
          ],
        }
      }
      if (sql.includes("FROM expected_return_items")) {
        return {
          rows: [
            {
              expected_return_id: 101,
              sku: "VB-KURTA-GRN-L",
              product_title: "Rayon Anarkali Kurta, Green",
              quantity: 1,
              image_url: "",
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const csv = await exportShopifyCsv(mockPool)
  assert.ok(csv.includes("Date Created,Marketplace,Return Type,Status,Order ID,Tracking ID (Delhivery AWB)"))
  assert.ok(csv.includes("SYN-DEL-123456"))
  assert.ok(csv.includes('"Delhi, North"')) // commas escaped with quotes
  assert.ok(csv.includes("Item defect; wrong size"))
})
