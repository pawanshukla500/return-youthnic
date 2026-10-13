// SYNTHETIC FIXTURES ONLY. Invented rows (SYN-* values) and made-up dates. No real export, no OMSGuru call.
//
// Run: npm test

import { test } from "node:test"
import assert from "node:assert/strict"
import { istDay, istDayUnixRange, parseReportDate } from "../dates.js"
import { summarizeLifecycle } from "../lifecycle.js"
import { invoiceKey, normalizeTracking } from "../oms/invoices.js"
import { parseSpreadsheet } from "../sheets.js"

test("[synthetic] parseReportDate reads ISO, day-month-name, slash (M/D), and dash (DD-MM) dates", () => {
  assert.equal(parseReportDate("2026-10-02"), "2026-10-02")
  assert.equal(parseReportDate("2026-10-02 15:58:58"), "2026-10-02")
  assert.equal(parseReportDate("6 October, 2026"), "2026-10-06")
  assert.equal(parseReportDate("9/19/2026"), "2026-09-19")
  assert.equal(parseReportDate("4/24/26"), "2026-04-24")
  assert.equal(parseReportDate("08-10-2026"), "2026-10-08")
})

test("[synthetic] parseReportDate returns empty for time-only values and impossible dates", () => {
  assert.equal(parseReportDate("09:07.0"), "")
  assert.equal(parseReportDate("2026-02-30"), "")
  assert.equal(parseReportDate("13/13/2026"), "")
  assert.equal(parseReportDate(""), "")
})

test("[synthetic] istDayUnixRange covers one IST day, starting at IST midnight", () => {
  const range = istDayUnixRange("2026-10-07")
  assert.ok(range)
  assert.equal(range.start, Date.UTC(2026, 9, 7) / 1000 - 19800)
  assert.equal(range.end, range.start + 86399)
  assert.equal(istDayUnixRange("07-10-2026"), null)
})

test("[synthetic] istDay converts a moment to its IST calendar day", () => {
  // 20:00 UTC on 6 October is 01:30 IST on 7 October.
  assert.equal(istDay(new Date(Date.UTC(2026, 9, 6, 20, 0, 0))), "2026-10-07")
})

test("[synthetic] summarizeLifecycle counts each stage on its own day and status for all rows", () => {
  const rows = [
    { return_requested_date: "6 October, 2026", return_approval_date: "6 October, 2026", picked_up_date: "", completed_date: "8 October, 2026", return_status: "delivered" },
    { return_requested_date: "7 October, 2026", return_approval_date: "", picked_up_date: "7 October, 2026", completed_date: "", return_status: "in progress" },
  ]
  const config = {
    requested: "return_requested_date",
    approved: "return_approval_date",
    pickedUp: "picked_up_date",
    completed: "completed_date",
    statusColumn: "return_status",
  }
  const oct6 = summarizeLifecycle(rows, config, "2026-10-06")
  assert.equal(oct6.rows, 2)
  assert.equal(oct6.requested, 1)
  assert.equal(oct6.approved, 1)
  assert.equal(oct6.pickedUp, 0)
  assert.equal(oct6.deliveredStatus, 0)

  const all = summarizeLifecycle(rows, config)
  assert.equal(all.requested, 2)
  assert.equal(all.approved, 1)
  assert.equal(all.pickedUp, 1)
  assert.equal(all.completed, 1)
  assert.equal(all.deliveredStatus, 1)
})

test("[synthetic] summarizeLifecycle with no config counts rows only", () => {
  const counts = summarizeLifecycle([{ a: "1" }, { a: "2" }], undefined)
  assert.equal(counts.rows, 2)
  assert.equal(counts.requested, 0)
})

test("[synthetic] normalizeTracking removes courier suffixes and keeps only the allowed characters", () => {
  assert.equal(normalizeTracking("FMPC0001 ( EK_E2E )"), "FMPC0001")
  assert.equal(normalizeTracking("fmpc 1"), "FMPC1")
  assert.equal(normalizeTracking("-/SYN_9-/"), "SYN_9")
})

test("[synthetic] invoiceKey joins channel, order, invoice, and AWB in the Forward Scan format", () => {
  assert.equal(
    invoiceKey("Flipkart", "SYN-OID", "SYN-INV", "", "fmpc 1"),
    "Flipkart|SYN-OID|SYN-INV|FMPC1",
  )
  assert.equal(
    invoiceKey("Meesho", "SYN-OID", "", "SYN-SUB-1,SYN-SUB-2", "SYNVLR1"),
    "Meesho|SYN-OID|SYN-SUB-1,SYN-SUB-2|SYNVLR1",
  )
})

test("[synthetic] every column of an uploaded row is kept in raw, except the profile's redacted columns", () => {
  const csv = [
    "Tracking ID,Order ID,Order Item ID,SKU,Quantity,Return Type,Return Reason,Return Approval Date,Customer GSTIN,Customer Company Name,Comments",
    "SYNFMPC0003,SYNOD0003,SYN000000000000000003,SYN-SKU-3,1,customer_return,mind_changed,6 October 2026,SYNGST000,SYN Company,Synthetic comment",
  ].join("\n")
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), "Flipkart", "synthetic.csv").rows[0]
  assert.ok(row.raw)
  assert.equal(row.raw["return_approval_date"], "6 October 2026")
  assert.equal(row.raw["comments"], "Synthetic comment")
  assert.equal("customer_gstin" in row.raw, false)
  assert.equal("customer_company_name" in row.raw, false)
})

test("[synthetic] raw data is kept for a generic marketplace too", () => {
  // A channel with no layout of its own. Amazon has a layout now, so it is not used here.
  const csv = ["Tracking ID,Product SKU,Quantity,Extra Column", "SYN-AWB-7,SYN-SKU-7,1,SYN extra"].join("\n")
  const row = parseSpreadsheet(Buffer.from(csv, "utf8"), "Synthetic Channel", "synthetic.csv").rows[0]
  assert.equal(row.raw?.["extra_column"], "SYN extra")
})
