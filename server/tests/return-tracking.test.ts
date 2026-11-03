// SYNTHETIC FIXTURES ONLY. All test values start with SYN-. No real marketplace secrets or customer PII.
// Enforces Myntra SPF Policy v5.1 aging logic, return date calculations, CSV parsing, and Rule 1 account scoping.
//
// Run: npm test

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  calculateReturnDates,
  computeClaimAging,
  daysBetween,
  parseMyntraReturnsCsv,
  getReturnTrackingSummary,
  getReturnTrackingList,
} from "../return-tracking.js"

// ---------- 1. Date Calculation Rules (RTO vs Return) ----------

test("[synthetic] calculateReturnDates: Customer Return uses return_created_date", () => {
  const result = calculateReturnDates({
    type: "Return",
    return_created_date: "2026-09-15 14:30:00",
    order_rto_date: null,
    order_created_date: "2026-09-01 10:00:00",
  })

  assert.equal(result.returnCreatedDate, "2026-09-15")
  assert.equal(result.orderRtoDate, null)
  assert.equal(result.effectiveReturnDate, "2026-09-15")
})

test("[synthetic] calculateReturnDates: RTO ignores 1970-01-01 placeholder and uses order_rto_date", () => {
  const result = calculateReturnDates({
    type: "RTO",
    return_created_date: "1970-01-01 00:00:00",
    order_rto_date: "2026-08-20 18:45:00",
    order_created_date: "2026-08-10 11:00:00",
  })

  assert.equal(result.returnCreatedDate, null, "1970-01-01 must be treated as empty placeholder")
  assert.equal(result.orderRtoDate, "2026-08-20")
  assert.equal(result.effectiveReturnDate, "2026-08-20")
})

test("[synthetic] calculateReturnDates: Fallback to order_created_date when return dates are missing", () => {
  const result = calculateReturnDates({
    type: "RTO",
    return_created_date: "",
    order_rto_date: undefined,
    order_created_date: "2026-07-04",
  })

  assert.equal(result.effectiveReturnDate, "2026-07-04")
})

test("[synthetic] daysBetween: accurately computes calendar day diffs", () => {
  assert.equal(daysBetween("2026-09-01", "2026-09-01"), 0)
  assert.equal(daysBetween("2026-09-01", "2026-09-10"), 9)
  assert.equal(daysBetween("2026-08-01", "2026-10-01"), 61)
})

// ---------- 2. Myntra SPF Policy v5.1 Aging & Claim Eligibility ----------

test("[synthetic] computeClaimAging: Undelivered < 60 days is 'transit'", () => {
  const today = new Date("2026-10-23")
  // 40 days ago
  const result = computeClaimAging(
    {
      effectiveReturnDate: "2026-09-13",
      isPhysicallyReceived: false,
    },
    today,
  )

  assert.equal(result.ageDays, 40)
  assert.equal(result.status, "transit")
  assert.equal(result.filingDeadline, null)
})

test("[synthetic] computeClaimAging: Undelivered 60-99 days is 'eligible_rnr' with 120-day deadline", () => {
  const today = new Date("2026-10-23")
  // 70 days ago (2026-08-14)
  const result = computeClaimAging(
    {
      effectiveReturnDate: "2026-08-14",
      isPhysicallyReceived: false,
    },
    today,
  )

  assert.equal(result.ageDays, 70)
  assert.equal(result.status, "eligible_rnr")
  assert.ok(result.filingDeadline !== null)
  // Deadline is exactly 120 days from effective return date
  assert.equal(daysBetween("2026-08-14", result.filingDeadline!), 120)
})

test("[synthetic] computeClaimAging: Undelivered 100-120 days is 'expiring_soon' (urgent window)", () => {
  const today = new Date("2026-10-23")
  // 110 days ago (2026-07-05)
  const result = computeClaimAging(
    {
      effectiveReturnDate: "2026-07-05",
      isPhysicallyReceived: false,
    },
    today,
  )

  assert.equal(result.ageDays, 110)
  assert.equal(result.status, "expiring_soon")
  assert.equal(daysBetween("2026-07-05", result.filingDeadline!), 120)
})

test("[synthetic] computeClaimAging: Undelivered > 120 days is 'expired_unclaimed' (SLA breached)", () => {
  const today = new Date("2026-10-23")
  // 130 days ago (2026-06-15)
  const result = computeClaimAging(
    {
      effectiveReturnDate: "2026-06-15",
      isPhysicallyReceived: false,
    },
    today,
  )

  assert.equal(result.ageDays, 130)
  assert.equal(result.status, "expired_unclaimed")
})

test("[synthetic] computeClaimAging: Physically received within 120 days is 'delivered_normal'", () => {
  const today = new Date("2026-10-23")
  // 45 days ago, scanned 5 days ago
  const result = computeClaimAging(
    {
      effectiveReturnDate: "2026-09-08",
      isPhysicallyReceived: true,
      physicalScannedAt: new Date("2026-10-18"),
    },
    today,
  )

  assert.equal(result.status, "delivered_normal")
})

test("[synthetic] computeClaimAging: Delayed RTS/RTO delivered after >120 days within 7 days is 'delayed_rts_eligible'", () => {
  const today = new Date("2026-10-23")
  // Return created 130 days ago, physically scanned 4 days ago (2026-10-19)
  const result = computeClaimAging(
    {
      effectiveReturnDate: "2026-06-15",
      isPhysicallyReceived: true,
      physicalScannedAt: new Date("2026-10-19"),
    },
    today,
  )

  assert.equal(result.status, "delayed_rts_eligible")
  assert.equal(result.filingDeadline, "2026-10-26") // Scanned date + 7 days
})

test("[synthetic] computeClaimAging: Delayed RTS/RTO delivered after >120 days but >7 days elapsed is 'delayed_rts_expired'", () => {
  const today = new Date("2026-10-23")
  // Return created 140 days ago, physically scanned 12 days ago (2026-10-11)
  const result = computeClaimAging(
    {
      effectiveReturnDate: "2026-06-05",
      isPhysicallyReceived: true,
      physicalScannedAt: new Date("2026-10-11"),
    },
    today,
  )

  assert.equal(result.status, "delayed_rts_expired")
})

// ---------- 3. Myntra Returns CSV Ingestion Parsing ----------

test("[synthetic] parseMyntraReturnsCsv: parses valid header row and extracts Return & RTO lines", () => {
  const csvData = [
    "seller_id,order_id,order_line_id,seller_order_id,return_id,tracking_number,forward_tracking_number,return_tracking_number,type,status,sub_status,return_reason,order_release_date,return_created_date,order_rto_date,delivery_date,seller_sku_code,myntra_sku_code,quantity,model,warehouse_id",
    "SYN-45833,SYN-ORD-001,SYN-LINE-001,SYN-SORD-001,SYN-RET-001,SYN-TRK-001,,SYN-TRK-001,Return,Delivered,DLS,Defective,2026-09-01 10:00:00,2026-09-28 14:00:00,,2026-10-05 11:00:00,SYN-SKU-A,SYN-MSKU-A,1,PPMP,SYN-WH-1",
    "SYN-45833,SYN-ORD-002,SYN-LINE-002,SYN-SORD-002,SYN-RET-002,SYN-FWD-002,SYN-FWD-002,,RTO,In-Transit,ITC,Customer Refused,2026-09-05 10:00:00,1970-01-01 00:00:00,2026-09-20 16:00:00,,SYN-SKU-B,SYN-MSKU-B,2,PPMP,SYN-WH-1",
  ].join("\r\n")

  const parsed = parseMyntraReturnsCsv(csvData)

  assert.equal(parsed.detectedSellerId, "SYN-45833")
  assert.equal(parsed.records.length, 2)
  assert.equal(parsed.warnings.length, 0)

  // Verify Return record
  const ret = parsed.records[0]
  assert.equal(ret.orderId, "SYN-ORD-001")
  assert.equal(ret.returnType, "Return")
  assert.equal(ret.trackingId, "SYN-TRK-001")
  assert.equal(ret.returnCreatedDate, "2026-09-28 14:00:00")
  assert.equal(ret.portalStatus, "Delivered")

  // Verify RTO record
  const rto = parsed.records[1]
  assert.equal(rto.orderId, "SYN-ORD-002")
  assert.equal(rto.returnType, "RTO")
  assert.equal(rto.trackingId, "SYN-FWD-002")
  assert.equal(rto.orderRtoDate, "2026-09-20 16:00:00")
  assert.equal(rto.quantity, 2)
})

test("[synthetic] parseMyntraReturnsCsv: handles empty and malformed CSV", () => {
  const emptyParsed = parseMyntraReturnsCsv("")
  assert.equal(emptyParsed.records.length, 0)
  assert.ok(emptyParsed.warnings.length > 0)

  const missingCols = parseMyntraReturnsCsv("col1,col2,col3\r\nval1,val2,val3")
  assert.equal(missingCols.records.length, 0)
  assert.ok(missingCols.warnings[0].includes("Missing required columns"))
})

// ---------- 4. Rule 1: Account Scoping Invariant ----------

test("[synthetic] Rule 1: getReturnTrackingSummary returns zero counts for empty allowed marketplace IDs", async () => {
  const fakeDb = {
    query: async () => {
      throw new Error("Database should not be queried when no accounts allowed")
    },
  }

  const summary = await getReturnTrackingSummary(fakeDb, [])
  assert.equal(summary.totalTracked, 0)
  assert.equal(summary.eligibleRnr, 0)
  assert.equal(summary.inTransit, 0)
})

test("[synthetic] Rule 1: getReturnTrackingList returns empty records for empty allowed marketplace IDs", async () => {
  const fakeDb = {
    query: async () => {
      throw new Error("Database should not be queried when no accounts allowed")
    },
  }

  const result = await getReturnTrackingList(fakeDb, [], { status: "all" })
  assert.equal(result.records.length, 0)
  assert.equal(result.total, 0)
})
