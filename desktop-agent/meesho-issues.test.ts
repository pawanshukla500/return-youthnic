// M7 §6/§10: Meesho portal mapping and ticket-row parsing are pure so fixtures
// can test them without a browser. SYN data only.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import {
  MeeshoAutomation,
  MEESHO_PORTAL_ISSUE_LABELS,
  checkMeeshoEvidenceFileLocal,
  findExistingTicketForOrder,
  parseMeeshoTicketRow,
  extractMeeshoResolution,
  resolveMeeshoIssueLabel,
  resolveMeeshoPacketLabel,
  resolveMeeshoUploadField,
  summarizeMeeshoUploadFailures,
} from "./src/marketplaces/meesho.js"

describe("Meesho portal issue mapping", () => {
  it("maps every known claim issue code to a portal label", () => {
    assert.equal(resolveMeeshoIssueLabel("wrong_return"), "I have received wrong return")
    assert.equal(resolveMeeshoIssueLabel("missing_items"), "Item/s are missing in my return")
    assert.equal(resolveMeeshoIssueLabel("wrong_barcode_rto"), "I have received a wrong barcoded package in RTO")
    assert.equal(resolveMeeshoIssueLabel("damaged_return"), "I have received damaged return")
    assert.equal(resolveMeeshoIssueLabel("used_product"), "I have received used product as return")
  })

  it("refuses to map unknown or missing issue codes instead of substituting", () => {
    assert.equal(resolveMeeshoIssueLabel("other"), null)
    assert.equal(resolveMeeshoIssueLabel(""), null)
    assert.equal(resolveMeeshoIssueLabel("  "), null)
    assert.equal(Object.keys(MEESHO_PORTAL_ISSUE_LABELS).length, 5)
  })
})

describe("Meesho parcel-condition mapping", () => {
  it("accepts only verified Intact/Tampered observations", () => {
    assert.equal(resolveMeeshoPacketLabel("Intact"), "Intact")
    assert.equal(resolveMeeshoPacketLabel("tampered"), "Tampered")
    assert.equal(resolveMeeshoPacketLabel("  TAMPERED  "), "Tampered")
  })

  it("rejects Unknown and missing conditions so filing stops for review", () => {
    assert.equal(resolveMeeshoPacketLabel("Unknown"), null)
    assert.equal(resolveMeeshoPacketLabel(""), null)
    assert.equal(resolveMeeshoPacketLabel("crushed"), null)
  })
})

describe("Meesho ticket-row parsing", () => {
  it("returns the row status text for the matching ticket", () => {
    const rows = [
      ["SYN-111111111", "In Progress", "2026-10-01"],
      ["SYN-222222222", "Resolved", "2026-10-02"],
    ]
    // A bare Resolved row carries no approval hint: the server decides from the raw text.
    assert.deepEqual(parseMeeshoTicketRow(rows, "SYN-222222222"), { statusText: "Resolved | 2026-10-02" })
  })

  it("flags unambiguous paid and rejected wording only", () => {
    assert.deepEqual(parseMeeshoTicketRow([["SYN-1", "Claim Paid"]], "SYN-1"), {
      statusText: "Claim Paid",
      normalizedStatus: "paid",
    })
    assert.deepEqual(parseMeeshoTicketRow([["SYN-1", "Rejected: not eligible"]], "SYN-1"), {
      statusText: "Rejected: not eligible",
      normalizedStatus: "rejected",
    })
    assert.deepEqual(parseMeeshoTicketRow([["SYN-1", "Under Review"]], "SYN-1"), {
      statusText: "Under Review",
    })
    // A bare Completed row is progress narration, not approval evidence.
    assert.deepEqual(parseMeeshoTicketRow([["SYN-1", "Completed"]], "SYN-1"), {
      statusText: "Completed",
    })
  })

  it("infers nothing when the ticket row is absent", () => {
    assert.equal(parseMeeshoTicketRow([["SYN-1", "Resolved"]], "SYN-9"), null)
    assert.equal(parseMeeshoTicketRow([], "SYN-1"), null)
    assert.equal(parseMeeshoTicketRow([["SYN-1", "Resolved"]], ""), null)
  })
})

describe("Meesho already-filed check", () => {
  it("finds the portal ticket already raised for the order", () => {
    const rows = [
      ["SYN-111111111", "In Progress", "2026-10-01"],
      ["9876543210123", "Sub Order 1234567890123", "Raised", "2026-10-02"],
    ]
    assert.equal(findExistingTicketForOrder(rows, ["1234567890123"]), "9876543210123")
  })

  it("ignores order and AWB digit runs when there is no separate ticket", () => {
    const rows = [
      ["Sub Order 1234567890123", "No tickets yet"],
    ]
    assert.equal(findExistingTicketForOrder(rows, ["1234567890123", "AWB-9988776655443"]), null)
  })

  it("returns null when no order reference matches or nothing is listed", () => {
    assert.equal(findExistingTicketForOrder([["9990001112223", "Raised"]], ["1234567890123"]), null)
    assert.equal(findExistingTicketForOrder([], ["1234567890123"]), null)
    assert.equal(findExistingTicketForOrder([["1234567890123", "Raised"]], []), null)
    assert.equal(findExistingTicketForOrder([["1234567890123", "Raised"]], [undefined, null, ""]), null)
  })
})

describe("Meesho upload-field mapping (M9 Phase 6: Claim #1 regression)", () => {
  it("maps the five production upload boxes to their evidence fields", () => {
    assert.equal(resolveMeeshoUploadField("barcode_image_link_6"), "barcode_image")
    assert.equal(resolveMeeshoUploadField("product_image_link_7"), "product_images")
    assert.equal(resolveMeeshoUploadField("product_reverse_way_bill_link_8"), "reverse_waybill")
    assert.equal(resolveMeeshoUploadField("product_openingvideo_link_9"), "unboxing_video")
    assert.equal(resolveMeeshoUploadField("attachments_12"), "attachments")
  })

  it("returns null for empty or unknown inputs instead of guessing", () => {
    assert.equal(resolveMeeshoUploadField(""), null)
    assert.equal(resolveMeeshoUploadField("some_random_box"), null)
  })

  it("rejects missing, empty, and wrong-MIME local evidence files", async () => {
    const { default: fs } = await import("node:fs")
    const { default: os } = await import("node:os")
    const { default: path } = await import("node:path")
    assert.equal(checkMeeshoEvidenceFileLocal("D:/no-such-dir/SYN-missing.jpg").ok, false)
    assert.equal(checkMeeshoEvidenceFileLocal("D:/no-such-dir/SYN-missing.jpg").reason, "file missing on disk")
    // Wrong MIME: a real non-empty .txt file must be rejected by extension.
    const tmpTxt = path.join(os.tmpdir(), `SYN-meesho-mime-${Date.now()}.txt`)
    fs.writeFileSync(tmpTxt, "SYN not an image")
    try {
      const mimeCheck = checkMeeshoEvidenceFileLocal(tmpTxt)
      assert.equal(mimeCheck.ok, false)
      assert.ok(mimeCheck.reason.includes("MIME"))
    } finally {
      fs.rmSync(tmpTxt, { force: true })
    }
    // Empty file: a real zero-byte .jpg must be rejected, not attached.
    const tmpEmpty = path.join(os.tmpdir(), `SYN-meesho-empty-${Date.now()}.jpg`)
    fs.writeFileSync(tmpEmpty, "")
    try {
      const emptyCheck = checkMeeshoEvidenceFileLocal(tmpEmpty)
      assert.equal(emptyCheck.ok, false)
      assert.ok(emptyCheck.reason.includes("empty"))
    } finally {
      fs.rmSync(tmpEmpty, { force: true })
    }
  })

  it("names the exact failed field and attachment status for the claim panel", () => {
    const summary = summarizeMeeshoUploadFailures([
      { inputId: "barcode_image_link_6", field: "barcode_image", ok: false, reason: "no portal acknowledgement (files=1, no file name/thumbnail/success chip nearby)", attachedCount: 1, portalAck: false },
      { inputId: "attachments_12", field: "attachments", ok: false, reason: "DOM.setFileInputFiles rejected the files", attachedCount: 0, portalAck: false },
    ])
    assert.ok(summary.includes("#barcode_image_link_6 (barcode_image)"))
    assert.ok(summary.includes("#attachments_12 (attachments)"))
    assert.ok(summary.includes("portalAck=no"))
  })
})

describe("Meesho ticket resolution and rejection reason extraction", () => {
  it("extracts rejection reason from agent remarks and resolution notes", () => {
    const text1 = "Ticket #123456789. Rejection reason: AWB / Reverse waybill barcode is not clear or missing. Please refer to return guidelines."
    const res1 = extractMeeshoResolution(text1)
    assert.equal(res1.rejectionReason, "AWB / Reverse waybill barcode is not clear or missing")

    const text2 = "Your claim has been reviewed. Claim rejected due to: Unboxing video does not display full package condition from all sides."
    const res2 = extractMeeshoResolution(text2)
    assert.equal(res2.rejectionReason, "Unboxing video does not display full package condition from all sides")

    const text3 = "Reason for rejection: Claim raised after the 7 day policy window."
    const res3 = extractMeeshoResolution(text3)
    assert.equal(res3.rejectionReason, "Claim raised after the 7 day policy window")
  })

  it("extracts approved compensation amount when present", () => {
    const text1 = "Ticket #987654321. Approved amount of ₹549 will be credited to your bank account within 3 business days."
    const res1 = extractMeeshoResolution(text1)
    assert.equal(res1.approvedAmount, 549)

    const text2 = "Resolution note: Compensation: Rs. 1,299.50 approved by claims department."
    const res2 = extractMeeshoResolution(text2)
    assert.equal(res2.approvedAmount, 1299.5)

    const text3 = "Claim Approved. ₹850 credited to supplier balance."
    const res3 = extractMeeshoResolution(text3)
    assert.equal(res3.approvedAmount, 850)

    const text4 = "Claim approved for ₹749."
    const res4 = extractMeeshoResolution(text4)
    assert.equal(res4.approvedAmount, 749)
  })

  it("handles empty or uninformative resolution text gracefully", () => {
    assert.deepEqual(extractMeeshoResolution(""), {})
    assert.deepEqual(extractMeeshoResolution("Under investigation"), {})
  })
})

class TestableMeeshoAutomation extends MeeshoAutomation {
  getExposedEvidenceMap(): Map<string, string[]> {
    return this.evidenceFilesMap
  }
  getExposedWorkDir(): string {
    return this.workDir
  }
}

describe("MeeshoAutomation and BaseMarketplaceAutomation defaults", () => {
  it("initializes with default evidenceFilesMap and workDir when optional arguments are omitted", () => {
    const mockBrowser: any = {}
    const mockJob: any = { jobId: 1, claimId: 1, claim: {} }
    const automation = new TestableMeeshoAutomation(mockBrowser, mockJob)
    assert.equal(automation.marketplaceName, "Meesho")
    assert.ok(automation.getExposedEvidenceMap() instanceof Map)
    assert.equal(automation.getExposedEvidenceMap().size, 0)
    assert.equal(automation.getExposedWorkDir(), os.tmpdir())
  })
})
