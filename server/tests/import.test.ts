// SYNTHETIC FIXTURES ONLY. Every row below is invented for these tests (SYN-* values, invented AWBs and IDs, and
// invented 16-digit numbers built the way a spreadsheet rounds them). The header lines of the Flipkart and Amazon
// tests are copied from the sample files on the Desktop (Flipkart.csv, Amazon.csv), so those tests check the real
// column names. The seller/supplier codes (10708, 45833, 10874) are the ones server/import-profiles.ts already holds.
//
// These tests check the parser in server/sheets.ts. They never touch the database.
//
// Run: npm test   (Node's built-in test runner through tsx)

import { test } from "node:test"
import assert from "node:assert/strict"
import { isScannableRow, parseProductMaster, parseSpreadsheet, previewProductMaster, productMasterTemplateCsv, rowStatus } from "../sheets.js"

// The 40 headers of the Myntra seller returns report, in column order (A to AN). Myntra EJ .xlsx could not be read, so
// this is the header set the profile was written against, not a checked file.
const MYNTRA_HEADER = [
  "seller_id", "warehouse_id", "partner_warehouse_code", "model", "myntra_sku_code", "seller_sku_code",
  "style_id", "sku_id", "brand", "order_created_date", "inscanned_on", "fmpu_date", "order_delivered_date",
  "return_created_date", "refunded_date", "order_rto_date", "is_refunded", "exchange_id", "order_id",
  "order_group_id", "order_line_id", "seller_order_id", "type", "status", "store_packet_id",
  "seller_packet_id_fk", "quantity", "return_id", "return_mode", "return_reason", "return_status",
  "forward_tracking_number", "return_tracking_number", "master_bag_id", "lmdo_status",
  "lmdo_last_modified_on", "gatepass_id", "gatepass_status", "gatepass_type", "gatepass_lastmodified",
]

// Meesho returns report header, as in Meesho.csv (22 columns, after a supplier block). Confirmed by the sample.
const MEESHO_HEADER = [
  "S No", "Product Name", "SKU", "Variation", "Meesho PID", "Category", "Qty", "Order Number",
  "Suborder Number", "Dispatch Date", "Return Created Date", "Type of Return", "Sub Type", "Delivered Date",
  "Courier Partner", "AWB Number", "Tracking Link", "Proof of Delivery", "Return Price Type", "Return Reason",
  "Detailed Return Reason", "OTP verified at",
]

// Flipkart returns report header, abbreviated to the columns the parser reads plus two others.
const FLIPKART_HEADER = [
  "Location ID", "Order ID", "Order Item ID", "Return ID", "Tracking ID", "Shipment ID", "SKU", "Product",
  "Quantity", "Return Type", "Return Reason", "Return Sub-reason", "Vendor Name", "Comments",
]

// The full Flipkart.csv header, copied from the sample on the Desktop (43 columns).
const FLIPKART_REAL_HEADER = [
  "Location ID", "Order ID", "Order Item ID", "Return ID", "Tracking ID", "Shipment ID",
  "Replacement Order Item ID", "SKU", "FSN", "Product", "Total Price", "Quantity", "FF Type",
  "Return Requested Date", "Return Approval Date", "Completed Date", "Out For Delivery Date",
  "Return Delivery Promise Date", "Picked Up Date", "Shipment Type", "Return Status", "Completion Status",
  "Return Type", "Return Reason", "Return Sub-reason", "Comments", "Vendor Name", "Location Name", "Flyer Status",
  "Flyer Captured", "Flyer Actual", "Delivery Proof Time", "OBD Eligible", "OBD Status", "OBD Remarks",
  "Delivery Proof OTC", "Bag Tracking ID", "Order Type", "Customer GSTIN", "Customer Company Name", "IRN Number",
  "Invoice Number", "Invoice Date",
]

// The full Amazon.csv header, copied from the sample on the Desktop (21 columns).
const AMAZON_REAL_HEADER = [
  "Return Type", "Customer Order ID", "Shipment ID", "SKU", "mSKU", "ASIN", "External ID1", "External ID2",
  "External ID3", "Units", "Forward Leg Tracking ID", "Reverse Leg Tracking ID", "RMA ID", "Return Status",
  "Carrier", "Pick -up date", "Last Updated On", "Returned with OTP", "Days In-transit",
  "Days Since Return Complete", "Return Reason",
]

// Ajio and Amazon headers, as written in the Phase 1 specification. Ajio is not confirmed by a sample. The return type
// column name is a guess (see server/import-profiles.ts), so these fixtures use "Return Type" for it.
const AJIO_HEADER = [
  "Return AWB No", "Cust Order No", "RETURN ORDER NUMBER", "SELLER SKU", "JioCode", "Return QTY",
  "Cust Return Reason", "Return Type",
]
const AMAZON_HEADER = [
  "Reverse Leg Tracking ID", "Customer Order ID", "Shipment ID", "mSKU", "ASIN", "Units", "Return Reason",
  "Return Type",
]

const VB = "Myntra VB"
const MEESHO = "Meesho"
const FLIPKART = "Flipkart"
const AJIO = "Ajio"
const AMAZON = "Amazon"

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvLine(cells: string[]) {
  return cells.map(csvCell).join(",")
}

function csvOf(headers: string[], rows: Record<string, string>[]) {
  const lines = [headers.map(csvCell).join(",")]
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","))
  return lines.join("\n")
}

function myntraCsv(rows: Record<string, string>[], headers: string[] = MYNTRA_HEADER) {
  return csvOf(headers, rows)
}

// One synthetic valid VB return row. Callers override only the fields a test is about.
function synth(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    seller_id: "10708",
    seller_sku_code: "SYN-SKU-001",
    order_id: "SYN-ORDER-0001",
    order_line_id: "SYN-LINE-0001",
    type: "Return",
    quantity: "1",
    return_reason: "Synthetic reason",
    forward_tracking_number: "SYNFWD0001",
    return_tracking_number: "SYNRET0001",
    ...overrides,
  }
}

function parseMyntra(csv: string, marketplace = VB) {
  return parseSpreadsheet(Buffer.from(csv, "utf8"), marketplace, "synthetic.csv")
}

// Meesho: a supplier block above the header row, then the table. Pass supplier null to omit it.
function meeshoCsv(rows: Record<string, string>[], options: { supplier?: string | null; headers?: string[] } = {}) {
  const headers = options.headers ?? MEESHO_HEADER
  const lines = ["", csvLine(["Meesho Supplier Panel"])]
  if (options.supplier !== null) {
    lines.push(csvLine(["Supplier ID", options.supplier ?? "10874"]))
  }
  lines.push(csvLine(["Supplier Registered Name", "SYN Supplier"]))
  lines.push("")
  lines.push(headers.map(csvCell).join(","))
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","))
  return lines.join("\n")
}

function meeshoRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "S No": "1",
    "Product Name": "SYN Product M",
    SKU: "SYN-SKU-M1",
    Qty: "1",
    "Order Number": "SYN100000000000000001",
    "Suborder Number": "SYN100000000000000001_1",
    "Type of Return": "Customer Return",
    "Courier Partner": "SynCourier",
    "AWB Number": "SYNR0001FPL",
    "Return Reason": "Changed my mind",
    "Detailed Return Reason": "Did not like the fit",
    ...overrides,
  }
}

// Flipkart: one header row, comments may span lines (quoted).
function flipkartCsv(rows: Record<string, string>[], headers: string[] = FLIPKART_HEADER) {
  return csvOf(headers, rows)
}

function flipkartRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Location ID": "SYN-LOC-1",
    "Order ID": "SYNOD0001",
    "Order Item ID": "SYN000000000000000001",
    "Return ID": "SYNRET-ID-0001",
    "Tracking ID": "SYNFMPC0001",
    "Shipment ID": "SYN-SHIP-0001",
    SKU: "SYN-SKU-F1",
    Product: "SYN Product F",
    Quantity: "1",
    "Return Type": "courier_return",
    "Return Reason": "order_cancelled",
    "Return Sub-reason": "different_size_color",
    "Vendor Name": "synlogistics",
    Comments: "",
    ...overrides,
  }
}

// ---------- Myntra ----------

test("[synthetic] Myntra: rejects a file with a missing required header and names the header", () => {
  const headers = MYNTRA_HEADER.filter((header) => header !== "return_reason")
  const result = parseMyntra(myntraCsv([synth()], headers))
  assert.equal(result.profileId, "myntra-seller-returns")
  assert.equal(result.rows.length, 0)
  assert.match(result.fatal, /return_reason/)
})

test("[synthetic] Myntra: rejects the whole file when one row has the other account's seller_id", () => {
  const result = parseMyntra(
    myntraCsv([synth(), synth({ seller_id: "45833", return_tracking_number: "SYNRET0002" })]),
  )
  assert.equal(result.rows.length, 0)
  assert.match(result.fatal, /45833/)
  assert.match(result.fatal, /10708/)
})

test("[synthetic] Myntra: accepts a file whose seller_id matches the selected account", () => {
  const result = parseMyntra(myntraCsv([synth()]), VB)
  assert.equal(result.fatal, "")
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].valid, true)
})

test("[synthetic] Myntra: uses the return tracking number as the key and keeps the forward number as the alternate", () => {
  const row = parseMyntra(myntraCsv([synth()])).rows[0]
  assert.equal(row.trackingId, "SYNRET0001")
  assert.equal(row.altTrackingId, "SYNFWD0001")
  assert.equal(row.forwardTrackingId, "SYNFWD0001")
  assert.equal(row.trackingSource, "return_tracking")
})

test("[synthetic] Myntra: uses the forward number when the return tracking number is blank, and says so", () => {
  const row = parseMyntra(myntraCsv([synth({ return_tracking_number: "", forward_tracking_number: "SYNFWD0009" })])).rows[0]
  assert.equal(row.trackingId, "SYNFWD0009")
  assert.equal(row.trackingSource, "forward_tracking")
  assert.equal(row.valid, true)
})

test("[synthetic] Myntra: leaves the alternate empty when both tracking columns hold the same value", () => {
  const row = parseMyntra(myntraCsv([synth({ forward_tracking_number: "SYNRET0001" })])).rows[0]
  assert.equal(row.altTrackingId, "")
})

test("[synthetic] Myntra: maps Return to Customer Return and RTO to RTO", () => {
  const customer = parseMyntra(myntraCsv([synth({ type: "Return" })])).rows[0]
  assert.equal(customer.returnType, "Customer Return")
  assert.equal(customer.returnTypeRaw, "Return")
  const rto = parseMyntra(myntraCsv([synth({ type: "RTO", return_tracking_number: "" })])).rows[0]
  assert.equal(rto.returnType, "RTO")
  assert.equal(rto.valid, true)
})

test("[synthetic] Myntra: a blank or unknown return type is kept as written and warned, never guessed", () => {
  const blank = parseMyntra(myntraCsv([synth({ type: "" })])).rows[0]
  assert.equal(blank.valid, true)
  assert.equal(blank.returnType, "")
  assert.ok(blank.warnings.some((warning) => /Return type is blank/.test(warning)))

  const unknown = parseMyntra(myntraCsv([synth({ type: "Exchange" })])).rows[0]
  assert.equal(unknown.returnType, "Exchange")
  assert.ok(unknown.warnings.some((warning) => /Unknown return type "Exchange"/.test(warning)))
})

test("[synthetic] Myntra: the SKU identification is myntra_sku_code, and its kind is recorded", () => {
  const row = parseMyntra(myntraCsv([synth({ myntra_sku_code: "SYN-MYN-CODE-1" })])).rows[0]
  assert.equal(row.marketplaceSkuIdentifier, "SYN-MYN-CODE-1")
  assert.equal(row.marketplaceSkuIdentifierKind, "myntra_sku_code")
  assert.equal(row.displayIdentifierKind, "order_line")
})

test("[synthetic] Myntra: the return_id is kept as the return event", () => {
  const row = parseMyntra(myntraCsv([synth({ return_id: "SYN-RET-77" })])).rows[0]
  assert.equal(row.returnEventId, "SYN-RET-77")
})

test("[synthetic] Myntra: classifies a row with no tracking number but an order line as cancelled before dispatch", () => {
  const row = parseMyntra(
    myntraCsv([synth({ return_tracking_number: "", forward_tracking_number: "" })]),
  ).rows[0]
  assert.equal(row.cancelled, true)
  assert.equal(row.valid, true)
  assert.equal(row.returnType, "Courier Return")
  assert.equal(row.returnReason, "Cancel Before Dispached")
})

test("[synthetic] Myntra: keeps a row with no tracking number and no order line pending", () => {
  const row = parseMyntra(
    myntraCsv([synth({ return_tracking_number: "", forward_tracking_number: "", order_line_id: "" })]),
  ).rows[0]
  assert.equal(row.cancelled, false)
  assert.equal(row.valid, true)
  assert.equal(rowStatus(row), "pending")
  assert.match(row.pendingReasons.join(" "), /Missing tracking id/)
})

test("[synthetic] Myntra: keeps a tracking number already in scientific notation pending", () => {
  const row = parseMyntra(
    myntraCsv([synth({ return_tracking_number: "1.00346E+11", forward_tracking_number: "" })]),
  ).rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.trackingId, "")
  assert.equal(rowStatus(row), "pending")
  assert.ok(row.pendingReasons.length > 0)
})

test("[synthetic] Myntra: keeps an order_id in scientific notation as a warning, not an error", () => {
  const row = parseMyntra(myntraCsv([synth({ order_id: "1.00346E+11" })])).rows[0]
  assert.equal(row.valid, true)
  assert.ok(row.warnings.some((warning) => /order_id/.test(warning)))
})

test('[synthetic] Myntra: strips the ="..." wrapper so a tracking number keeps its leading zeros', () => {
  const row = parseMyntra(
    myntraCsv([synth({ return_tracking_number: '="00123"', forward_tracking_number: "" })]),
  ).rows[0]
  assert.equal(row.trackingId, "00123")
})

test("[synthetic] Myntra: refuses a quantity that is blank or not a whole number", () => {
  const blank = parseMyntra(myntraCsv([synth({ quantity: "" })])).rows[0]
  assert.equal(blank.valid, false)
  assert.match(blank.error, /Missing quantity/)
  const fraction = parseMyntra(myntraCsv([synth({ quantity: "1.5" })])).rows[0]
  assert.equal(fraction.valid, false)
  assert.match(fraction.error, /whole number/)
})

// ---------- Repeats: classified, never merged by AWB alone ----------

test("[synthetic] Myntra: an identical repeated row is an exact duplicate, kept but not counted", () => {
  const rows = parseMyntra(myntraCsv([synth(), synth()])).rows
  assert.equal(rows.length, 2)
  assert.equal(rows[0].duplicate, undefined)
  assert.equal(rows[1].duplicate, true)
  assert.equal(rows[1].duplicateKind, "exact_import_row")
  assert.ok(rows[1].warnings.some((warning) => /Not counted again/.test(warning)))
})

test("[synthetic] Myntra: the same AWB, SKU and line with different details is kept as a separate line and flagged", () => {
  const rows = parseMyntra(myntraCsv([synth(), synth({ quantity: "2" })])).rows
  assert.equal(rows.length, 2)
  assert.equal(rows[1].duplicate, undefined, "not merged and not dropped")
  assert.equal(rows[1].qty, 2)
  assert.ok(rows[1].warnings.some((warning) => /Same AWB, SKU and order line/.test(warning)))
})

test("[synthetic] Myntra: a second return event (different return_id) on the same line is flagged as a repeated return", () => {
  const rows = parseMyntra(myntraCsv([synth({ return_id: "SYN-RET-1" }), synth({ return_id: "SYN-RET-2" })])).rows
  assert.equal(rows[1].duplicate, undefined)
  assert.ok(rows[1].warnings.some((warning) => /Second return event \(SYN-RET-2\)/.test(warning)))
})

test("[synthetic] Myntra: several products in one shipment, and several lines of one product, are normal and not flagged", () => {
  const products = parseMyntra(
    myntraCsv([synth(), synth({ seller_sku_code: "SYN-SKU-002", order_line_id: "SYN-LINE-0002" })]),
  ).rows
  assert.equal(products[1].duplicate, undefined)
  assert.equal(products[1].warnings.length, 0)

  const units = parseMyntra(myntraCsv([synth(), synth({ order_line_id: "SYN-LINE-0002" })])).rows
  assert.equal(units[1].duplicate, undefined)
  assert.equal(units[1].warnings.length, 0)
})

test("[synthetic] the row fingerprint is equal for identical rows and different for changed rows", () => {
  const rows = parseMyntra(myntraCsv([synth(), synth(), synth({ quantity: "3" })])).rows
  assert.equal(rows[0].rowFingerprint, rows[1].rowFingerprint)
  assert.notEqual(rows[0].rowFingerprint, rows[2].rowFingerprint)
  assert.equal(rows[2].sourceLineNo, 3)
})

// ---------- Ajio ----------

test("[synthetic] Ajio: maps the return AWB, order, JioCode, quantity; the return order is a display identifier, not a line", () => {
  const csv = csvOf([...AJIO_HEADER, "Return Carrier Name"], [{
    "Return AWB No": "syn-ajio-1",
    "Cust Order No": "SYN-AJ-ORDER",
    "RETURN ORDER NUMBER": "SYN-RO-1",
    "SELLER SKU": "SYN-AJ-SKU",
    JioCode: "SYN-JIO-1",
    "Return QTY": "1",
    "Cust Return Reason": "Size issue",
    "Return Type": "RVP",
    "Return Carrier Name": "SHADOWFAX",
  }])
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), AJIO, "synthetic.csv")
  assert.equal(result.profileId, "ajio-returns")
  assert.equal(result.fatal, "")
  const row = result.rows[0]
  assert.equal(row.trackingId, "SYN-AJIO-1")
  assert.equal(row.orderId, "SYN-AJ-ORDER")
  assert.equal(row.displayOrderItemId, "SYN-RO-1")
  assert.equal(row.displayIdentifierKind, "ajio_return_order_number")
  assert.equal(row.orderLineId, "", "the return order number is never an order line")
  assert.equal(row.channelListingId, "SYN-AJ-SKU")
  assert.equal(row.marketplaceSkuIdentifier, "SYN-JIO-1")
  assert.equal(row.marketplaceSkuIdentifierKind, "jiocode")
  assert.equal(row.qty, 1)
  assert.equal(row.returnReason, "Size issue")
  assert.equal(row.carrierValue, "SHADOWFAX")
  assert.equal(row.courier, "SHADOWFAX")
  assert.equal(row.returnType, "Customer Return")
  assert.equal(row.returnTypeRaw, "RVP")
  assert.equal(row.valid, true)
})

test("[synthetic] Ajio: maps RTO to RTO and REPL to Replacement Order", () => {
  const base = { "Return AWB No": "SYN-AJ-2", "Cust Order No": "SYN-O", "RETURN ORDER NUMBER": "SYN-R", "SELLER SKU": "SYN-S", JioCode: "SYN-J", "Return QTY": "1", "Cust Return Reason": "x" }
  const rows = parseSpreadsheet(
    Buffer.from(csvOf(AJIO_HEADER, [{ ...base, "Return Type": "RTO" }, { ...base, "Return AWB No": "SYN-AJ-3", "Return Type": "REPL" }]), "utf8"),
    AJIO,
    "synthetic.csv",
  ).rows
  assert.equal(rows[0].returnType, "RTO")
  assert.equal(rows[1].returnType, "Replacement Order")
})

test("[synthetic] Ajio: a file without JioCode is refused, and the missing header is named", () => {
  const headers = AJIO_HEADER.filter((header) => header !== "JioCode")
  const result = parseSpreadsheet(Buffer.from(csvOf(headers, []), "utf8"), AJIO, "synthetic.csv")
  assert.equal(result.rows.length, 0)
  assert.match(result.fatal, /jiocode/)
})

test("[synthetic] Ajio: blank AWB and zero quantity remain readable pending rows", () => {
  const csv = csvOf(AJIO_HEADER, [
    {
      "Return AWB No": "",
      "Cust Order No": "SYN-AJ-PENDING-ORDER",
      "RETURN ORDER NUMBER": "SYN-AJ-PENDING-RETURN",
      "SELLER SKU": "SYN-AJ-SKU",
      JioCode: "SYN-JIO",
      "Return QTY": "0",
      "Cust Return Reason": "No quantity supplied",
      "Return Type": "RVP",
    },
  ])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), AJIO, "synthetic.csv").rows[0]

  assert.equal(row.valid, true)
  assert.equal(row.trackingId, "")
  assert.equal(row.qty, 0)
  assert.equal(rowStatus(row), "pending")
  assert.equal(isScannableRow(row), false)
  assert.match(row.pendingReasons.join(" "), /Missing Return AWB No/)
  assert.match(row.pendingReasons.join(" "), /is zero/)
})

// ---------- Amazon ----------

test("[synthetic] Amazon: the real Amazon.csv headers are all recognised, and the forward leg, RMA and carrier are kept", () => {
  const csv = csvOf(AMAZON_REAL_HEADER, [{
    "Return Type": "CUSTOMER_RETURN",
    "Customer Order ID": "SYN-AMZ-ORD",
    "Shipment ID": "SYNSHIP1",
    SKU: "SYN-AMZ-LISTING",
    mSKU: "SYN-MSKU-XL",
    ASIN: "SYNASIN01",
    Units: "1",
    "Forward Leg Tracking ID": "SYNFWD01",
    "Reverse Leg Tracking ID": "SYNREV01",
    "RMA ID": "SYNRMA01",
    Carrier: "SYN Carrier",
    "Return Reason": "Too large",
  }])
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), AMAZON, "synthetic.csv")
  assert.equal(result.profileId, "amazon-returns")
  assert.equal(result.fatal, "")
  const row = result.rows[0]
  assert.equal(row.trackingId, "SYNREV01", "the reverse leg is the lookup AWB")
  assert.equal(row.forwardTrackingId, "SYNFWD01", "the forward leg is kept separately")
  assert.equal(row.altTrackingId, "", "the forward leg is not a scan match for Amazon")
  assert.equal(row.returnEventId, "SYNRMA01")
  assert.equal(row.carrierValue, "SYN Carrier")
  assert.equal(row.returnType, "Customer Return")
  assert.equal(row.returnTypeRaw, "CUSTOMER_RETURN")
})

test("[synthetic] Amazon: Shipment ID is the display identifier only and is never an order line", () => {
  const csv = csvOf(AMAZON_HEADER, [{
    "Reverse Leg Tracking ID": "syn-amz-1",
    "Customer Order ID": "SYN-AMZ-ORDER",
    "Shipment ID": "SYN-SHIP-9",
    mSKU: "SYN-AMZ-SKU",
    ASIN: "SYN-ASIN-1",
    Units: "2",
    "Return Reason": "Damaged",
    "Return Type": "CUSTOMER_RETURN",
  }])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), AMAZON, "synthetic.csv").rows[0]
  assert.equal(row.trackingId, "SYN-AMZ-1")
  assert.equal(row.displayOrderItemId, "SYN-SHIP-9")
  assert.equal(row.displayIdentifierKind, "amazon_shipment_id")
  assert.equal(row.orderLineId, "", "Shipment ID is never an order-line identifier")
  assert.equal(row.marketplaceSkuIdentifier, "SYN-ASIN-1")
  assert.equal(row.marketplaceSkuIdentifierKind, "asin")
  assert.equal(row.qty, 2)
})

test("[synthetic] Amazon: blank and scientific reverse AWBs are pending and never replaced by the forward AWB", () => {
  const csv = csvOf(AMAZON_REAL_HEADER, [
    {
      "Reverse Leg Tracking ID": "",
      "Forward Leg Tracking ID": "SYN-FORWARD-1",
      "Customer Order ID": "SYN-AMZ-ORDER-1",
      "Shipment ID": "SYN-SHIP-1",
      mSKU: "SYN-AMZ-SKU",
      ASIN: "SYN-ASIN",
      Units: "1",
      "Return Reason": "Missing reverse AWB",
      "Return Type": "CUSTOMER_RETURN",
    },
    {
      "Reverse Leg Tracking ID": "3.39123456789012E+17",
      "Forward Leg Tracking ID": "SYN-FORWARD-2",
      "Customer Order ID": "SYN-AMZ-ORDER-2",
      "Shipment ID": "SYN-SHIP-2",
      mSKU: "SYN-AMZ-SKU-2",
      ASIN: "SYN-ASIN-2",
      Units: "1",
      "Return Reason": "Scientific reverse AWB",
      "Return Type": "CUSTOMER_RETURN",
    },
  ])
  const rows = parseSpreadsheet(Buffer.from(csv, "utf8"), AMAZON, "synthetic.csv").rows

  assert.equal(rows.length, 2)
  assert.equal(rows[0].trackingId, "")
  assert.equal(rows[0].forwardTrackingId, "SYN-FORWARD-1")
  assert.equal(rowStatus(rows[0]), "pending")
  assert.equal(isScannableRow(rows[0]), false)
  assert.equal(rows[1].trackingId, "")
  assert.equal(rows[1].csvTrackingId, "3.39123456789012E+17")
  assert.equal(rows[1].forwardTrackingId, "SYN-FORWARD-2")
  assert.equal(rowStatus(rows[1]), "pending")
  assert.equal(isScannableRow(rows[1]), false)
})

test("[synthetic] Amazon: maps UNDELIVERED to RTO", () => {
  const csv = csvOf(AMAZON_HEADER, [{
    "Reverse Leg Tracking ID": "SYN-AMZ-2", "Customer Order ID": "SYN-O", "Shipment ID": "SYN-S", mSKU: "SYN-M",
    ASIN: "SYN-A", Units: "1", "Return Reason": "x", "Return Type": "UNDELIVERED",
  }])
  assert.equal(parseSpreadsheet(Buffer.from(csv, "utf8"), AMAZON, "synthetic.csv").rows[0].returnType, "RTO")
})

// ---------- Meesho ----------

test("[synthetic] Meesho: finds the header below the supplier block and maps the row", () => {
  const csv = meeshoCsv([
    meeshoRow({ "AWB Number": "SYNR0001FPL", "Suborder Number": "SYN100000000000000001_1" }),
    meeshoRow({ "AWB Number": "SYNVLR0002", "Type of Return": "Courier Return (RTO)", "S No": "2", "Suborder Number": "SYN100000000000000002_1" }),
  ])
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv")
  assert.equal(result.profileId, "meesho-returns")
  assert.equal(result.fatal, "")
  assert.equal(result.rows.length, 2)
  const first = result.rows[0]
  assert.equal(first.trackingId, "SYNR0001FPL")
  assert.equal(first.csvTrackingId, "SYNR0001FPL")
  assert.equal(first.orderLineId, "SYN100000000000000001_1")
  assert.equal(first.displayIdentifierKind, "order_line")
  assert.equal(first.orderId, "SYN100000000000000001")
  assert.equal(first.returnReason, "Changed my mind · Did not like the fit")
  assert.equal(first.courier, "SynCourier")
  assert.equal(first.carrierValue, "SynCourier")
  assert.equal(first.trackingValidation, "no_link")
  assert.equal(result.rows[1].trackingId, "SYNVLR0002")
  assert.equal(result.rows[1].returnType, "RTO")
  assert.equal(result.rows[1].returnTypeRaw, "Courier Return (RTO)")
})

test("[synthetic] Meesho: rejects the whole file when the supplier is a different account", () => {
  const csv = meeshoCsv([meeshoRow()], { supplier: "99999" })
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv")
  assert.equal(result.rows.length, 0)
  assert.match(result.fatal, /99999/)
  assert.match(result.fatal, /10874/)
})

test("[synthetic] Meesho: rejects a file with no supplier block, since the account cannot be checked", () => {
  const csv = meeshoCsv([meeshoRow()], { supplier: null })
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv")
  assert.equal(result.rows.length, 0)
  assert.match(result.fatal, /Supplier ID/)
})

test("[synthetic] Meesho: names a missing required header", () => {
  const headers = MEESHO_HEADER.filter((header) => header !== "Suborder Number")
  const csv = meeshoCsv([meeshoRow()], { headers })
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv")
  assert.equal(result.rows.length, 0)
  assert.match(result.fatal, /suborder_number/)
})

test("[synthetic] Meesho: a 16-digit CSV AWB that is the Delhivery link AWB rounded to 15 digits takes the link AWB", () => {
  const csv = meeshoCsv([meeshoRow({
    "AWB Number": "9000000000000000",
    "Tracking Link": "https://track.delhivery.com/p/9000000000000003",
  })])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv").rows[0]
  assert.equal(row.trackingId, "9000000000000003")
  assert.equal(row.csvTrackingId, "9000000000000000", "the CSV value is kept for audit")
  assert.equal(row.urlTrackingId, "9000000000000003")
  assert.equal(row.trackingSource, "tracking_url")
  assert.equal(row.identifierSource, "tracking_link")
  assert.equal(row.trackingValidation, "mismatch_resolved")
  assert.equal(row.trackingUrl, "https://track.delhivery.com/p/9000000000000003")
  assert.ok(row.warnings.some((warning) => /rounded to 15 digits/.test(warning)))
  assert.ok(!row.warnings.some((warning) => /more than 15 digits/.test(warning)), "the link value is not a warning")
})

test("[synthetic] Meesho: a link that agrees with the CSV AWB adds no warning", () => {
  const csv = meeshoCsv([meeshoRow({
    "AWB Number": "9000000000000005",
    "Tracking Link": "https://track.delhivery.com/p/9000000000000005",
  })])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv").rows[0]
  assert.equal(row.trackingId, "9000000000000005")
  assert.equal(row.trackingSource, "tracking_id")
  assert.equal(row.trackingValidation, "match")
  assert.ok(!row.warnings.some((warning) => /more than 15 digits|differs|check the label/.test(warning)))
})

test("[synthetic] Meesho: a Shadowfax link that agrees is a match, read from the trackingId query", () => {
  const csv = meeshoCsv([meeshoRow({
    "AWB Number": "SYNR0001FPL",
    "Tracking Link": "https://track.shadowfax.in/track?order=return&trackingId=SYNR0001FPL",
  })])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv").rows[0]
  assert.equal(row.trackingId, "SYNR0001FPL")
  assert.equal(row.trackingValidation, "match")
  assert.equal(row.carrierFromLink, "Shadowfax")
})

test("[synthetic] Meesho: a different short AWB is kept and flagged for a person to check", () => {
  const csv = meeshoCsv([meeshoRow({
    "AWB Number": "SYNR0009FPL",
    "Tracking Link": "https://track.delhivery.com/p/12345",
  })])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv").rows[0]
  assert.equal(row.trackingId, "SYNR0009FPL")
  assert.equal(row.trackingValidation, "mismatch_kept")
  assert.ok(row.warnings.some((warning) => /differs from the Delhivery tracking link AWB 12345/.test(warning)))
})

test("[synthetic] Meesho: a link from an unverified host is not used and is flagged", () => {
  const csv = meeshoCsv([meeshoRow({
    "AWB Number": "9000000000000001",
    "Tracking Link": "https://example.invalid/p/9000000000000003",
  })])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv").rows[0]
  assert.equal(row.trackingId, "9000000000000001")
  assert.equal(row.trackingSource, "tracking_id")
  assert.equal(row.trackingValidation, "unverified_host")
  assert.ok(row.warnings.some((warning) => /not a verified carrier link/.test(warning)))
})

test("[synthetic] Meesho: a blank AWB is never filled from a tracking link", () => {
  const csv = meeshoCsv([meeshoRow({
    "AWB Number": "",
    "Tracking Link": "https://track.delhivery.com/p/9000000000000003",
  })])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv").rows[0]
  assert.equal(row.valid, false)
  assert.equal(row.trackingId, "")
  assert.equal(row.trackingValidation, "blank_awb")
  assert.match(row.error, /Missing AWB Number/)
})

test("[synthetic] Meesho: SKU and variation are combined without repeating a size already in the SKU", () => {
  const csv = meeshoCsv([
    meeshoRow({ SKU: "SYN-KURTA-RED", Variation: "M" }),
    meeshoRow({ SKU: "SYN-KURTA-RED_M", Variation: "M", "AWB Number": "SYNR0002FPL", "Suborder Number": "SYN100000000000000002_1" }),
    meeshoRow({ SKU: "SYN-KURTA-XM", Variation: "M", "AWB Number": "SYNR0003FPL", "Suborder Number": "SYN100000000000000003_1" }),
  ])
  const rows = parseSpreadsheet(Buffer.from(csv, "utf8"), MEESHO, "synthetic.csv").rows
  assert.equal(rows[0].channelListingId, "SYN-KURTA-RED_M")
  assert.equal(rows[1].channelListingId, "SYN-KURTA-RED_M")
  assert.equal(rows[2].channelListingId, "SYN-KURTA-XM_M")
})

// ---------- Flipkart ----------

test("[synthetic] Flipkart: maps return type, readable reason, carrier, and order item", () => {
  const csv = flipkartCsv([flipkartRow()])
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), FLIPKART, "synthetic.csv")
  assert.equal(result.profileId, "flipkart-returns")
  assert.equal(result.fatal, "")
  const row = result.rows[0]
  assert.equal(row.trackingId, "SYNFMPC0001")
  assert.equal(row.orderId, "SYNOD0001")
  assert.equal(row.orderLineId, "SYN000000000000000001")
  assert.equal(row.displayIdentifierKind, "order_line")
  assert.equal(row.sku, "SYN-SKU-F1")
  assert.equal(row.returnType, "RTO")
  assert.equal(row.returnTypeRaw, "courier_return")
  assert.equal(row.returnReason, "Order cancelled · Different size color")
  assert.equal(row.courier, "synlogistics")
  assert.equal(row.carrierValue, "synlogistics")
  assert.equal(row.returnEventId, "SYNRET-ID-0001")
  assert.equal(row.valid, true)
})

test("[synthetic] Flipkart: maps customer_return to Customer Return", () => {
  const csv = flipkartCsv([flipkartRow({ "Return Type": "customer_return" })])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), FLIPKART, "synthetic.csv").rows[0]
  assert.equal(row.returnType, "Customer Return")
})

test("[synthetic] Flipkart: reads the FSN as the marketplace SKU identification, with its kind", () => {
  const headers = [...FLIPKART_HEADER, "FSN"]
  const csv = flipkartCsv([flipkartRow({ FSN: "SYN-FSN-1" })], headers)
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), FLIPKART, "synthetic.csv").rows[0]
  assert.equal(row.marketplaceSkuIdentifier, "SYN-FSN-1")
  assert.equal(row.marketplaceSkuIdentifierKind, "fsn")
})

test("[synthetic] Flipkart: a row with no Tracking ID is pending, not treated as cancelled", () => {
  const csv = flipkartCsv([flipkartRow({ "Tracking ID": "" })])
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), FLIPKART, "synthetic.csv").rows[0]
  assert.equal(row.valid, true)
  assert.equal(row.cancelled, false)
  assert.equal(rowStatus(row), "pending")
  assert.match(row.pendingReasons.join(" "), /Tracking ID/)
})

test("[synthetic] Flipkart: a comment with a line break inside quotes does not split the row", () => {
  const csv = flipkartCsv([
    flipkartRow({ Comments: "First line\nsecond line, with a comma" }),
    flipkartRow({ "Tracking ID": "SYNFMPC0002", Comments: "" }),
  ])
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), FLIPKART, "synthetic.csv")
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[1].trackingId, "SYNFMPC0002")
})

test("[synthetic] Flipkart: names a missing required header", () => {
  const headers = FLIPKART_HEADER.filter((header) => header !== "Order Item ID")
  const csv = flipkartCsv([flipkartRow()], headers)
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), FLIPKART, "synthetic.csv")
  assert.equal(result.rows.length, 0)
  assert.match(result.fatal, /order_item_id/)
})

test("[synthetic] Flipkart: the full real Flipkart.csv header is accepted, and FSN, Return ID and vendor are read", () => {
  const csv = flipkartCsv([flipkartRow({ FSN: "SYN-FSN-9", "Vendor Name": "flipkartlogistics" })], FLIPKART_REAL_HEADER)
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), FLIPKART, "synthetic.csv")
  assert.equal(result.fatal, "")
  assert.equal(result.rows[0].marketplaceSkuIdentifier, "SYN-FSN-9")
  assert.equal(result.rows[0].carrierValue, "flipkartlogistics")
  assert.equal(result.rows[0].valid, true)
})

// ---------- Generic and product master ----------

test("[synthetic] generic path accepts header aliases and keeps quoted commas inside a field", () => {
  const csv = [
    "Tracking ID,Product SKU,Product Name,Quantity",
    'SYN-AWB-0001,SYN-SKU-A,"Synthetic kurta, set",2',
  ].join("\n")
  // A marketplace with no layout of its own uses the generic aliases.
  const result = parseSpreadsheet(Buffer.from(csv, "utf8"), "Synthetic Channel", "synthetic.csv")
  assert.equal(result.profileId, "generic")
  const row = result.rows[0]
  assert.equal(row.trackingId, "SYN-AWB-0001")
  assert.equal(row.productName, "Synthetic kurta, set")
  assert.equal(row.qty, 2)
  assert.equal(row.valid, true)
})

test("[synthetic] product master reads the catalog columns and keeps the last row per listing", () => {
  const csv = [
    "Marketplace SKU,VB EXPORT SKU's,VB Export Product Category,Weight Slab (kg),COGS (₹),Marketplace",
    "SYN-LIST-1,SYN-MASTER-1,Synthetic Category,0.5,100,myntra",
    "SYN-LIST-1,SYN-MASTER-2,Synthetic Category,0.5,120,myntra",
    ",SYN-MASTER-3,Synthetic Category,0.5,100,all",
  ].join("\n")
  const result = parseProductMaster(Buffer.from(csv, "utf8"), "synthetic-master.csv")
  assert.equal(result.fatal, "")
  assert.equal(result.skipped, 1)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].masterSku, "SYN-MASTER-2")
  assert.equal(result.rows[0].cogs, 120)
})

test("[synthetic] product master rejects a file without the Marketplace SKU column", () => {
  const result = parseProductMaster(Buffer.from("VB EXPORT SKU's\nSYN-MASTER-1", "utf8"), "synthetic-master.csv")
  assert.notEqual(result.fatal, "")
  assert.equal(result.rows.length, 0)
})

test("[synthetic] the product master template is the Product SKU Codes header and has no data rows", () => {
  const result = parseProductMaster(Buffer.from(productMasterTemplateCsv(), "utf8"), "product-sku-master-template.csv")
  assert.equal(result.fatal, "")
  assert.equal(result.rows.length, 0)
})

// The "Product SKU Codes" export: Channel Listing SKU Code, Product SkuCode, Product Category, Channel Image URL.
test("[synthetic] product master reads the Product SKU Codes layout and its image link", () => {
  const csv = [
    "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL",
    "SYN-LIST-1,SYN-MASTER-1,Synthetic Saree,https://img.example.invalid/syn-1.jpg",
    "SYN-LIST-2,SYN-MASTER-2,Synthetic Kurta,",
  ].join("\n")
  const result = parseProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv")
  assert.equal(result.fatal, "")
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].listingSku, "SYN-LIST-1")
  assert.equal(result.rows[0].masterSku, "SYN-MASTER-1")
  assert.equal(result.rows[0].category, "Synthetic Saree")
  assert.equal(result.rows[0].imageUrl, "https://img.example.invalid/syn-1.jpg")
  assert.equal(result.rows[1].imageUrl, "")
  assert.equal(result.invalidImages, 0)
})

test("[synthetic] product master leaves a non-http image link blank and counts it", () => {
  const csv = [
    "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL",
    "SYN-LIST-1,SYN-MASTER-1,Synthetic Saree,not-a-link",
  ].join("\n")
  const result = parseProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv")
  assert.equal(result.fatal, "")
  assert.equal(result.rows[0].imageUrl, "")
  assert.equal(result.invalidImages, 1)
})

test("[synthetic] product master preview counts listings, masters and image links", () => {
  const csv = [
    "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL",
    "SYN-LIST-1,SYN-MASTER-1,Synthetic Saree,https://img.example.invalid/syn-1.jpg",
    "SYN-LIST-2,SYN-MASTER-1,Synthetic Saree,https://img.example.invalid/syn-1.jpg",
    "SYN-LIST-3,SYN-MASTER-2,Synthetic Kurta,",
  ].join("\n")
  const preview = previewProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv")
  assert.equal(preview.fatal, "")
  assert.equal(preview.rows, 3)
  assert.equal(preview.listings, 3)
  assert.equal(preview.masters, 2)
  assert.equal(preview.withImage, 2)
  assert.equal(preview.withoutImage, 1)
  assert.equal(preview.categories, 2)
  assert.equal(preview.sample.length, 3)
})

test("[synthetic] product master preview reports a fatal when the two SKU columns are the same", () => {
  const csv = ["Product SkuCode,Product SkuCode\nSYN-A,SYN-B"].join("\n")
  const preview = previewProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv")
  assert.notEqual(preview.fatal, "")
  assert.equal(preview.rows, 0)
})

test("[synthetic] product master reports a listing SKU that the file gives two product SKUs for", () => {
  const csv = [
    "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL",
    "SYN-LIST-1,SYN-MASTER-1,Synthetic Saree,",
    "SYN-LIST-1,SYN-MASTER-2,Synthetic Saree,",
  ].join("\n")
  const result = parseProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv")
  assert.equal(result.fatal, "")
  assert.equal(result.rows.length, 1)
  // The last row wins, and the conflict is reported rather than dropped.
  assert.equal(result.rows[0].masterSku, "SYN-MASTER-2")
  assert.equal(result.conflictCount, 1)
  assert.deepEqual(result.conflicts[0].masterSkus.sort(), ["SYN-MASTER-1", "SYN-MASTER-2"])
})

test("[synthetic] product master reports a conflict when two SKUs differ only by a space", () => {
  const csv = [
    "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL",
    "SYN-LIST1,SYN-MASTER-A,Synthetic Saree,",
    "SYN-LIST 1,SYN-MASTER-B,Synthetic Saree,",
  ].join("\n")
  const result = parseProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv")
  assert.equal(result.rows.length, 1)
  assert.equal(result.conflictCount, 1)
})

test("[synthetic] product master stores the marketplace chosen for the load", () => {
  const csv = [
    "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL",
    "SYN-LIST-1,SYN-MASTER-1,Synthetic Saree,",
  ].join("\n")
  // The Admin screen (or --marketplace) names the account, so every row is stored for it.
  const result = parseProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv", "Myntra VB")
  assert.equal(result.rows[0].marketplace, "myntra vb")
  // A blank or "all" choice leaves the rows applying to every account.
  assert.equal(parseProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv", "").rows[0].marketplace, "all")
  assert.equal(parseProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv", "all").rows[0].marketplace, "all")
})

test("[synthetic] the chosen marketplace overrides a Marketplace column in the file", () => {
  const csv = [
    "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL,Marketplace",
    "SYN-LIST-1,SYN-MASTER-1,Synthetic Saree,,flipkart",
  ].join("\n")
  const result = parseProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv", "Myntra VB")
  assert.equal(result.rows[0].marketplace, "myntra vb")
})

test("[synthetic] product master preview reports the scope the rows will be stored under", () => {
  const csv = [
    "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL",
    "SYN-LIST-1,SYN-MASTER-1,Synthetic Saree,",
    "SYN-LIST-2,SYN-MASTER-2,Synthetic Kurta,",
  ].join("\n")
  const preview = previewProductMaster(Buffer.from(csv, "utf8"), "synthetic-codes.csv", "Myntra VB")
  assert.deepEqual(preview.scopes, [{ marketplace: "myntra vb", rows: 2 }])
})

test("[synthetic] product master parses Catalogue Listings Master format (#, Listing SKU, Master SKU, Category, Image Link)", () => {
  const csv = [
    "#,Listing SKU,Master SKU,Category,Image Link",
    "1,SYN-LIST-7Y-UQCI,SYN-MASTER-EJ2400,Sarees,https://img.example.invalid/SYN-1.jpg",
    "2,SYN-LIST-A3-100,SYN-MASTER-A3-100,Kurta,https://img.example.invalid/SYN-2.jpg",
    "3,SYN-LIST-COMBO,SYN-MASTER-COMBO,Saree,",
  ].join("\n")
  const result = parseProductMaster(Buffer.from(csv, "utf8"), "Catalogue-Listings-Master.csv", "Amazon")
  assert.equal(result.fatal, "")
  assert.equal(result.rows.length, 3)
  assert.equal(result.rows[0].listingSku, "SYN-LIST-7Y-UQCI")
  assert.equal(result.rows[0].masterSku, "SYN-MASTER-EJ2400")
  assert.equal(result.rows[0].category, "Sarees")
  assert.equal(result.rows[0].imageUrl, "https://img.example.invalid/SYN-1.jpg")
  assert.equal(result.rows[0].marketplace, "amazon")
  assert.equal(result.rows[2].imageUrl, "")
})

