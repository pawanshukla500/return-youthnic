// SYNTHETIC FIXTURES ONLY. Invented order rows with SYN-* values and made-up buyer fields.
// These tests check normalization, buyer-field removal, and lookup-key cleaning. They do not call OMSGuru.
//
// Run: npm test

import { test } from "node:test"
import assert from "node:assert/strict"
import type { OmsRow } from "../oms/client.js"
import { normalizeOrderRow, redactPersonalData, usableLookupKey } from "../oms/orders.js"

const syntheticOrder: OmsRow = {
  channel: "SYN Channel",
  warehouse: "SYN Warehouse",
  invoice_id: "SYN-INV-1",
  invoice_date: 1791373407,
  shipment_tracker: "SYNSHIP0001",
  order_items: [
    { channel_order_id: "SYN-OID-1", channel_sub_order_id: "SYN-SUB-2", sku_code: "syn-b", status: "Packed" },
    { channel_order_id: "SYN-OID-1", channel_sub_order_id: "SYN-SUB-1", sku_code: "SYN-A", status: "Shipped" },
    { channel_order_id: "SYN-OID-1", channel_sub_order_id: "SYN-SUB-1", sku_code: "SYN-A", status: "Shipped" },
  ],
  customer_name: "Synthetic Buyer",
  customer_phone: "0000000000",
  buyer_email: "synthetic@example.invalid",
  shipping_address: "Synthetic street 1",
}

test("[synthetic] normalizeOrderRow reads the order id, unique sorted sub-order ids, and item statuses", () => {
  const n = normalizeOrderRow(syntheticOrder)
  assert.equal(n.channelOrderId, "SYN-OID-1")
  assert.equal(n.subOrderIds, "SYN-SUB-1,SYN-SUB-2")
  assert.equal(n.itemStatuses, "Packed;Shipped;Shipped")
  assert.equal(n.skus, "syn-b,SYN-A")
  assert.equal(n.shipmentTracker, "SYNSHIP0001")
  assert.equal(n.invoiceId, "SYN-INV-1")
  assert.equal(n.channelLabel, "SYN Channel")
  assert.equal(n.warehouse, "SYN Warehouse")
})

test("[synthetic] normalizeOrderRow reads invoice_date as Unix seconds and leaves a bad value empty", () => {
  assert.equal(normalizeOrderRow(syntheticOrder).invoiceDate?.getTime(), 1791373407 * 1000)
  assert.equal(normalizeOrderRow({ ...syntheticOrder, invoice_date: "not a date" }).invoiceDate, null)
})

test("[synthetic] normalizeOrderRow accepts order_items as an object keyed by id", () => {
  const row: OmsRow = {
    order_items: { "1": { channel_order_id: "SYN-OID-9", channel_sub_order_id: "SYN-SUB-9", status: "Delivered" } },
  }
  const n = normalizeOrderRow(row)
  assert.equal(n.channelOrderId, "SYN-OID-9")
  assert.equal(n.subOrderIds, "SYN-SUB-9")
  assert.equal(n.itemStatuses, "Delivered")
})

test("[synthetic] redactPersonalData removes buyer and contact fields, including nested ones, and keeps order fields", () => {
  const redacted = redactPersonalData({
    ...syntheticOrder,
    order_items: [{ sku_code: "SYN-A", buyer_phone: "0000000000", status: "Shipped" }],
  }) as Record<string, unknown>
  assert.equal("customer_name" in redacted, false)
  assert.equal("customer_phone" in redacted, false)
  assert.equal("buyer_email" in redacted, false)
  assert.equal("shipping_address" in redacted, false)
  assert.equal(redacted.shipment_tracker, "SYNSHIP0001")
  const item = (redacted.order_items as Record<string, unknown>[])[0]
  assert.equal("buyer_phone" in item, false)
  assert.equal(item.status, "Shipped")
})

test("[synthetic] usableLookupKey strips wrappers, rejects scientific notation and placeholders", () => {
  assert.equal(usableLookupKey('="0012345"'), "0012345")
  assert.equal(usableLookupKey("'SYN 77"), "SYN77")
  assert.equal(usableLookupKey("1.00346E+11"), "")
  assert.equal(usableLookupKey("—"), "")
  assert.equal(usableLookupKey("   "), "")
})
