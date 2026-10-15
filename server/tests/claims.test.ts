// Pure checks for the claims foundation: lifecycle statuses, validation rules, and the template field checks.
// No database. The database behaviour (scoped reads, duplicate prevention, audit) is in claims-db.test.ts.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CLAIM_STATUSES,
  claimDescriptionError,
  claimReasonError,
  claimTransitionError,
  claimTitleError,
  claimRemarksError,
  fieldCountError,
  evidenceContentError,
  fieldKeyError,
  fieldLabelError,
  fieldTypeError,
  isValidStatus,
  MAX_CLAIM_REASON,
  MAX_CLAIM_TITLE,
  MAX_CLAIM_DESCRIPTION,
  MAX_CLAIM_REMARKS,
  MAX_FIELD_KEY,
  MAX_FIELD_LABEL,
  MAX_ORIGINAL_FILENAME,
  MAX_STATUS_REASON,
  MAX_TEMPLATE_NAME,
  RETENTION_MONTHS,
  statusReasonError,
  templateNameError,
} from "../claims-service.js"
import { meeshoClaimDescription, meeshoClaimDueDate, MEESHO_PACKET_STATE } from "../meesho-claims.js"

test("the seven claim lifecycle statuses are defined in order", () => {
  assert.deepEqual([...CLAIM_STATUSES], [
    "pending_evidence",
    "ready_for_claim",
    "waiting_for_approval",
    "processing",
    "submitted",
    "failed",
    "manual_action_required",
  ])
})

test("isValidStatus accepts the seven lifecycle statuses and rejects others", () => {
  for (const s of CLAIM_STATUSES) {
    assert.equal(isValidStatus(s), true)
  }
  assert.equal(isValidStatus("draft"), false)
  assert.equal(isValidStatus("PENDING_EVIDENCE"), false, "status is case-sensitive")
  assert.equal(isValidStatus(""), false)
  assert.equal(isValidStatus("unknown"), false)
})

test("claim transitions require approval before processing and submission", () => {
  assert.equal(claimTransitionError("ready_for_claim", "waiting_for_approval"), null)
  assert.equal(claimTransitionError("waiting_for_approval", "processing"), null)
  assert.equal(claimTransitionError("processing", "submitted"), null)
  assert.match(claimTransitionError("ready_for_claim", "submitted") ?? "", /cannot move/)
  assert.match(claimTransitionError("pending_evidence", "processing") ?? "", /cannot move/)
  assert.match(claimTransitionError("waiting_for_approval", "submitted") ?? "", /cannot move/)
})

test("retention is 24 months", () => {
  assert.equal(RETENTION_MONTHS, 24)
})

test("claim reason validation", () => {
  assert.equal(claimReasonError(""), "A claim reason is required.")
  assert.equal(claimReasonError("   "), "A claim reason is required.")
  assert.equal(claimReasonError("SYN damaged product"), null)
  const long = "x".repeat(MAX_CLAIM_REASON + 1)
  assert.match(claimReasonError(long) ?? "", /200 characters or fewer/)
})

test("claim title validation", () => {
  assert.equal(claimTitleError(""), "A claim title is required.")
  assert.equal(claimTitleError("SYN wrong product received"), null)
  assert.match(claimTitleError("x".repeat(MAX_CLAIM_TITLE + 1)) ?? "", /200 characters or fewer/)
})

test("claim description validation", () => {
  assert.equal(claimDescriptionError(""), null, "empty description is allowed")
  assert.equal(claimDescriptionError("SYN description"), null)
  const long = "x".repeat(MAX_CLAIM_DESCRIPTION + 1)
  assert.match(claimDescriptionError(long) ?? "", /2000 characters or fewer/)
})

test("claim remarks validation", () => {
  assert.equal(claimRemarksError(""), null)
  assert.equal(claimRemarksError("SYN remarks"), null)
  const long = "x".repeat(MAX_CLAIM_REMARKS + 1)
  assert.match(claimRemarksError(long) ?? "", /2000 characters or fewer/)
})

test("status reason validation", () => {
  assert.equal(statusReasonError(""), null, "empty reason is allowed")
  assert.equal(statusReasonError("Moved to processing"), null)
  const long = "x".repeat(MAX_STATUS_REASON + 1)
  assert.match(statusReasonError(long) ?? "", /500 characters or fewer/)
})

test("template name validation", () => {
  assert.equal(templateNameError(""), "A template name is required.")
  assert.equal(templateNameError("   "), "A template name is required.")
  assert.equal(templateNameError("SYN template"), null)
  const long = "x".repeat(MAX_TEMPLATE_NAME + 1)
  assert.match(templateNameError(long) ?? "", /120 characters or fewer/)
})

test("field key validation: lowercase, digits, underscores only", () => {
  assert.equal(fieldKeyError(""), "A field key is required.")
  assert.equal(fieldKeyError("product_images"), null)
  assert.equal(fieldKeyError("unboxing_video_2"), null)
  assert.equal(fieldKeyError("ProductImages"), "The field key must be lowercase letters, digits, and underscores only.")
  assert.equal(fieldKeyError("product images"), "The field key must be lowercase letters, digits, and underscores only.")
  assert.equal(fieldKeyError("product-images"), "The field key must be lowercase letters, digits, and underscores only.")
  const long = "x".repeat(MAX_FIELD_KEY + 1)
  assert.match(fieldKeyError(long) ?? "", /60 characters or fewer/)
})

test("field label validation", () => {
  assert.equal(fieldLabelError(""), "A field label is required.")
  assert.equal(fieldLabelError("   "), "A field label is required.")
  assert.equal(fieldLabelError("Product images"), null)
  const long = "x".repeat(MAX_FIELD_LABEL + 1)
  assert.match(fieldLabelError(long) ?? "", /100 characters or fewer/)
})

test("field type validation", () => {
  assert.equal(fieldTypeError("image"), null)
  assert.equal(fieldTypeError("video"), null)
  assert.equal(fieldTypeError("document"), null)
  assert.equal(fieldTypeError("audio"), "The field type must be image, video, or document.")
  assert.equal(fieldTypeError(""), "The field type must be image, video, or document.")
})

test("field count validation: min and max bounds", () => {
  assert.equal(fieldCountError(1, 10), null)
  assert.equal(fieldCountError(0, 5), null)
  assert.equal(fieldCountError(3, 3), null)
  assert.equal(fieldCountError(5, 3), "The minimum count cannot exceed the maximum count.")
  assert.equal(fieldCountError(-1, 5), "The minimum count must be a non-negative whole number.")
  assert.equal(fieldCountError(1, 0), "The maximum count must be a positive whole number.")
  assert.equal(fieldCountError(1.5, 5), "The minimum count must be a non-negative whole number.")
  assert.equal(fieldCountError(1, 2.5), "The maximum count must be a positive whole number.")
})

test("evidence content validation checks file signatures", () => {
  assert.equal(evidenceContentError("image", Buffer.from([0xff, 0xd8, 0xff, 0x00])), null)
  assert.equal(evidenceContentError("document", Buffer.from("%PDF-SYN")), null)
  assert.equal(evidenceContentError("video", Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])), null)
  assert.match(evidenceContentError("image", Buffer.from("SYN-NOT-IMAGE")) ?? "", /not a supported/)
  assert.match(evidenceContentError("video", Buffer.from("SYN-NOT-VIDEO")) ?? "", /not a supported/)
})

test("max constants are sensible", () => {
  assert.equal(MAX_CLAIM_REASON, 200)
  assert.equal(MAX_CLAIM_TITLE, 200)
  assert.equal(MAX_CLAIM_DESCRIPTION, 2000)
  assert.equal(MAX_CLAIM_REMARKS, 2000)
  assert.equal(MAX_STATUS_REASON, 500)
  assert.equal(MAX_TEMPLATE_NAME, 120)
  assert.equal(MAX_FIELD_KEY, 60)
  assert.equal(MAX_FIELD_LABEL, 100)
  assert.equal(MAX_ORIGINAL_FILENAME, 255)
})

test("Meesho TAT is seven calendar days inclusive", () => {
  assert.equal(meeshoClaimDueDate("2026-01-01T06:30:00.000Z"), "2026-01-07")
  assert.equal(MEESHO_PACKET_STATE, "Tampered")
})

test("Meesho missing-item description includes the saved sub-issue and configured amount", () => {
  const description = meeshoClaimDescription("missing_items", {
    subOrderId: "SYN-SUB-1",
    awb: "SYN-AWB-1",
    packetId: "SYN-PACKET-1",
    missingItems: [{ label: "SYN-Dupatta", quantity: 1, amountEach: 100, amount: 100 }],
    missingAmount: 100,
  })
  assert.match(description, /SYN-Dupatta/)
  assert.match(description, /₹100\.00/)
  assert.match(description, /Tampered/)
  assert.match(description, /SYN-PACKET-1/)
})

test("Meesho wrong-return description includes Sub Order ID, AWB, Tampered packet state, Packet ID, and Tullipprints signature", () => {
  const description = meeshoClaimDescription("wrong_return", {
    subOrderId: "SYN-SUB-99",
    awb: "SYN-AWB-99",
    packetId: "SYN-FLYER-99",
  })
  assert.match(description, /Has received Us the wrong/i)
  assert.match(description, /SYN-SUB-99/)
  assert.match(description, /SYN-AWB-99/)
  assert.match(description, /Tampered/)
  assert.match(description, /SYN-FLYER-99/)
  assert.match(description, /Return Team Tullipprints/)
})

test("Meesho wrong-barcode-rto description includes Sub Order ID, AWB, Tampered, and Packet ID", () => {
  const description = meeshoClaimDescription("wrong_barcode_rto", {
    subOrderId: "SYN-SUB-88",
    awb: "SYN-AWB-88",
    packetId: "SYN-FLYER-88",
  })
  assert.match(description, /wrong barcoded package in RTO/i)
  assert.match(description, /SYN-SUB-88/)
  assert.match(description, /SYN-AWB-88/)
  assert.match(description, /Tampered/)
  assert.match(description, /SYN-FLYER-88/)
})

test("Meesho packet ID falls back to NA when omitted or empty", () => {
  const description = meeshoClaimDescription("wrong_return", {
    subOrderId: "SYN-SUB-77",
    awb: "SYN-AWB-77",
    packetId: "",
  })
  assert.match(description, /Packet ID: NA/)
})

