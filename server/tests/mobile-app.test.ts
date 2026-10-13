import { test } from "node:test"
import assert from "node:assert/strict"
import { getMobileReleaseInfo } from "../mobile-release.js"
import { submissionFrom } from "../register-routes.js"

// Invariant 9: Test data is synthetic, and every value starts with SYN-.
const SYN_AWB_EXACT = "SYN-1490711818486605"
const SYN_CLIENT_SCAN_KEY = "SYN-MOBILE-1-1728734000000-abcd1234"

test("mobile release manifest returns valid release configuration", () => {
  const release = getMobileReleaseInfo()
  assert.ok(release.versionCode >= 10014, "versionCode must be >= 10014")
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
