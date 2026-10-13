import { test } from "node:test"
import assert from "node:assert/strict"
import { getMobileReleaseInfo } from "../mobile-release.js"
import { submissionFrom } from "../register-routes.js"
import { normalizeTracking, validateScanSubmission, type CategoryRule, type SubIssueRule } from "../register-rules.js"

// Invariant 9: Test data is synthetic, and every value starts with SYN-.
const SYN_AWB_EXACT = "SYN-1490711818486605"
const SYN_CLIENT_SCAN_KEY = "SYN-MOBILE-1-1728734000000-abcd1234"

test("mobile release manifest returns valid release configuration", () => {
  const release = getMobileReleaseInfo()
  assert.ok(release.versionCode >= 10020, "versionCode must be >= 10020")
  assert.ok(typeof release.versionName === "string" && release.versionName.length > 0, "versionName must be string")
  assert.ok(typeof release.sha256 === "string" && release.sha256.length > 0, "sha256 must be string")
  assert.ok(release.sizeBytes > 0, "sizeBytes must be positive integer")
  assert.ok(release.notes.length > 0, "release notes must be present")
  assert.ok(typeof release.downloadUrl === "string" && release.downloadUrl.startsWith("https://"), "downloadUrl must be valid https URL")
})

test("mobile submission parser preserves exact tracking string without scientific truncation", () => {
  const payload = {
    shipmentId: 101,
    clientScanKey: SYN_CLIENT_SCAN_KEY,
    scannedTracking: SYN_AWB_EXACT,
    notes: "SYN-Verification note",
    items: [
      {
        itemId: 201,
        receivedQty: 1,
        verified: true,
        issues: [
          {
            categoryCode: "CLEAR",
            subIssueId: null,
            qty: 1,
            ticketCode: "",
            notes: "",
          },
        ],
      },
    ],
  }

  const submission = submissionFrom(payload)
  assert.equal(submission.shipmentId, 101)
  assert.equal(submission.scannedTracking, SYN_AWB_EXACT)
  assert.equal(submission.clientScanKey, SYN_CLIENT_SCAN_KEY)
  assert.equal(submission.items.length, 1)
  assert.equal(submission.items[0].itemId, 201)
  assert.equal(submission.items[0].receivedQty, 1)
  assert.equal(submission.items[0].verified, true)
  assert.equal(submission.items[0].issues[0].categoryCode, "CLEAR")
})

test("mobile multi-product return parcel maps each item separately", () => {
  const payload = {
    shipmentId: 102,
    clientScanKey: SYN_CLIENT_SCAN_KEY,
    scannedTracking: "SYN-AWB-MULTI-001",
    notes: "SYN-Two items in parcel",
    items: [
      {
        itemId: 301,
        receivedQty: 1,
        verified: true,
        issues: [
          {
            categoryCode: "MISSING_COMPONENT",
            subIssueId: 501,
            qty: 1,
            ticketCode: "",
            notes: "SYN-Missing Dupatta",
          },
        ],
      },
      {
        itemId: 302,
        receivedQty: 2,
        verified: true,
        issues: [
          {
            categoryCode: "CLEAR",
            subIssueId: null,
            qty: 2,
            ticketCode: "",
            notes: "",
          },
        ],
      },
    ],
  }

  const submission = submissionFrom(payload)
  assert.equal(submission.items.length, 2)
  assert.equal(submission.items[0].issues[0].subIssueId, 501)
  assert.equal(submission.items[1].receivedQty, 2)
})

// The categories the server seeds (server/schema-import.sql) with the scan-bench rule that no ticket ID is typed.
const SEEDED_CATEGORIES: CategoryRule[] = [
  { code: "no_issue", label: "No issue", isClear: true, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "missing_component", label: "Missing product or component", isClear: false, isMissing: true, requiresTicket: false, allowsSubIssue: true, requiresSubIssue: true, active: true },
  { code: "wrong_product", label: "Wrong product", isClear: false, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "damaged_product", label: "Damaged product", isClear: false, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: true },
]
const SEEDED_SUB_ISSUES: SubIssueRule[] = [{ id: 501, label: "SYN Dupatta", categoryCode: "missing_component", active: true }]

function mobileBody(issueFor: Record<number, Record<string, unknown> | null>, received: Record<number, number>) {
  return {
    shipmentId: 101,
    clientScanKey: SYN_CLIENT_SCAN_KEY,
    scannedTracking: SYN_AWB_EXACT,
    notes: "",
    items: Object.keys(received).map((id) => ({
      itemId: Number(id),
      receivedQty: received[Number(id)],
      verified: true,
      issues: issueFor[Number(id)] ? [issueFor[Number(id)]] : [],
    })),
  }
}

// This is the body the Android app builds (android/.../data/ScanPayload.kt). Its unit tests build the same shape.
test("mobile scan body: a clear line sends no issue and a missing or damaged line follows the server's category rules", () => {
  const items = [
    { id: 201, expectedQty: 1 },
    { id: 202, expectedQty: 2 },
    { id: 203, expectedQty: 1 },
  ]
  const body = mobileBody(
    {
      201: null,
      202: { categoryCode: "missing_component", subIssueId: 501, qty: 2, ticketCode: "", notes: "" },
      203: { categoryCode: "damaged_product", subIssueId: null, qty: 1, ticketCode: "", notes: "SYN torn" },
    },
    { 201: 1, 202: 0, 203: 1 },
  )
  const verdict = validateScanSubmission(items, submissionFrom(body), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES)
  assert.deepEqual(verdict, { ok: true })
})

test("mobile scan body: the uppercase codes the old app sent are refused, and a clear line must not carry an issue", () => {
  const items = [{ id: 201, expectedQty: 1 }]
  const old = mobileBody({ 201: { categoryCode: "CLEAR", subIssueId: null, qty: 1, ticketCode: "", notes: "" } }, { 201: 1 })
  const refused = validateScanSubmission(items, submissionFrom(old), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES)
  assert.equal(refused.ok, false)

  const asIssue = mobileBody({ 201: { categoryCode: "no_issue", subIssueId: null, qty: 1, ticketCode: "", notes: "" } }, { 201: 1 })
  const alsoRefused = validateScanSubmission(items, submissionFrom(asIssue), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES)
  assert.equal(alsoRefused.ok, false)
})

test("mobile scan body: a missing item must cover exactly the units not received", () => {
  const items = [{ id: 202, expectedQty: 2 }]
  const wrongQty = mobileBody(
    { 202: { categoryCode: "missing_component", subIssueId: 501, qty: 1, ticketCode: "", notes: "" } },
    { 202: 0 },
  )
  assert.equal(validateScanSubmission(items, submissionFrom(wrongQty), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES).ok, false)

  const partial = mobileBody(
    { 202: { categoryCode: "missing_component", subIssueId: 501, qty: 1, ticketCode: "", notes: "" } },
    { 202: 1 },
  )
  assert.deepEqual(validateScanSubmission(items, submissionFrom(partial), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES), { ok: true })
})

test("normalizeTracking cleans Amazon Order ID formats and barcode prefixes", () => {
  assert.equal(normalizeTracking("408-4485117-1368304").value, "408-4485117-1368304")
  assert.equal(normalizeTracking("ORD: 408-4485117-1368304").value, "408-4485117-1368304")
  assert.equal(normalizeTracking("#408-4485117-1368304").value, "408-4485117-1368304")
  assert.equal(normalizeTracking("ORDER: 40844851171368304").value, "408-4485117-1368304")
  assert.equal(normalizeTracking("40844851171368304").value, "408-4485117-1368304")
})
