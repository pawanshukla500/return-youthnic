import { test } from "node:test"
import assert from "node:assert/strict"
import {
  generateRequestId,
  buildOmsguruCsv,
  renderOmsguruUpdateEmail,
  DEFAULT_OMSGURU_CONFIG,
  type SkuUpdateItem,
  type OmsguruDailyUpdateRecord,
} from "../omsguru-daily.js"
import { isFirebaseConfigured } from "../firebase-storage.js"

test("generateRequestId produces valid audit Request ID with date, time and random suffix", () => {
  const req1 = generateRequestId("2026-10-13")
  const req2 = generateRequestId("2026-10-13")

  assert.match(req1, /^REQ-20261013-\d{4}-[A-F0-9]{6}$/)
  assert.match(req2, /^REQ-20261013-\d{4}-[A-F0-9]{6}$/)
  assert.notEqual(req1, req2, "Consecutive request IDs must be unique")
})

test("buildOmsguruCsv formats exact headers and columns required by OMSGuru bulk inventory template", () => {
  const mockSkus: SkuUpdateItem[] = [
    {
      sku: "SYN-KURTI-RED-M",
      qty: 10,
      marketplaces: { "Myntra VB": 6, Flipkart: 4 },
    },
    {
      sku: "SYN-JEANS-BLK-32",
      qty: 5,
      marketplaces: { Amazon: 3, Ajio: 2 },
    },
  ]

  const csv = buildOmsguruCsv({
    warehouseId: "6688",
    requestId: "REQ-20261013-1945-A1B2C3",
    skus: mockSkus,
  })

  const lines = csv.trim().split("\r\n")
  assert.equal(lines.length, 3, "Must contain header plus 2 SKU rows")

  // Verify exact header names
  const expectedHeader = "DropshipWarehouseId,Item SkuCode,InventoryAction,QtyIncludesBlocked,Qty,RackSpace,Last Purchase Price,Notes"
  assert.equal(lines[0], expectedHeader)

  // Verify first row
  const row1 = lines[1].split(",")
  assert.equal(row1[0], "6688", "DropshipWarehouseId default is 6688")
  assert.equal(row1[1], "SYN-KURTI-RED-M", "Item SkuCode matches Master SKU")
  assert.equal(row1[2], "ADD", "InventoryAction must be ADD")
  assert.equal(row1[3], "", "QtyIncludesBlocked must be blank")
  assert.equal(row1[4], "10", "Qty must be total good received qty")
  assert.equal(row1[5], "", "RackSpace must be blank for default rack auto-adjustment")
  assert.equal(row1[6], "", "Last Purchase Price must be blank")
  assert.equal(row1[7], "REQ-20261013-1945-A1B2C3", "Notes must contain Request ID")

  // Verify second row
  const row2 = lines[2].split(",")
  assert.equal(row2[1], "SYN-JEANS-BLK-32")
  assert.equal(row2[4], "5")
})

test("buildOmsguruCsv properly escapes special characters in SKU and notes", () => {
  const mockSkus: SkuUpdateItem[] = [
    {
      sku: 'SKU,WITH"COMMA',
      qty: 8,
      marketplaces: { Meesho: 8 },
    },
  ]

  const csv = buildOmsguruCsv({
    warehouseId: "6688",
    requestId: 'REQ-20261013-1945-"SPECIAL"',
    skus: mockSkus,
  })

  assert.ok(csv.includes('"SKU,WITH""COMMA"'))
  assert.ok(csv.includes('"REQ-20261013-1945-""SPECIAL"""'))
})

test("renderOmsguruUpdateEmail creates styled HTML and plain text with correct summary & attachment notice", () => {
  const mockRecord: OmsguruDailyUpdateRecord = {
    id: 1,
    requestId: "REQ-20261013-1945-TEST01",
    updateDate: "2026-10-13",
    dropshipWarehouseId: "6688",
    totalSkus: 2,
    totalQty: 15,
    csvContent: "DropshipWarehouseId,Item SkuCode,InventoryAction...\r\n",
    fileName: "UpdateInStockQtyAnd_orLastPurchasePrice_2026-10-13_REQ-20261013-1945-TEST01.csv",
    storagePath: "inventory-update-file/2026-10-13/UpdateInStockQtyAnd_orLastPurchasePrice.csv",
    storageUrl: "https://storage.googleapis.com/return-scan-app.firebasestorage.app/inventory-update-file/test.csv",
    emailSent: true,
    emailSentAt: "2026-10-13T19:45:00Z",
    emailRecipients: ["admin@youthnic.shop"],
    emailCc: ["audit@youthnic.shop"],
    skuBreakdown: [
      { sku: "SKU-A", qty: 10, marketplaces: { "Myntra VB": 10 } },
      { sku: "SKU-B", qty: 5, marketplaces: { Flipkart: 5 } },
    ],
    generatedBy: null,
    createdAt: "2026-10-13T19:45:00Z",
  }

  const email = renderOmsguruUpdateEmail(mockRecord, DEFAULT_OMSGURU_CONFIG)

  // Verify Subject
  assert.ok(email.subject.includes("OMSGuru Daily Inventory Update"))
  assert.ok(email.subject.includes("REQ-20261013-1945-TEST01"))
  assert.ok(email.subject.includes("15 Units"))

  // Verify HTML contents
  assert.ok(email.html.includes("Youthnic"))
  assert.ok(email.html.includes("REQ-20261013-1945-TEST01"))
  assert.ok(email.html.includes("Dropship Warehouse ID"))
  assert.ok(email.html.includes("6688"))
  assert.ok(email.html.includes("SKU-A"))
  assert.ok(email.html.includes("UpdateInStockQtyAnd_orLastPurchasePrice.csv"))
  assert.ok(email.html.includes("180 days"))

  // Verify Plain Text
  assert.ok(email.text.includes("OMSGuru Daily Inventory Update"))
  assert.ok(email.text.includes("REQ-20261013-1945-TEST01"))
  assert.ok(email.text.includes("Total Good Received Units: 15"))
})

test("isFirebaseConfigured returns valid status without throwing error", () => {
  const result = isFirebaseConfigured()
  assert.equal(typeof result, "object")
  assert.equal(typeof result.configured, "boolean")
})
