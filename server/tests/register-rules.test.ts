import { test } from "node:test"
import assert from "node:assert/strict"
import { identifierFor } from "../lookup-import.js"
import {
  REGISTER_CSV_HEADERS,
  decideLookup,
  describeIssues,
  isValidClientKey,
  legFor,
  mapRegisterRow,
  matchedFieldFor,
  normalizeTracking,
  productSkuFor,
  registerCsv,
  registerRecords,
  scanStatusFor,
  ticketStatusError,
  validateScanSubmission,
  type CategoryRule,
  type LookupEntry,
  type RawRegisterRow,
  type RuleResult,
  type ScanSubmission,
  type SubIssueRule,
} from "../register-rules.js"
import type { ParsedRow } from "../sheets.js"

// Synthetic values only (SYN-*).
const KEY = "SYN-SCAN-KEY-0001"

const categories: CategoryRule[] = [
  { code: "no_issue", label: "No issue", isClear: true, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "missing_component", label: "Missing product or component", isClear: false, isMissing: true, requiresTicket: true, allowsSubIssue: true, requiresSubIssue: true, active: true },
  { code: "wrong_product", label: "Wrong product", isClear: false, isMissing: false, requiresTicket: true, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "damaged_product", label: "Damaged product", isClear: false, isMissing: false, requiresTicket: true, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "other_issue", label: "Other issue", isClear: false, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "retired", label: "Retired issue", isClear: false, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: false },
]

const subIssues: SubIssueRule[] = [
  { id: 10, label: "Dupatta", categoryCode: "missing_component", active: true },
  { id: 11, label: "Bottom", categoryCode: "missing_component", active: true },
  { id: 12, label: "Old option", categoryCode: "missing_component", active: false },
  { id: 13, label: "Belongs to another category", categoryCode: "wrong_product", active: true },
]

// Item 1 expects two units, item 2 expects one.
const items = [
  { id: 1, expectedQty: 2 },
  { id: 2, expectedQty: 1 },
]

function submission(overrides: Partial<ScanSubmission> = {}): ScanSubmission {
  return {
    shipmentId: 5,
    clientScanKey: KEY,
    notes: "",
    items: [
      { itemId: 1, receivedQty: 2, verified: true, issues: [] },
      { itemId: 2, receivedQty: 1, verified: true, issues: [] },
    ],
    ...overrides,
  }
}

function check(sub: ScanSubmission): RuleResult {
  return validateScanSubmission(items, sub, categories, subIssues)
}

function errorsOf(result: RuleResult): string[] {
  return result.ok ? [] : result.errors
}

function hasError(result: RuleResult, fragment: string): boolean {
  return errorsOf(result).some((message) => message.includes(fragment))
}

// ---------------------------------------------------------------------------------------------------------------
// Scan keys and tracking IDs
// ---------------------------------------------------------------------------------------------------------------

test("a scan key must be 8 to 100 safe characters", () => {
  assert.equal(isValidClientKey("SYN-KEY-0001"), true)
  assert.equal(isValidClientKey("short"), false)
  assert.equal(isValidClientKey("has space in it"), false)
  assert.equal(isValidClientKey("x".repeat(101)), false)
})

test("tracking IDs keep their text, but spaces and case are normalized", () => {
  assert.deepEqual(normalizeTracking("  syn-awb-1  "), { value: "SYN-AWB-1", error: "" })
  assert.deepEqual(normalizeTracking("007123"), { value: "007123", error: "" })
  assert.match(normalizeTracking("").error, /Enter a tracking ID/)
})

test("scientific notation is refused, because its digits were lost", () => {
  assert.match(normalizeTracking("1.23E+15").error, /scientific notation/)
})

test("the matched AWB and its leg are recorded: return, forward, or not known", () => {
  assert.deepEqual(matchedFieldFor("SYN-R-1", "SYN-R-1", "SYN-F-1", "return_tracking"), { field: "tracking_id", leg: "return" })
  assert.deepEqual(matchedFieldFor("SYN-F-1", "SYN-F-1", "", "forward_tracking"), { field: "tracking_id", leg: "forward" })
  assert.deepEqual(matchedFieldFor("SYN-F-1", "SYN-R-1", "SYN-F-1", "return_tracking"), { field: "alt_tracking_id", leg: "forward" })
  assert.deepEqual(matchedFieldFor("SYN-X", "SYN-R-1", "SYN-F-1", "return_tracking"), { field: "", leg: "unknown" })
  assert.deepEqual(matchedFieldFor("", "SYN-R-1", null, "return_tracking"), { field: "", leg: "unknown" })
  assert.equal(legFor("tracking_id"), "unknown")
})

// ---------------------------------------------------------------------------------------------------------------
// Lookup decisions
// ---------------------------------------------------------------------------------------------------------------

function entry(overrides: Partial<LookupEntry>): LookupEntry {
  return {
    shipmentId: 1,
    accountId: 1,
    accountName: "Myntra EJ",
    alreadyReceived: false,
    orderId: "SYN-ORDER-1",
    itemCount: 1,
    receivedAt: "",
    scannedBy: "",
    ...overrides,
  }
}

test("no match, one match and one earlier receipt are decided without guessing", () => {
  assert.deepEqual(decideLookup([]), { kind: "none" })
  assert.equal(decideLookup([entry({})]).kind, "single")
  assert.equal(decideLookup([entry({ alreadyReceived: true })]).kind, "duplicate")
  assert.equal(decideLookup([entry({ shipmentId: null, alreadyReceived: true })]).kind, "duplicate")
})

test("two matches in two accounts must be chosen by the employee", () => {
  const decision = decideLookup([entry({ accountName: "Myntra EJ" }), entry({ shipmentId: 2, accountName: "Myntra VB" })])
  assert.equal(decision.kind, "choose")
})

// ---------------------------------------------------------------------------------------------------------------
// Scan submission rules
// ---------------------------------------------------------------------------------------------------------------

test("a clean scan with every line verified is accepted", () => {
  assert.deepEqual(check(submission()), { ok: true })
})

test("a line that was not physically verified is refused", () => {
  const sub = submission()
  sub.items[0].verified = false
  assert.ok(hasError(check(sub), "confirm the physical check"))
})

test("a line left out of the submission is refused", () => {
  const sub = submission({ items: [{ itemId: 1, receivedQty: 2, verified: true, issues: [] }] })
  assert.ok(hasError(check(sub), "Item 2 has not been verified"))
})

test("an item that does not belong to the return is refused", () => {
  const sub = submission()
  sub.items.push({ itemId: 999, receivedQty: 1, verified: true, issues: [] })
  assert.ok(hasError(check(sub), "Item 999 does not belong to this return"))
})

test("an item listed twice is refused", () => {
  const sub = submission()
  sub.items.push({ itemId: 1, receivedQty: 2, verified: true, issues: [] })
  assert.ok(hasError(check(sub), "Item 1 is listed more than once"))
})

test("received quantity above the expected quantity is refused", () => {
  const sub = submission()
  sub.items[1].receivedQty = 2
  assert.ok(hasError(check(sub), "received quantity must be a whole number from 0 to 1"))
})

test("units that were not received must be covered by a missing-item issue", () => {
  const sub = submission()
  sub.items[0].receivedQty = 1
  assert.ok(hasError(check(sub), "1 unit(s) are not received, and the missing-item issues cover 0"))
})

test("a missing unit with a sub-issue and a ticket is accepted", () => {
  const sub = submission()
  sub.items[0].receivedQty = 1
  sub.items[0].issues = [{ categoryCode: "missing_component", subIssueId: 10, qty: 1, ticketCode: "SYN-TKT-1", notes: "" }]
  assert.deepEqual(check(sub), { ok: true })
})

test("a missing-item issue needs a sub-issue", () => {
  const sub = submission()
  sub.items[0].receivedQty = 1
  sub.items[0].issues = [{ categoryCode: "missing_component", subIssueId: null, qty: 1, ticketCode: "SYN-TKT-1", notes: "" }]
  assert.ok(hasError(check(sub), "choose what is missing for Missing product or component"))
})

test("a sub-issue must be active and belong to the same category", () => {
  const sub = submission()
  sub.items[0].receivedQty = 1
  sub.items[0].issues = [{ categoryCode: "missing_component", subIssueId: 12, qty: 1, ticketCode: "SYN-TKT-1", notes: "" }]
  assert.ok(hasError(check(sub), "the sub-issue is not valid"))
  sub.items[0].issues = [{ categoryCode: "missing_component", subIssueId: 13, qty: 1, ticketCode: "SYN-TKT-1", notes: "" }]
  assert.ok(hasError(check(sub), "the sub-issue is not valid"))
})

test("a category that needs a ticket refuses a save without one", () => {
  const sub = submission()
  sub.items[0].issues = [{ categoryCode: "damaged_product", subIssueId: null, qty: 1, ticketCode: "", notes: "" }]
  assert.ok(hasError(check(sub), "Damaged product needs a ticket ID"))
})

test("a category that does not take a ticket refuses one", () => {
  const sub = submission()
  sub.items[0].issues = [{ categoryCode: "other_issue", subIssueId: null, qty: 1, ticketCode: "SYN-TKT-9", notes: "" }]
  assert.ok(hasError(check(sub), "Other issue does not take a ticket ID"))
})

test("the same ticket cannot be used twice in one save", () => {
  const sub = submission()
  sub.items[0].issues = [{ categoryCode: "damaged_product", subIssueId: null, qty: 1, ticketCode: "SYN-TKT-2", notes: "" }]
  sub.items[1].issues = [{ categoryCode: "wrong_product", subIssueId: null, qty: 1, ticketCode: "SYN-TKT-2", notes: "" }]
  assert.ok(hasError(check(sub), "The ticket SYN-TKT-2 is used more than once"))
})

test("multiple independent errors on one issue are all reported", () => {
  // P1 requirement: "Multiple independent validation failures can be legitimate." Here a missing-item issue
  // has BOTH a notes-length violation AND a missing-required-sub-issue. Both errors must be reported
  // independently; the operator fixes both, not just the first one. The downstream coverage error is also
  // reported, because the issue cannot satisfy the missing-unit check (no sub-issue selected).
  const sub = submission()
  sub.items[0].receivedQty = 1
  sub.items[0].issues = [
    {
      categoryCode: "missing_component", // requires sub-issue + ticket
      subIssueId: null, // missing required sub-issue
      qty: 1,
      ticketCode: "SYN-TKT-MULTI",
      notes: "x".repeat(501), // also over the notes limit
    },
  ]
  const result = check(sub)
  const messages = errorsOf(result)
  // The two independent errors must both be reported, in any order.
  assert.ok(messages.some((m) => m.includes("choose what is missing for")), `missing-sub-issue error must be reported; got ${JSON.stringify(messages)}`)
  assert.ok(messages.some((m) => m.includes("notes must be 500 characters")), `notes-length error must be reported; got ${JSON.stringify(messages)}`)
  // The two errors are distinct messages, not the same one twice.
  assert.equal(new Set(messages).size, messages.length, `error messages must be distinct; got ${JSON.stringify(messages)}`)
})

test("issues on received units cannot exceed the units received", () => {
  const sub = submission()
  sub.items[0].receivedQty = 1
  sub.items[0].issues = [
    { categoryCode: "missing_component", subIssueId: 10, qty: 1, ticketCode: "SYN-TKT-3", notes: "" },
    { categoryCode: "damaged_product", subIssueId: null, qty: 2, ticketCode: "SYN-TKT-4", notes: "" },
  ]
  assert.ok(hasError(check(sub), "issues on received units (2) are more than the 1 received"))
})

test("an inactive or unknown category is refused", () => {
  const sub = submission()
  sub.items[0].issues = [{ categoryCode: "retired", subIssueId: null, qty: 1, ticketCode: "", notes: "" }]
  assert.ok(hasError(check(sub), 'the issue category "retired" is not available'))
  sub.items[0].issues = [{ categoryCode: "not_a_category", subIssueId: null, qty: 1, ticketCode: "", notes: "" }]
  assert.ok(hasError(check(sub), 'the issue category "not_a_category" is not available'))
})

// Regression: an invalid issue is reported once and does not silently satisfy the missing-unit math.
test("an invalid missing-item issue is not counted into missing-unit coverage", () => {
  // Item 1 expects 2, nothing received: 2 missing units. The single missing-item issue has a sub-issue from the
  // wrong category. The invalid issue must not silently count toward coverage, so the missing-unit error must
  // report that the covering issues are 0 (not 2).
  const sub = submission({
    items: [
      { itemId: 1, receivedQty: 0, verified: true, issues: [] },
      { itemId: 2, receivedQty: 1, verified: true, issues: [] },
    ],
  })
  sub.items[0].issues = [
    { categoryCode: "missing_component", subIssueId: 13, qty: 2, ticketCode: "SYN-TKT-MISS", notes: "" },
  ]
  const result = check(sub)
  const messages = errorsOf(result)
  assert.ok(messages.some((m) => m.includes("the sub-issue is not valid for")), "sub-issue error should be reported")
  assert.ok(
    messages.some((m) => m.includes("missing-item issues cover 0")),
    `the invalid issue must not be counted into missing-unit coverage; got ${JSON.stringify(messages)}`,
  )
})

test("a missing-item issue without a sub-issue is not counted into missing-unit coverage", () => {
  // Missing-component requires a sub-issue; none was given. The operator must see both the missing-sub-issue
  // error and a missing-unit error that reports coverage as 0 (not 1).
  const sub = submission({
    items: [
      { itemId: 1, receivedQty: 0, verified: true, issues: [] },
      { itemId: 2, receivedQty: 1, verified: true, issues: [] },
    ],
  })
  sub.items[0].issues = [
    { categoryCode: "missing_component", subIssueId: null, qty: 1, ticketCode: "SYN-TKT-MISS", notes: "" },
  ]
  const result = check(sub)
  const messages = errorsOf(result)
  assert.ok(messages.some((m) => m.includes("choose what is missing for")), "missing-sub-issue error should be reported")
  assert.ok(
    messages.some((m) => m.includes("missing-item issues cover 0")),
    `the issue without a sub-issue must not be counted into missing-unit coverage; got ${JSON.stringify(messages)}`,
  )
})

test("a missing-item issue with a duplicate ticket is reported once and is not counted into coverage", () => {
  // One item, expected qty 2, received 1. Two missing-item issues using the same ticket. The second is the
  // duplicate. The operator should see one duplicate-ticket error and one missing-unit error (which is real,
  // because only the first issue counts toward coverage). The error must not be repeated per duplicate issue.
  const sub = submission({
    items: [
      { itemId: 1, receivedQty: 1, verified: true, issues: [] },
      { itemId: 2, receivedQty: 1, verified: true, issues: [] },
    ],
  })
  sub.items[0].issues = [
    { categoryCode: "missing_component", subIssueId: 10, qty: 1, ticketCode: "SYN-TKT-DUP", notes: "" },
    { categoryCode: "missing_component", subIssueId: 10, qty: 1, ticketCode: "SYN-TKT-DUP", notes: "" },
  ]
  const result = check(sub)
  const messages = errorsOf(result)
  // Exactly one duplicate-ticket error across both items, regardless of how many duplicates there are.
  const dupErrors = messages.filter((m) => m.includes("used more than once"))
  assert.equal(dupErrors.length, 1, `expected one duplicate-ticket error, got ${dupErrors.length}: ${JSON.stringify(messages)}`)
})

test("No issue is not recorded as an issue", () => {
  const sub = submission()
  sub.items[0].issues = [{ categoryCode: "no_issue", subIssueId: null, qty: 1, ticketCode: "", notes: "" }]
  assert.ok(hasError(check(sub), "is not an issue"))
})

test("notes over the limit, a bad key, and an empty save are refused", () => {
  assert.ok(hasError(check(submission({ notes: "x".repeat(501) })), "Notes must be 500 characters or fewer"))
  assert.ok(hasError(check(submission({ clientScanKey: "bad key" })), "malformed"))
  assert.ok(hasError(check(submission({ items: [] })), "Verify at least one item"))
})

// ---------------------------------------------------------------------------------------------------------------
// Statuses, descriptions and ticket changes
// ---------------------------------------------------------------------------------------------------------------

test("the scan status follows the issues and the tickets", () => {
  assert.equal(scanStatusFor(false, false), "Clear")
  assert.equal(scanStatusFor(true, true), "Raised")
  assert.equal(scanStatusFor(true, false), "Draft")
})

test("issue descriptions name the sub-issue and the quantity", () => {
  assert.equal(describeIssues([]), "No issue")
  assert.equal(
    describeIssues([
      { categoryLabel: "Missing product or component", subIssueLabel: "Dupatta", qty: 2 },
      { categoryLabel: "Damaged product", subIssueLabel: "", qty: 1 },
    ]),
    "Missing product or component (Dupatta) ×2; Damaged product",
  )
})

test("a rejected ticket needs a reason, and a status cannot be set to itself", () => {
  assert.match(ticketStatusError("Raised", "Rejected", "   ") ?? "", /rejection reason is required/)
  assert.equal(ticketStatusError("Raised", "Rejected", "SYN reason"), null)
  assert.match(ticketStatusError("Raised", "Raised", "") ?? "", /already Raised/)
  assert.match(ticketStatusError("Raised", "Closed", "") ?? "", /valid ticket status/)
  assert.equal(ticketStatusError("Rejected", "Review", ""), null)
})

test("a SKU is shown only when it was resolved", () => {
  assert.equal(productSkuFor("unresolved", "SYN-SKU-1"), "")
  assert.equal(productSkuFor("product_master", "SYN-MASTER-1"), "SYN-MASTER-1")
  assert.equal(productSkuFor(null, "SYN-MASTER-1"), "SYN-MASTER-1")
})

test("the marketplace SKU identification is the one the layout read from its own column", () => {
  const fromLayout = { marketplaceSkuIdentifier: "SYN-FSN-1" } as unknown as ParsedRow
  const blankFromLayout = { marketplaceSkuIdentifier: "" } as unknown as ParsedRow
  assert.equal(identifierFor(fromLayout), "SYN-FSN-1")
  assert.equal(identifierFor(blankFromLayout), "")
})

test("an identifier header in the raw row is not read by name, so no column is guessed", () => {
  const onlyRawHeader = { raw: { fsn: "SYN-FSN-2" } } as unknown as ParsedRow
  assert.equal(identifierFor(onlyRawHeader), "")
})

// ---------------------------------------------------------------------------------------------------------------
// Register rows and CSV
// ---------------------------------------------------------------------------------------------------------------

function raw(overrides: Partial<RawRegisterRow>): RawRegisterRow {
  return {
    row_key: "1",
    source: "item",
    scan_id: 7,
    scanned_at: new Date("2026-10-09T04:30:00.000Z"),
    scan_day: "2026-10-09",
    scan_time: "10:00 AM",
    scan_status: "Raised",
    scanner_name: "SYN Scanner",
    marketplace_id: 2,
    marketplace: "Myntra EJ",
    tracking_id: "SYN-AWB-1",
    order_number: "SYN-ORDER-1",
    order_item_id: "SYN-LINE-1",
    marketplace_sku: "SYN-LISTING-1",
    product_sku: "SYN-MASTER-1",
    product_sku_source: "product_master",
    marketplace_sku_identifier: "",
    product_name: "SYN product",
    return_type: "Customer Return",
    return_reason: "SYN reason",
    expected_qty: 2,
    received_qty: 1,
    line_no: 1,
    issues: [
      {
        categoryCode: "missing_component",
        categoryLabel: "Missing product or component",
        subIssueLabel: "Dupatta",
        qty: 1,
        notes: "",
        ticketId: 3,
        ticketCode: "SYN-TKT-1",
        ticketStatus: "Rejected",
        rejectionReason: "SYN not valid",
      },
    ],
    ...overrides,
  }
}

test("a register row carries the issue, the ticket and its status", () => {
  const row = mapRegisterRow(raw({}))
  assert.equal(row.issues.length, 1)
  assert.deepEqual(row.issues[0].ticket, { id: 3, code: "SYN-TKT-1", status: "Rejected", rejectionReason: "SYN not valid" })
  assert.equal(row.receivedQty, 1)
  assert.equal(row.scannedAt, "2026-10-09T04:30:00.000Z")
})

test("a clean line has no issues, and no-issue entries are dropped", () => {
  const row = mapRegisterRow(
    raw({ received_qty: 2, issues: [{ categoryCode: "no_issue", categoryLabel: "No issue", qty: 2 }] }),
  )
  assert.deepEqual(row.issues, [])
  assert.equal(mapRegisterRow(raw({ received_qty: null, issues: null })).receivedQty, null)
})

test("the register row keeps the partner, the match and the validation, and leaves amounts empty", () => {
  const row = mapRegisterRow(
    raw({
      logistic_partner_name: "Shadowfax",
      partner_method: "explicit_carrier",
      matched_tracking_field: "alt_tracking_id",
      matched_leg: "forward",
      tracking_validation: "match",
      return_type_raw: "RVP",
    }),
  )
  assert.equal(row.logisticPartner, "Shadowfax")
  assert.equal(row.matchedTrackingField, "alt_tracking_id")
  assert.equal(row.matchedLeg, "forward")
  assert.equal(row.trackingValidation, "match")
  assert.equal(row.returnTypeRaw, "RVP")
  assert.equal(row.amount, null)
  assert.equal(row.claimAmount, null)
})

test("a row without partner data shows Unknown / Pending Verification", () => {
  assert.equal(mapRegisterRow(raw({})).logisticPartner, "Unknown / Pending Verification")
})

test("the CSV has the 19 requested columns in order, then four service columns", () => {
  assert.equal(REGISTER_CSV_HEADERS.length, 23)
  assert.deepEqual(REGISTER_CSV_HEADERS.slice(0, 9), [
    "Date",
    "Marketplace",
    "Tracking ID",
    "Order ID",
    "Order Item ID",
    "Marketplace SKU",
    "Product SKU",
    "Marketplace SKU Identification (FNSKU/ASIN/Myntra FSN)",
    "Logistic Partner Name",
  ])
  assert.equal(REGISTER_CSV_HEADERS[18], "If Rejected, What the Reason")
  assert.deepEqual(REGISTER_CSV_HEADERS.slice(19), ["Received Qty", "Scanned By", "Source", "Matched Tracking"])
})

test("the CSV quotes every cell, neutralizes formulas, and records the partner and the match", () => {
  const row = mapRegisterRow(
    raw({
      logistic_partner_name: "Delhivery",
      issues: [
        {
          categoryCode: "damaged_product",
          categoryLabel: "Damaged product",
          subIssueLabel: "",
          qty: 1,
          notes: "",
          ticketId: 4,
          ticketCode: "SYN-TKT-5",
          ticketStatus: "Rejected",
          rejectionReason: '=HYPERLINK("x")',
        },
      ],
    }),
  )
  const csv = registerCsv([row])
  const lines = csv.trimEnd().split("\n")
  assert.match(lines[0], /^"Date","Marketplace","Tracking ID","Order ID","Order Item ID"/)
  assert.match(lines[0], /"Marketplace SKU Identification \(FNSKU\/ASIN\/Myntra FSN\)","Logistic Partner Name"/)
  assert.match(lines[0], /"If Rejected, What the Reason","Received Qty","Scanned By","Source","Matched Tracking"$/)
  assert.match(lines[1], /"SYN-AWB-1"/)
  assert.match(lines[1], /"Delhivery"/)
  assert.match(lines[1], /"'=HYPERLINK\(""x""\)"/)
  assert.match(lines[1], /"Verified scan","Not recorded; Not known"$/)
})

test("the register records have one value per header, so the CSV and the Excel export line up", () => {
  const records = registerRecords([mapRegisterRow(raw({}))])
  assert.equal(records[0].length, REGISTER_CSV_HEADERS.length)
})
