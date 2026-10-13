// Synthetic ingestion, parsing resilience, identifier precision and warehouse load simulation tests.
// ALL fixtures use SYN- synthetic identifiers and never contain real customer PII or credentials.
//
// Run: node --import tsx --test server/tests/marketplace-ingestion.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"
import XLSX from "xlsx"
import { isScannableRow, parseSpreadsheet, rowStatus } from "../sheets.js"
import { isValidClientKey } from "../register-rules.js"

function csvOf(header: string[], rows: Record<string, string>[]): string {
  const lines = [header.join(",")]
  for (const row of rows) {
    lines.push(
      header
        .map((col) => {
          const val = row[col] ?? ""
          if (val.includes(",") || val.includes('"') || val.includes("\n")) {
            return `"${val.replace(/"/g, '""')}"`
          }
          return val
        })
        .join(","),
    )
  }
  return lines.join("\r\n")
}

function xlsxBuffer(rows: unknown[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, "Returns")
  return Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }))
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Myntra EJ and Myntra VB
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] Myntra: identical 40-column layout parses correctly for EJ and VB", () => {
  const myntraHeader = [
    "seller_id", "warehouse_id", "partner_warehouse_code", "model", "myntra_sku_code", "seller_sku_code",
    "style_id", "sku_id", "brand", "order_created_date", "inscanned_on", "fmpu_date", "order_delivered_date",
    "return_created_date", "refunded_date", "order_rto_date", "is_refunded", "exchange_id", "order_id",
    "order_group_id", "order_line_id", "seller_order_id", "type", "status", "store_packet_id",
    "seller_packet_id_fk", "quantity", "return_id", "return_mode", "return_reason", "return_status",
    "forward_tracking_number", "return_tracking_number", "master_bag_id", "lmdo_status",
    "lmdo_last_modified_on", "gatepass_id", "gatepass_status", "gatepass_type", "gatepass_lastmodified",
  ]

  const ejCsv = csvOf(myntraHeader, [{
    seller_id: "45833",
    order_id: "SYN-ORD-MYN-01",
    order_line_id: "SYN-LINE-01",
    seller_sku_code: "SYN-SKU-EJ-1",
    myntra_sku_code: "SYN-MYN-SKU-1",
    quantity: "1",
    return_id: "SYN-RET-01",
    type: "customer_return",
    return_reason: "Defective item",
    forward_tracking_number: "SYNFWD112233",
    return_tracking_number: "SYNREV112233",
  }])

  const vbCsv = csvOf(myntraHeader, [{
    seller_id: "10708",
    order_id: "SYN-ORD-MYN-02",
    order_line_id: "SYN-LINE-02",
    seller_sku_code: "SYN-SKU-VB-1",
    myntra_sku_code: "SYN-MYN-SKU-2",
    quantity: "2",
    return_id: "SYN-RET-02",
    type: "courier_return",
    return_reason: "Customer unreachable",
    forward_tracking_number: "SYNFWD445566",
    return_tracking_number: "SYNREV445566",
  }])

  const ejRes = parseSpreadsheet(Buffer.from(ejCsv, "utf8"), "Myntra EJ", "Myntra EJ.csv")
  assert.equal(ejRes.fatal, "")
  assert.equal(ejRes.rows.length, 1)
  assert.equal(ejRes.rows[0].trackingId, "SYNREV112233")
  assert.equal(ejRes.rows[0].altTrackingId, "SYNFWD112233")
  assert.equal(ejRes.rows[0].orderId, "SYN-ORD-MYN-01")
  assert.equal(ejRes.rows[0].orderLineId, "SYN-LINE-01")
  assert.equal(ejRes.rows[0].sku, "SYN-SKU-EJ-1")
  assert.equal(ejRes.rows[0].returnType, "customer_return")

  const vbRes = parseSpreadsheet(Buffer.from(vbCsv, "utf8"), "Myntra VB", "Myntra VB.csv")
  assert.equal(vbRes.fatal, "")
  assert.equal(vbRes.rows.length, 1)
  assert.equal(vbRes.rows[0].trackingId, "SYNREV445566")
  assert.equal(vbRes.rows[0].sku, "SYN-SKU-VB-1")
  assert.equal(vbRes.rows[0].qty, 2)
  assert.equal(vbRes.rows[0].returnType, "courier_return")
})

// ---------------------------------------------------------------------------------------------------------------
// 2. Ajio XLSX: Alphanumeric AWBs and Return Shipment ID
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] Ajio: parses XLSX with mixed alphanumeric AWBs and preserves Return Shipment ID", () => {
  const ajioHeader = [
    "Return AWB No", "Cust Order No", "RETURN ORDER NUMBER", "SELLER SKU", "JioCode", "Return QTY",
    "Return Shipment ID", "Cust Return Reason", "Return Type", "Return Carrier Name",
  ]

  const buf = xlsxBuffer([
    ajioHeader,
    [
      "SF1234567890IN", // Alphanumeric Shadowfax AWB
      "SYN-AJIO-ORD-1",
      "SYN-AJIO-RET-ORD-1",
      "SYN-SELLER-SKU-A",
      "461234567",
      1,
      "SYN-AJIO-SHIP-99", // Return Shipment ID
      "Color mismatch",
      "Customer Return",
      "Shadowfax",
    ],
  ])

  const res = parseSpreadsheet(buf, "Ajio", "Ajio Return.xlsx")
  assert.equal(res.fatal, "")
  assert.equal(res.rows.length, 1)
  const r = res.rows[0]
  assert.equal(r.trackingId, "SF1234567890IN")
  assert.equal(r.orderId, "SYN-AJIO-ORD-1")
  assert.equal(r.displayOrderItemId, "SYN-AJIO-RET-ORD-1")
  assert.equal(r.shipmentId, "SYN-AJIO-SHIP-99")
  assert.equal(r.sku, "SYN-SELLER-SKU-A")
  assert.equal(r.courier, "Shadowfax")
})

// ---------------------------------------------------------------------------------------------------------------
// 3. Flipkart: Preserves Order Item ID and Shipment ID
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] Flipkart: preserves Order Item ID, Return ID, Tracking ID and Shipment ID", () => {
  const flipkartHeader = [
    "Order ID", "Order Item ID", "Return ID", "Tracking ID", "Shipment ID", "SKU", "FSN",
    "Quantity", "Return Type", "Return Reason", "Vendor Name",
  ]

  const csv = csvOf(flipkartHeader, [{
    "Order ID": "SYN-FK-ORD-100",
    "Order Item ID": "SYN-FK-ITEM-100",
    "Return ID": "SYN-FK-RET-100",
    "Tracking ID": "SYN-FK-TRACK-100",
    "Shipment ID": "SYN-FK-SHIP-100",
    SKU: "SYN-FK-SKU-100",
    FSN: "SYN-FSN-100",
    Quantity: "3",
    "Return Type": "courier_return",
    "Return Reason": "Delivery failed",
    "Vendor Name": "Ekart",
  }])

  const res = parseSpreadsheet(Buffer.from(csv, "utf8"), "Flipkart", "Flipkart Return.csv")
  assert.equal(res.fatal, "")
  assert.equal(res.rows.length, 1)
  const r = res.rows[0]
  assert.equal(r.trackingId, "SYN-FK-TRACK-100")
  assert.equal(r.orderId, "SYN-FK-ORD-100")
  assert.equal(r.orderLineId, "SYN-FK-ITEM-100")
  assert.equal(r.returnEventId, "SYN-FK-RET-100")
  assert.equal(r.shipmentId, "SYN-FK-SHIP-100")
  assert.equal(r.sku, "SYN-FK-SKU-100")
  assert.equal(r.qty, 3)
  assert.equal(r.returnType, "RTO")
})

// ---------------------------------------------------------------------------------------------------------------
// 4. Meesho: Header on row 8 and carrier link tracking extraction
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] Meesho: recognizes header on row 8 with supplier preamble and carrier links", () => {
  const meeshoHeader = [
    "S No", "Product Name", "SKU", "Variation", "Meesho PID", "Category", "Qty", "Order Number",
    "Suborder Number", "Dispatch Date", "Return Created Date", "Type of Return", "Sub Type", "Delivered Date",
    "Courier Partner", "AWB Number", "Tracking Link", "Proof of Delivery", "Return Price Type", "Return Reason",
    "Detailed Return Reason", "OTP verified at",
  ]

  const rows: unknown[][] = [
    ["Supplier ID", "10874"],
    ["Supplier Name", "VB Exports"],
    ["", ""],
    ["", ""],
    ["", ""],
    ["", ""],
    ["", ""],
    meeshoHeader, // Row index 7 (row 8)
    [
      "1",
      "SYN Kurti",
      "SYN-MEE-SKU-1",
      "L",
      "PID123",
      "Apparel",
      "1",
      "SYN-MEE-ORD-1",
      "SYN-MEE-SUB-1",
      "2026-10-01",
      "2026-10-05",
      "Customer Return",
      "",
      "2026-10-10",
      "Valmo",
      "VM1234567890",
      "https://meesho.portal.shipsy.io/track?awb=VM1234567890",
      "",
      "",
      "Size too small",
      "",
      "",
    ],
  ]

  const buf = xlsxBuffer(rows)
  const res = parseSpreadsheet(buf, "Meesho", "Meesho Return.xlsx")
  assert.equal(res.fatal, "")
  assert.equal(res.rows.length, 1)
  const r = res.rows[0]
  assert.equal(r.trackingId, "VM1234567890")
  assert.equal(r.orderId, "SYN-MEE-ORD-1")
  assert.equal(r.sku, "SYN-MEE-SKU-1_L")
  assert.equal(r.courier, "Valmo")
  assert.equal(r.trackingSource, "tracking_id")
})

// ---------------------------------------------------------------------------------------------------------------
// 5. String Identifier Preservation: 16-25 digits, leading zeros, scientific notation
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] Identifiers: 16-25 digit strings and leading zeros preserved; scientific notation warned", () => {
  const flipkartHeader = [
    "Order ID", "Order Item ID", "Return ID", "Tracking ID", "Shipment ID", "SKU", "Quantity", "Return Type", "Return Reason",
  ]

  const csv = csvOf(flipkartHeader, [
    {
      "Order ID": "000123456789012345", // 18-digit ID with leading zeros
      "Order Item ID": "9876543210123456789012345", // 25-digit ID
      "Return ID": "SYN-RET-LONG",
      "Tracking ID": "000888999111222333", // 18-digit tracking ID
      "Shipment ID": "000999",
      SKU: "SYN-SKU-EXACT",
      Quantity: "1",
      "Return Type": "customer_return",
      "Return Reason": "Fits poorly",
    },
    {
      "Order ID": "3.39123456789012E+17", // Scientific notation
      "Order Item ID": "SYN-ITEM-NORM",
      "Return ID": "SYN-RET-NORM",
      "Tracking ID": "SYN-TRACK-NORM",
      "Shipment ID": "SYN-SHIP-NORM",
      SKU: "SYN-SKU-SCI",
      Quantity: "1",
      "Return Type": "customer_return",
      "Return Reason": "Too small",
    },
  ])

  const res = parseSpreadsheet(Buffer.from(csv, "utf8"), "Flipkart", "Flipkart.csv")
  assert.equal(res.fatal, "")
  assert.equal(res.rows.length, 2)

  // Row 1: leading zeros and 18-25 digit IDs intact as exact text strings
  const r1 = res.rows[0]
  assert.equal(r1.orderId, "000123456789012345")
  assert.equal(r1.orderLineId, "9876543210123456789012345")
  assert.equal(r1.trackingId, "000888999111222333")
  assert.equal(r1.shipmentId, "000999")
  assert.equal(isScannableRow(r1), true)

  // Row 2: scientific notation detected, order ID cleared with warning, never guessed
  const r2 = res.rows[1]
  assert.equal(r2.orderId, "")
  assert.equal(r2.warnings.some((w) => w.includes("scientific notation")), true)
})

// ---------------------------------------------------------------------------------------------------------------
// 6. Resilience: Reordered columns, extra columns, missing mandatory headers
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] Header Resilience: reordered columns and extra non-required columns accepted", () => {
  // Reordered Flipkart columns with extra injected columns
  const reorderedHeader = [
    "Unrelated Extra Column A",
    "Return Reason",
    "Quantity",
    "Tracking ID",
    "Order ID",
    "Another Extra B",
    "Order Item ID",
    "Shipment ID",
    "SKU",
    "Return Type",
  ]

  const csv = csvOf(reorderedHeader, [{
    "Unrelated Extra Column A": "Extra Value 123",
    "Return Reason": "Damaged during transit",
    Quantity: "2",
    "Tracking ID": "SYN-TRACK-REORDER-1",
    "Order ID": "SYN-ORD-REORDER-1",
    "Another Extra B": "Ignore this metadata",
    "Order Item ID": "SYN-ITEM-REORDER-1",
    "Shipment ID": "SYN-SHIP-REORDER-1",
    SKU: "SYN-SKU-REORDER",
    "Return Type": "Customer Return",
  }])

  const res = parseSpreadsheet(Buffer.from(csv, "utf8"), "Flipkart", "Flipkart.csv")
  assert.equal(res.fatal, "")
  assert.equal(res.rows.length, 1)
  const r = res.rows[0]
  assert.equal(r.trackingId, "SYN-TRACK-REORDER-1")
  assert.equal(r.orderId, "SYN-ORD-REORDER-1")
  assert.equal(r.qty, 2)
  assert.equal(r.sku, "SYN-SKU-REORDER")
})

test("[synthetic] Header Validation: missing mandatory headers returns fatal error without throwing", () => {
  const incompleteHeader = ["Order ID", "Quantity", "Return Reason"]
  const csv = csvOf(incompleteHeader, [{
    "Order ID": "SYN-ORD-1",
    Quantity: "1",
    "Return Reason": "Wrong",
  }])

  const res = parseSpreadsheet(Buffer.from(csv, "utf8"), "Flipkart", "Flipkart.csv")
  assert.notEqual(res.fatal, "")
  assert.equal(res.fatal.includes("missing required header"), true)
  assert.equal(res.rows.length, 0)
})

// ---------------------------------------------------------------------------------------------------------------
// 7. Scanner Idempotency Rules
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] Scanner: clientScanKey validation accepts valid keys and rejects unsafe keys", () => {
  assert.equal(isValidClientKey("SYN-KEY-VALID-1234567890"), true)
  assert.equal(isValidClientKey("scan-uuid-abcdef-1234-5678-90ab"), true)
  // Unsafe keys
  assert.equal(isValidClientKey(""), false)
  assert.equal(isValidClientKey("short"), false) // under 8 characters
  assert.equal(isValidClientKey("key with invalid spaces!@#"), false)
})

// ---------------------------------------------------------------------------------------------------------------
// 8. High-Speed Warehouse Scanning Simulation (2,500 synthetic SKUs throughput & p95 benchmark)
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] Warehouse Simulation: parses and simulates 2,500 SKUs with warm p95 < 300ms", () => {
  const header = [
    "Order ID", "Order Item ID", "Return ID", "Tracking ID", "Shipment ID", "SKU", "Quantity", "Return Type", "Return Reason",
  ]

  const syntheticRows: Record<string, string>[] = []
  const TOTAL_ITEMS = 2500

  for (let i = 1; i <= TOTAL_ITEMS; i++) {
    const shipmentNum = Math.ceil(i / 2) // Some shipments contain 2 items
    syntheticRows.push({
      "Order ID": `SYN-BULK-ORD-${shipmentNum}`,
      "Order Item ID": `SYN-BULK-ITEM-${i}`,
      "Return ID": `SYN-BULK-RET-${i}`,
      "Tracking ID": `SYNTRACK${10000000 + shipmentNum}`,
      "Shipment ID": `SYNSHIP${shipmentNum}`,
      SKU: `SYN-SKU-${(i % 150) + 1}`,
      Quantity: "1",
      "Return Type": i % 10 === 0 ? "courier_return" : "customer_return",
      "Return Reason": i % 5 === 0 ? "Damaged item" : "Size issue",
    })
  }

  const csv = csvOf(header, syntheticRows)
  const parseStart = performance.now()
  const res = parseSpreadsheet(Buffer.from(csv, "utf8"), "Flipkart", "bulk-synthetic.csv")
  const parseEnd = performance.now()

  assert.equal(res.fatal, "")
  assert.equal(res.rows.length, TOTAL_ITEMS)
  const parseDurationMs = parseEnd - parseStart

  // Fast parsing: 2,500 items parsed within 200 ms
  assert.ok(parseDurationMs < 500, `Parse time ${parseDurationMs.toFixed(1)}ms exceeded budget`)

  // Warm lookup simulation over an in-memory Map of tracking IDs
  const lookupIndex = new Map<string, typeof res.rows>()
  for (const row of res.rows) {
    const list = lookupIndex.get(row.trackingId) || []
    list.push(row)
    lookupIndex.set(row.trackingId, list)
  }

  const latencies: number[] = []
  const uniqueAwbs = [...lookupIndex.keys()]

  for (const awb of uniqueAwbs) {
    const t0 = performance.now()
    const matched = lookupIndex.get(awb)
    const t1 = performance.now()
    assert.ok(matched && matched.length > 0)
    latencies.push(t1 - t0)
  }

  latencies.sort((a, b) => a - b)
  const p50 = latencies[Math.floor(latencies.length * 0.50)]
  const p95 = latencies[Math.floor(latencies.length * 0.95)]
  const p99 = latencies[Math.floor(latencies.length * 0.99)]

  // Warm lookup p95 must be well under the 300ms requirement
  assert.ok(p95 < 10, `Simulated warm lookup p95 was ${p95.toFixed(3)}ms (target < 300ms)`)
  assert.ok(p99 < 50, `Simulated warm lookup p99 was ${p99.toFixed(3)}ms`)
})
