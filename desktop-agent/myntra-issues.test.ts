import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  MYNTRA_SPF_ISSUE_LABELS,
  detectMyntraEarlyBlocker,
  extractMyntraTicketId,
  myntraSubmitClickScript,
  parseMyntraTicketRow,
  resolveMyntraIssueLabel,
  resolveMyntraUploadField,
  MyntraAutomation,
} from "./src/marketplaces/myntra.js"
import type { JobExecutionBundle } from "./src/agent-client.js"
import type { SupplierBrowserApi } from "./src/browser-adapter.js"

describe("Myntra issue reason mapping", () => {
  it("maps known claim issue codes to Myntra SPF categories", () => {
    assert.equal(resolveMyntraIssueLabel("wrong_return"), "Wrong Customer Return")
    assert.equal(resolveMyntraIssueLabel("missing_items"), "Missing Item / Components")
    assert.equal(resolveMyntraIssueLabel("wrong_barcode_rto"), "Wrong-Barcoded RTO")
    assert.equal(resolveMyntraIssueLabel("non_barcode_rto"), "Non-Barcoded RTO")
    assert.equal(resolveMyntraIssueLabel("damaged_return"), "Damaged Return")
    assert.equal(resolveMyntraIssueLabel("used_product"), "Used Product / Tag Loop Broken")
  })

  it("returns null for unknown or empty issue codes to pause for manual review", () => {
    assert.equal(resolveMyntraIssueLabel("invalid_reason"), null)
    assert.equal(resolveMyntraIssueLabel(""), null)
    assert.equal(resolveMyntraIssueLabel("  "), null)
  })
})

describe("Myntra early blocker detection", () => {
  it("flags returns that are not eligible for SPF or already claimed", () => {
    assert.ok(detectMyntraEarlyBlocker("SPF claim already filed for this return"))
    assert.ok(detectMyntraEarlyBlocker("Return not delivered to seller yet"))
    assert.ok(detectMyntraEarlyBlocker("TAT window expired: claims must be raised within 7 days"))
    assert.ok(detectMyntraEarlyBlocker("Not eligible for SPF compensation"))
  })

  it("returns null for ordinary portal text", () => {
    assert.equal(detectMyntraEarlyBlocker("Return package delivered to warehouse"), null)
    assert.equal(detectMyntraEarlyBlocker(""), null)
  })
})

describe("Myntra Ticket ID extraction", () => {
  const orderNumber = "123456789012"

  it("extracts explicit MYN-SPF, SPF, TKT, and INC references", () => {
    assert.equal(
      extractMyntraTicketId("https://partners.myntrainfo.com", "Claim recorded. Ticket: MYN-SPF-882910.", orderNumber),
      "MYN-SPF-882910",
    )
    assert.equal(
      extractMyntraTicketId("https://partners.myntrainfo.com", "SPF-772910 has been created for your return.", orderNumber),
      "SPF-772910",
    )
    assert.equal(
      extractMyntraTicketId("https://partners.myntrainfo.com", "Ticket Raised: TKT-100293.", orderNumber),
      "TKT-100293",
    )
    assert.equal(
      extractMyntraTicketId("https://partners.myntrainfo.com", "Incident recorded: INC992837.", orderNumber),
      "INC992837",
    )
  })

  it("extracts labelled ticket numbers while ignoring order digits", () => {
    const text = `Order ${orderNumber} SPF claim created. Ticket ID: 987654321.`
    assert.equal(extractMyntraTicketId("https://partners.myntrainfo.com", text, orderNumber), "987654321")
  })

  it("returns null when no distinct ticket reference is present", () => {
    const text = `Order ${orderNumber} received in hub. Awaiting claim.`
    assert.equal(extractMyntraTicketId("https://partners.myntrainfo.com", text, orderNumber), null)
  })
})

describe("Myntra ticket row parsing", () => {
  const rows = [
    ["MYN-SPF-101", "Wrong Item", "Approved", "2026-11-20"],
    ["MYN-SPF-102", "Tag Loop Broken", "Rejected: Tag missing", "2026-11-21"],
    ["MYN-SPF-103", "Missing Item", "Under Investigation", "2026-11-22"],
  ]

  it("matches rows and normalizes approved, rejected, and under_review statuses", () => {
    assert.deepEqual(parseMyntraTicketRow(rows, "MYN-SPF-101"), {
      statusText: "Wrong Item | Approved | 2026-11-20",
      normalizedStatus: "approved",
    })
    assert.deepEqual(parseMyntraTicketRow(rows, "MYN-SPF-102"), {
      statusText: "Tag Loop Broken | Rejected: Tag missing | 2026-11-21",
      normalizedStatus: "rejected",
    })
    assert.deepEqual(parseMyntraTicketRow(rows, "MYN-SPF-103"), {
      statusText: "Missing Item | Under Investigation | 2026-11-22",
      normalizedStatus: "under_review",
    })
  })

  it("returns null for unknown ticket rows", () => {
    assert.equal(parseMyntraTicketRow(rows, "MYN-SPF-999"), null)
    assert.equal(parseMyntraTicketRow([], "MYN-SPF-101"), null)
    assert.equal(parseMyntraTicketRow(rows, ""), null)
  })
})

describe("Myntra upload field mapping", () => {
  it("maps input labels to correct evidence fields including tag_loop", () => {
    assert.equal(resolveMyntraUploadField("shipping_label_input"), "label_image")
    assert.equal(resolveMyntraUploadField("outer_package_photo"), "outer_package")
    assert.equal(resolveMyntraUploadField("vms_tag_loop_photo"), "tag_loop")
    assert.equal(resolveMyntraUploadField("product_sku_image"), "product_image")
    assert.equal(resolveMyntraUploadField("unboxing_video_file"), "unboxing_video")
    assert.equal(resolveMyntraUploadField("additional_proof"), "attachment")
  })

  it("returns null for unmapped inputs", () => {
    assert.equal(resolveMyntraUploadField("custom_other_input"), null)
    assert.equal(resolveMyntraUploadField(""), null)
  })
})

describe("Myntra VB and EJ account separation", () => {
  const dummyBrowser: SupplierBrowserApi = {
    profileDirectory: "/tmp",
    async connectToPage() {},
    async send() { return {} },
    async navigate() {},
    async evaluate<T>() { return false as unknown as T },
    async captureScreenshot() { return "" },
    async detectCaptchaOrOtp() { return { challengeDetected: false } },
    async delay() {},
    async humanType() { return true },
    async humanClick() { return true },
    async clickByTextIncludes() { return true },
    async clickByExactText() { return true },
    async clickVisibleLabel() { return true },
    async clickLabelInDom() { return { clicked: true, href: "" } },
    async uploadViaChooser() { return true },
    async setFileInputFiles() { return true },
    async close() {},
  }

  function makeJob(accountName: string): JobExecutionBundle {
    return {
      jobId: 601,
      claimId: 950,
      stage: "ready_for_claim",
      claimStatus: "ready_for_claim",
      marketplace: "Myntra",
      accountName,
      portalUrl: "https://partners.myntrainfo.com/returns",
      credentials: { username: "SYN-USER", password: "SYN-PASSWORD", authState: {} },
      automationMode: "assisted",
      requireApprovalBeforeSubmit: true,
      claim: {
        orderNumber: "12345678",
        subOrderId: "12345678-1",
        trackingId: "SYN-AWB",
        packetId: "SYN-PKT",
        sku: "SYN-SKU",
        customerName: "SYN",
        totalPrice: 999,
        packetState: "Intact",
        marketplaceIssueCode: "wrong_return",
        claimReason: "Wrong item",
        claimTitle: "Title",
        claimDescription: "Desc",
        claimContent: "",
        remarks: "",
        returnType: "Customer Return",
      },
      evidenceFiles: [],
    }
  }

  it("isolates VB and EJ accounts under separate marketplace names", () => {
    const vb = new MyntraAutomation(dummyBrowser, makeJob("Myntra VB"))
    assert.equal(vb.marketplaceName, "Myntra VB")

    const ej = new MyntraAutomation(dummyBrowser, makeJob("Myntra EJ"))
    assert.equal(ej.marketplaceName, "Myntra EJ")
  })
})
