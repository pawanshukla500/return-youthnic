// SYNTHETIC FIXTURES ONLY. The workbooks are built here, in memory, with the same library the importer reads with.
// Every identifier is invented (SYN-* values, and made-up digits). The number cases reproduce what the screenshots of the
// Amazon and Flipkart workbooks show: a number with 15 or more digits, which Excel keeps only to 15 digits.
//
// Run: npm test

import { test } from "node:test"
import assert from "node:assert/strict"
import * as XLSX from "xlsx"
import { parseSpreadsheet, rowStatus } from "../sheets.js"

// The Flipkart columns the parser reads (the real export has more, which are not needed here).
const FLIPKART_HEADER = [
  "Location ID", "Order ID", "Order Item ID", "Return ID", "Tracking ID", "Shipment ID", "SKU", "Product",
  "Quantity", "Return Type", "Return Reason", "Return Sub-reason", "Vendor Name", "Comments",
]
const AMAZON_HEADER = [
  "Return Type", "Customer Order ID", "Shipment ID", "SKU", "mSKU", "ASIN", "Units", "Forward Leg Tracking ID",
  "Reverse Leg Tracking ID", "RMA ID", "Carrier", "Return Reason",
]
const AJIO_HEADER = [
  "Return AWB No", "Cust Order No", "RETURN ORDER NUMBER", "SELLER SKU", "JioCode", "Return QTY",
  "Cust Return Reason", "Return Type",
]
const MEESHO_HEADER = [
  "S No", "Product Name", "SKU", "Variation", "Meesho PID", "Category", "Qty", "Order Number",
  "Suborder Number", "Dispatch Date", "Return Created Date", "Type of Return", "Sub Type", "Delivered Date",
  "Courier Partner", "AWB Number", "Tracking Link", "Proof of Delivery", "Return Price Type", "Return Reason",
  "Detailed Return Reason", "OTP verified at",
]

// Builds one row in the header's column order. Values are JavaScript values: numbers become numeric cells.
function rowOf(header: string[], values: Record<string, unknown>): unknown[] {
  return header.map((name) => values[name] ?? "")
}

// An .xlsx workbook in memory. Numbers are written as numeric cells, the way a spreadsheet stores them.
function workbook(rows: unknown[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, "Returns")
  return Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }))
}

function csvBuffer(lines: string[]): Buffer {
  return Buffer.from(lines.join("\n"), "utf8")
}

// ---------- Flipkart: the workbook in the screenshot ----------

test("[synthetic] Flipkart xlsx: an 18-digit Order Item ID stored as a number is blanked and warned, the row stays valid", () => {
  const buffer = workbook([
    FLIPKART_HEADER,
    rowOf(FLIPKART_HEADER, {
      "Order ID": "SYNOD0001",
      "Order Item ID": 338807258310443100,
      "Tracking ID": "SYNFMPC0001",
      SKU: "SYN-SKU-F1",
      Quantity: 1,
      "Return Type": "courier_return",
      "Return Reason": "order_cancelled",
    }),
  ])
  const result = parseSpreadsheet(buffer, "Flipkart", "synthetic.xlsx")
  assert.equal(result.fatal, "")
  const row = result.rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.trackingId, "SYNFMPC0001", "a text tracking ID is read as typed")
  assert.equal(row.orderLineId, "", "a number that cannot be trusted is never used as an order line")
  assert.ok(row.warnings.some((warning) => /Order Item ID is stored as a number in the file/.test(warning)))
})

test("[synthetic] Flipkart xlsx: a 26-digit Return ID stored as a number is blanked and warned", () => {
  const buffer = workbook([
    FLIPKART_HEADER,
    rowOf(FLIPKART_HEADER, {
      "Order ID": "SYNOD0002",
      "Order Item ID": "SYN000000000000000002",
      "Return ID": 10478220380174340824526848,
      "Tracking ID": "SYNFMPC0002",
      SKU: "SYN-SKU-F2",
      Quantity: 1,
      "Return Type": "customer_return",
      "Return Reason": "mind_changed",
    }),
  ])
  const row = parseSpreadsheet(buffer, "Flipkart", "synthetic.xlsx").rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.returnEventId, "")
  assert.ok(row.warnings.some((warning) => /Return ID is stored as a number/.test(warning)))
})

test("[synthetic] Flipkart xlsx: a Tracking ID stored as a 16-digit number is pending, because it is the lookup key", () => {
  const buffer = workbook([
    FLIPKART_HEADER,
    rowOf(FLIPKART_HEADER, {
      "Order ID": "SYNOD0003",
      "Order Item ID": "SYN000000000000000003",
      "Tracking ID": 9000000000000001,
      SKU: "SYN-SKU-F3",
      Quantity: 1,
      "Return Type": "courier_return",
      "Return Reason": "order_cancelled",
    }),
  ])
  const row = parseSpreadsheet(buffer, "Flipkart", "synthetic.xlsx").rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.trackingId, "")
  assert.equal(rowStatus(row), "pending")
  assert.match(row.pendingReasons.join(" "), /Tracking ID is stored as a number in the file/)
  assert.match(row.pendingReasons.join(" "), /Re-save the file as CSV with IDs as text/)
})

test("[synthetic] a whole number of at most 15 digits in an identifier column is exact and accepted", () => {
  const buffer = workbook([
    FLIPKART_HEADER,
    rowOf(FLIPKART_HEADER, {
      "Order ID": "SYNOD0004",
      "Order Item ID": "SYN000000000000000004",
      "Tracking ID": 999999999999999,
      SKU: "SYN-SKU-F4",
      Quantity: 1,
      "Return Type": "courier_return",
      "Return Reason": "order_cancelled",
    }),
  ])
  const row = parseSpreadsheet(buffer, "Flipkart", "synthetic.xlsx").rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.trackingId, "999999999999999")
})

test("[synthetic] a non-whole number in a tracking column is pending, not a rounded value", () => {
  const buffer = workbook([
    FLIPKART_HEADER,
    rowOf(FLIPKART_HEADER, {
      "Order ID": "SYNOD0005",
      "Order Item ID": "SYN000000000000000005",
      "Tracking ID": 1234.5,
      SKU: "SYN-SKU-F5",
      Quantity: 1,
      "Return Type": "courier_return",
      "Return Reason": "order_cancelled",
    }),
  ])
  const row = parseSpreadsheet(buffer, "Flipkart", "synthetic.xlsx").rows[0]
  assert.equal(row.valid, true)
  assert.equal(rowStatus(row), "pending")
  assert.match(row.pendingReasons.join(" "), /Tracking ID is stored as a number/)
})

// ---------- Amazon: the workbook in the screenshot ----------

test("[synthetic] Amazon xlsx: 12- and 14-digit AWB numbers are exact, and a text AWB in the same column is kept", () => {
  const buffer = workbook([
    AMAZON_HEADER,
    rowOf(AMAZON_HEADER, {
      "Customer Order ID": "SYN-AMZ-1",
      "Shipment ID": "SYNSHIP1",
      Units: 1,
      "Reverse Leg Tracking ID": 629768421577,
      "Forward Leg Tracking ID": 368061672124,
      "Return Type": "CUSTOMER_RETURN",
      mSKU: "SYN-MSKU-1",
      ASIN: "SYNASIN01",
      "Return Reason": "Too large",
    }),
    rowOf(AMAZON_HEADER, {
      "Customer Order ID": "SYN-AMZ-2",
      "Shipment ID": "SYNSHIP2",
      Units: 1,
      "Reverse Leg Tracking ID": "AW794044214IN",
      "Forward Leg Tracking ID": "",
      "Return Type": "UNDELIVERED",
      mSKU: "SYN-MSKU-2",
      ASIN: "SYNASIN02",
      "Return Reason": "",
    }),
    rowOf(AMAZON_HEADER, {
      "Customer Order ID": "SYN-AMZ-3",
      "Shipment ID": "SYNSHIP3",
      Units: 1,
      "Reverse Leg Tracking ID": 14931238950331,
      "Return Type": "CUSTOMER_RETURN",
      mSKU: "SYN-MSKU-3",
      ASIN: "SYNASIN03",
      "Return Reason": "Damaged",
    }),
  ])
  const rows = parseSpreadsheet(buffer, "Amazon", "synthetic.xlsx").rows
  assert.equal(rows.length, 3)
  assert.equal(rows[0].trackingId, "629768421577")
  assert.equal(rows[0].forwardTrackingId, "368061672124")
  assert.equal(rows[0].valid, true)
  assert.equal(rows[1].trackingId, "AW794044214IN")
  assert.equal(rows[1].valid, true)
  assert.equal(rows[2].trackingId, "14931238950331")
  assert.equal(rows[2].valid, true)
  assert.equal(rows[2].returnType, "Customer Return")
})

// ---------- Meesho: the 16-digit AWB and the Delhivery link ----------

function meeshoWorkbook(awb: unknown, link: string): Buffer {
  return workbook([
    ["Supplier ID", "10874"],
    [],
    MEESHO_HEADER,
    rowOf(MEESHO_HEADER, {
      "S No": 1,
      "Product Name": "SYN Product M",
      SKU: "SYN-SKU-M1",
      Variation: "M",
      Qty: 1,
      "Order Number": "SYN100000000000000001",
      "Suborder Number": "SYN100000000000000001_1",
      "Type of Return": "Courier Return (RTO)",
      "Courier Partner": "Delhivery",
      "AWB Number": awb,
      "Tracking Link": link,
      "Return Reason": "Changed my mind",
      "Detailed Return Reason": "Did not like the fit",
    }),
  ])
}

test("[synthetic] Meesho xlsx: a 16-digit AWB that the Delhivery link confirms as its 15-digit rounding is accepted, with the link value", () => {
  const row = parseSpreadsheet(
    meeshoWorkbook(1490711860180880, "https://track.delhivery.com/p/1490711860180882"),
    "Meesho",
    "synthetic.xlsx",
  ).rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.trackingId, "1490711860180882")
  assert.equal(row.csvTrackingId, "1490711860180880", "the stored number is kept for audit")
  assert.equal(row.trackingValidation, "mismatch_resolved")
  assert.equal(row.identifierSource, "tracking_link")
})

test("[synthetic] Meesho xlsx: a 16-digit AWB that the link confirms exactly is accepted", () => {
  const row = parseSpreadsheet(
    meeshoWorkbook(1490711860765426, "https://www.delhivery.com/track/package/1490711860765426"),
    "Meesho",
    "synthetic.xlsx",
  ).rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.trackingId, "1490711860765426")
  assert.equal(row.trackingValidation, "match")
})

test("[synthetic] Meesho xlsx: a 16-digit AWB that Excel truncated to 15 digits (ending in 0) is recovered from Delhivery link", () => {
  const row = parseSpreadsheet(
    meeshoWorkbook(1490711818486600, "https://track.delhivery.com/p/1490711818486605"),
    "Meesho",
    "synthetic.xlsx",
  ).rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.trackingId, "1490711818486605")
  assert.equal(row.csvTrackingId, "1490711818486600", "the stored Excel number is preserved for audit")
  assert.equal(row.trackingValidation, "mismatch_resolved")
  assert.equal(row.identifierSource, "tracking_link")
})

test("[synthetic] Meesho xlsx: a 16-digit AWB stored as a number with no verified link is a row error", () => {
  const row = parseSpreadsheet(meeshoWorkbook(1490711860180880, ""), "Meesho", "synthetic.xlsx").rows[0]
  assert.equal(row.valid, false)
  assert.match(row.error, /AWB 1490711860180880 is stored as a number in the file/)
  assert.match(row.error, /no verified tracking link confirms its digits/)
})

test("[synthetic] Meesho xlsx: a 16-digit AWB stored as a number that the link does not confirm is a row error", () => {
  const row = parseSpreadsheet(
    meeshoWorkbook(1490711860180880, "https://track.delhivery.com/p/1490711860765426"),
    "Meesho",
    "synthetic.xlsx",
  ).rows[0]
  assert.equal(row.valid, false)
  assert.equal(row.trackingId, "1490711860180880")
})

// ---------- Ajio: text identifiers, unchanged ----------

test("[synthetic] Ajio xlsx with text identifiers keeps every identifier as typed", () => {
  const buffer = workbook([
    AJIO_HEADER,
    rowOf(AJIO_HEADER, {
      "Return AWB No": "SYNAJ0001",
      "Cust Order No": "SYN-AJ-ORDER-1",
      "RETURN ORDER NUMBER": "SYN-RO-1",
      "SELLER SKU": "SYN-AJ-SKU",
      JioCode: "SYN-JIO-1",
      "Return QTY": 1,
      "Cust Return Reason": "Size issue",
      "Return Type": "RVP",
    }),
  ])
  const row = parseSpreadsheet(buffer, "Ajio", "synthetic.xlsx").rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.trackingId, "SYNAJ0001")
  assert.equal(row.orderId, "SYN-AJ-ORDER-1")
  assert.equal(row.displayOrderItemId, "SYN-RO-1")
  assert.equal(row.warnings.length, 0)
})

// ---------- CSV exported from a spreadsheet: scientific text ----------

test("[synthetic] CSV: an Order Item ID already in scientific notation is blanked and warned, not stored", () => {
  const csv = csvBuffer([
    FLIPKART_HEADER.join(","),
    "SYN-LOC-1,SYNOD0006,3.39E+17,SYNRET-ID-6,SYNFMPC0006,SYN-SHIP-6,SYN-SKU-F6,SYN Product,1,courier_return,order_cancelled,,synlogistics,",
  ])
  const row = parseSpreadsheet(csv, "Flipkart", "synthetic.csv").rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.orderLineId, "")
  assert.ok(row.warnings.some((warning) => /Order Item ID "3.39E\+17" is in scientific notation/.test(warning)))
})
