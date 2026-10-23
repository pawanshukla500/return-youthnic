// Pure checks for Iron Send, the analytics helpers and the live-update scope rule. No database.

import { test } from "node:test"
import assert from "node:assert/strict"
import { buildInsights, normalizeFilters, pct, sizeOfLine, sizeRank } from "../analytics.js"
import { computeVolumeRatios } from "../dashboard.js"
import { canDispatchIron, canReceiveIron, ironBatchNumber, ironBatchStateOf, ironLocationOf, ironStateOf, receiveProblem } from "../iron.js"
import { changeVisibleTo } from "../live.js"
import { countsAsReturnIssue, scanStatusFor } from "../register-rules.js"

const now = new Date("2026-10-14T12:00:00Z")
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 3600_000)

test("Iron Send is operational: it never makes a scan an issue return", () => {
  assert.equal(countsAsReturnIssue({ isOperational: true }), false)
  assert.equal(countsAsReturnIssue({ isOperational: false }), true)
  assert.equal(countsAsReturnIssue(undefined), true, "an unknown category is never hidden from the issue figures")
  assert.equal(scanStatusFor(false, false), "Clear")
})

test("an Iron Send is pending until the Inward Team records it; nothing is received by time alone", () => {
  const base = { status: "open" as const, qtySent: 2, now, overdueAfterDays: 3 }
  assert.equal(ironStateOf({ ...base, qtyReceived: 0, sentAt: daysAgo(1) }), "pending")
  assert.equal(ironStateOf({ ...base, qtyReceived: 1, sentAt: daysAgo(1) }), "partial")
  assert.equal(ironStateOf({ ...base, qtyReceived: 0, sentAt: daysAgo(10) }), "overdue", "old records are overdue, not received")
  assert.equal(ironStateOf({ ...base, qtyReceived: 1, sentAt: daysAgo(4) }), "overdue")
  assert.equal(ironStateOf({ ...base, qtyReceived: 2, sentAt: daysAgo(10) }), "received")
  assert.equal(ironStateOf({ ...base, status: "cancelled", qtyReceived: 0, sentAt: daysAgo(1) }), "cancelled")
})

test("only the Inward Team (or an Admin) may record ironed units as received", () => {
  assert.equal(canReceiveIron("Inward"), true)
  assert.equal(canReceiveIron("inward"), true)
  assert.equal(canReceiveIron("Admin"), true)
  assert.equal(canReceiveIron("Scanner"), false, "the Return Team only sends")
  assert.equal(canReceiveIron("Supervisor"), false)
  assert.equal(canReceiveIron(""), false)
})

test("a receive entry must be a whole number within the pending quantity", () => {
  assert.equal(receiveProblem(1, 2, ""), null)
  assert.equal(receiveProblem(2, 2, ""), null)
  assert.match(receiveProblem(3, 2, "") ?? "", /Only 2 unit/)
  assert.match(receiveProblem(0, 2, "") ?? "", /at least 1/)
  assert.match(receiveProblem(1.5, 2, "") ?? "", /whole number/)
  assert.match(receiveProblem(1, 0, "") ?? "", /already been received/)
  assert.match(receiveProblem(1, 2, "x".repeat(501)) ?? "", /500 characters/)
})

test("analytics filters default to the last 30 IST days and are bounded", () => {
  const f = normalizeFilters({}, "2026-10-14")
  assert.equal(f.dateTo, "2026-10-14")
  assert.equal(f.dateFrom, "2026-09-15")
  const swapped = normalizeFilters({ dateFrom: "2026-10-10", dateTo: "2026-10-01" }, "2026-10-14")
  assert.deepEqual([swapped.dateFrom, swapped.dateTo], ["2026-10-01", "2026-10-10"])
  const capped = normalizeFilters({ dateFrom: "2020-01-01", dateTo: "2026-10-14" }, "2026-10-14")
  assert.equal(capped.dateFrom, "2025-10-14")
  assert.equal(normalizeFilters({ categoryCode: "x'; DROP" }, "2026-10-14").categoryCode, "", "only plain category codes pass")
  assert.equal(normalizeFilters({ marketplaceId: -4 }, "2026-10-14").marketplaceId, null)
})

test("sizes come from the listing SKU, then the product SKU and name", () => {
  assert.equal(sizeOfLine("SYN-KURTA-BLUE_M", "", ""), "M")
  assert.equal(sizeOfLine("SYN-KURTA", "SYN-KURTA-XL", ""), "XL")
  assert.equal(sizeOfLine("SYN-KURTA", "SYN", "Kurta Set Free Size"), "Free Size")
  assert.equal(sizeOfLine("SYN-KURTA", "SYN", "SYN kurta"), "Unknown")
  assert.ok(sizeRank("S") < sizeRank("M") && sizeRank("XL") < sizeRank("Unknown"))
  assert.equal(pct(1, 3), 33.3)
  assert.equal(pct(1, 0), 0)
})

test("insights mention Iron Send as not an issue, and say when nothing was scanned", () => {
  const empty = {
    filters: { dateFrom: "2026-10-01", dateTo: "2026-10-07", marketplaceId: null, categoryCode: "" },
    totals: { scans: 0, issueScans: 0, units: 0, issueUnits: 0, ironUnits: 0, clearScans: 0, expectedUnits: 0, missingUnits: 0, issueRatePct: 0, skus: 0 },
    previous: { scans: 0, issueScans: 0, units: 0, issueUnits: 0, ironUnits: 0, dateFrom: "", dateTo: "" },
    byDay: [], byWeek: [], byMarketplace: [], bySku: [], bySize: [], byIssueCategory: [], byReason: [],
  }
  assert.deepEqual(buildInsights(empty), ["No returns were scanned in this period."])
  const some = {
    ...empty,
    totals: { ...empty.totals, scans: 10, units: 12, ironUnits: 3, issueScans: 1, issueRatePct: 10 },
    byIssueCategory: [{ code: "iron_send", label: "Iron Send", units: 3, lines: 2, operational: true }],
  }
  const lines = buildInsights(some, { pending: 4, overdue: 2 })
  assert.ok(lines.some((line) => /3 units were sent for ironing\. They are not counted as issues/.test(line)))
  assert.ok(lines.some((line) => /2 ironed units are overdue/.test(line)))
  assert.ok(!lines.some((line) => /Most common issue: Iron Send/.test(line)), "Iron Send is never the most common issue")
})

test("a live change reaches only the users whose accounts include it", () => {
  assert.equal(changeVisibleTo({ all: true }, { marketplaceId: 3 }), true)
  assert.equal(changeVisibleTo({ all: false, marketplaceIds: [3] }, { marketplaceId: 3 }), true)
  assert.equal(changeVisibleTo({ all: false, marketplaceIds: [2] }, { marketplaceId: 3 }), false)
  assert.equal(changeVisibleTo({ all: false, marketplaceIds: [] }, { marketplaceId: null }), true, "a setting change has no account")
})

test("Iron batches: numbered by IST day, overdue after their own date, made by the Return Team only", () => {
  assert.equal(ironBatchNumber("2026-10-14", 1), "IRN-261014-001")
  assert.equal(ironBatchNumber("2026-10-14", 27), "IRN-261014-027")
  const due = new Date(now.getTime() + 2 * 24 * 3600_000)
  assert.equal(ironBatchStateOf({ qtySent: 5, qtyReceived: 0, expectedReturnAt: due, now }), "open")
  assert.equal(ironBatchStateOf({ qtySent: 5, qtyReceived: 2, expectedReturnAt: due, now }), "partial")
  assert.equal(ironBatchStateOf({ qtySent: 5, qtyReceived: 2, expectedReturnAt: daysAgo(1), now }), "overdue")
  assert.equal(ironBatchStateOf({ qtySent: 5, qtyReceived: 5, expectedReturnAt: daysAgo(1), now }), "received")
  // A line in a 5-day batch is not overdue on day 4, even though the general setting is 3 days.
  const base = { status: "open" as const, qtySent: 1, qtyReceived: 0, sentAt: daysAgo(4), now, overdueAfterDays: 3 }
  assert.equal(ironStateOf({ ...base, dueAt: new Date(now.getTime() + 24 * 3600_000) }), "pending")
  assert.equal(ironStateOf(base), "overdue")
  assert.equal(canDispatchIron("Scanner"), true)
  assert.equal(canDispatchIron("Supervisor"), true)
  assert.equal(canDispatchIron("Admin"), true)
  assert.equal(canDispatchIron("Inward"), false, "the Inward Team receives; it does not make batches")
})

test("Iron batches go to a khaata unless the Return Team chose the return desk", () => {
  assert.equal(ironLocationOf("in_house"), "in_house")
  assert.equal(ironLocationOf(" IN_HOUSE "), "in_house")
  assert.equal(ironLocationOf("khaata"), "khaata")
  assert.equal(ironLocationOf(undefined), "khaata")
  assert.equal(ironLocationOf("anything else"), "khaata")
})

test("[synthetic] computeVolumeRatios calculates daily averages and RTO / Customer Return ratios accurately", () => {
  const days = [
    { received: 1275, issues: 30, rto: 489, customer: 786 },
    { received: 812, issues: 8, rto: 314, customer: 498 },
    { received: 1266, issues: 8, rto: 390, customer: 876 },
    { received: 1637, issues: 15, rto: 488, customer: 1149 },
    { received: 1149, issues: 1, rto: 452, customer: 697 },
    { received: 3531, issues: 50, rto: 1196, customer: 2335 },
    { received: 0, issues: 0, rto: 0, customer: 0 },
  ]
  const summary = computeVolumeRatios(days)
  assert.equal(summary.totalReceived, 9670)
  assert.equal(summary.totalCustomer, 6341)
  assert.equal(summary.totalRto, 3329)
  assert.equal(summary.totalIssues, 112)
  assert.equal(summary.dailyAvg, "1381.4")
  assert.equal(summary.dailyAvgCustomer, "905.9")
  assert.equal(summary.dailyAvgRto, "475.6")
  assert.equal(summary.dailyAvgIssues, "16.0")
  assert.equal(summary.customerRatioPct, 65.6)
  assert.equal(summary.rtoRatioPct, 34.4)
  assert.equal(summary.issueRatioPct, 1.2)
})

test("[synthetic] computeVolumeRatios handles empty periods gracefully without division by zero", () => {
  const emptyDays = [
    { received: 0, issues: 0, rto: 0, customer: 0 },
    { received: 0, issues: 0, rto: 0, customer: 0 },
    { received: 0, issues: 0, rto: 0, customer: 0 },
    { received: 0, issues: 0, rto: 0, customer: 0 },
    { received: 0, issues: 0, rto: 0, customer: 0 },
    { received: 0, issues: 0, rto: 0, customer: 0 },
    { received: 0, issues: 0, rto: 0, customer: 0 },
  ]
  const summary = computeVolumeRatios(emptyDays)
  assert.equal(summary.totalReceived, 0)
  assert.equal(summary.totalCustomer, 0)
  assert.equal(summary.totalRto, 0)
  assert.equal(summary.dailyAvg, "0.0")
  assert.equal(summary.dailyAvgCustomer, "0.0")
  assert.equal(summary.dailyAvgRto, "0.0")
  assert.equal(summary.customerRatioPct, 0)
  assert.equal(summary.rtoRatioPct, 0)
})
