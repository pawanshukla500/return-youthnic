import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  FLIPKART_SPF_ISSUE_LABELS,
  detectFlipkartEarlyBlocker,
  extractFlipkartIncidentId,
  flipkartSubmitClickScript,
  parseFlipkartTicketRow,
  resolveFlipkartIssueLabel,
  resolveFlipkartUploadField,
} from "./src/marketplaces/flipkart.js"

describe("Flipkart issue reason mapping", () => {
  it("maps known claim issue codes to Flipkart SPF categories", () => {
    assert.equal(resolveFlipkartIssueLabel("wrong_return"), "Wrong Item Received")
    assert.equal(resolveFlipkartIssueLabel("missing_items"), "Item Missing / Partial Item Received")
    assert.equal(resolveFlipkartIssueLabel("damaged_return"), "Damaged Product Received")
    assert.equal(resolveFlipkartIssueLabel("used_product"), "Used / Old Product Received")
    assert.equal(resolveFlipkartIssueLabel("wrong_barcode_rto"), "Wrong Item in RTO / Courier Label Tampered")
  })

  it("returns null for unknown or empty issue codes to pause for manual review", () => {
    assert.equal(resolveFlipkartIssueLabel("unknown_code"), null)
    assert.equal(resolveFlipkartIssueLabel(""), null)
    assert.equal(resolveFlipkartIssueLabel("  "), null)
  })
})

describe("Flipkart early blocker detection", () => {
  it("flags returns that are not eligible for SPF or already claimed", () => {
    assert.ok(detectFlipkartEarlyBlocker("This order is not eligible for SPF claim"))
    assert.ok(detectFlipkartEarlyBlocker("SPF claim already raised for this return"))
    assert.ok(detectFlipkartEarlyBlocker("Return in transit to hub"))
    assert.ok(detectFlipkartEarlyBlocker("Delivered more than 14 days ago"))
  })

  it("returns null for ordinary portal text", () => {
    assert.equal(detectFlipkartEarlyBlocker("Order delivered successfully on 2026-11-20"), null)
    assert.equal(detectFlipkartEarlyBlocker(""), null)
  })
})

describe("Flipkart Incident ID extraction", () => {
  const orderNumber = "OD1234567890123"

  it("extracts explicit IN-prefixed incident numbers", () => {
    const text = "Your SPF claim has been submitted. Incident ID: IN202611221234. We will investigate."
    assert.equal(extractFlipkartIncidentId("https://seller.flipkart.com", text, orderNumber), "IN202611221234")
  })

  it("extracts SPF-prefixed claim numbers", () => {
    const text = "Claim created with SPF_99887766. Status: Under Review."
    assert.equal(extractFlipkartIncidentId("https://seller.flipkart.com", text, orderNumber), "SPF_99887766")
  })

  it("ignores the order number itself when looking for digit runs", () => {
    const text = `Order ${orderNumber} SPF claim created. Ticket: 98765432101.`
    assert.equal(extractFlipkartIncidentId("https://seller.flipkart.com", text, orderNumber), "98765432101")
  })

  it("returns null when no distinct incident reference is present", () => {
    const text = `Order ${orderNumber} return processed. No incident created.`
    assert.equal(extractFlipkartIncidentId("https://seller.flipkart.com", text, orderNumber), null)
  })
})

describe("Flipkart ticket row parsing", () => {
  const rows = [
    ["IN1001", "SPF Claim - Wrong Item", "Approved", "2026-11-20"],
    ["IN1002", "SPF Claim - Damaged", "Rejected: proof insufficient", "2026-11-21"],
    ["IN1003", "SPF Claim - Missing Item", "Under Investigation", "2026-11-22"],
  ]

  it("matches rows and normalizes approved, rejected, and under_review statuses", () => {
    assert.deepEqual(parseFlipkartTicketRow(rows, "IN1001"), {
      statusText: "SPF Claim - Wrong Item | Approved | 2026-11-20",
      normalizedStatus: "approved",
    })
    assert.deepEqual(parseFlipkartTicketRow(rows, "IN1002"), {
      statusText: "SPF Claim - Damaged | Rejected: proof insufficient | 2026-11-21",
      normalizedStatus: "rejected",
    })
    assert.deepEqual(parseFlipkartTicketRow(rows, "IN1003"), {
      statusText: "SPF Claim - Missing Item | Under Investigation | 2026-11-22",
      normalizedStatus: "under_review",
    })
  })

  it("returns null for unknown ticket rows", () => {
    assert.equal(parseFlipkartTicketRow(rows, "IN9999"), null)
    assert.equal(parseFlipkartTicketRow([], "IN1001"), null)
    assert.equal(parseFlipkartTicketRow(rows, ""), null)
  })
})

describe("Flipkart upload field mapping", () => {
  it("maps input labels to correct evidence fields", () => {
    assert.equal(resolveFlipkartUploadField("shipping_label_file"), "label_image")
    assert.equal(resolveFlipkartUploadField("outer_box_photo"), "outer_box")
    assert.equal(resolveFlipkartUploadField("product_item_image"), "product_image")
    assert.equal(resolveFlipkartUploadField("unboxing_video_file"), "unboxing_video")
    assert.equal(resolveFlipkartUploadField("supporting_documents"), "attachment")
  })

  it("returns null for unmapped inputs", () => {
    assert.equal(resolveFlipkartUploadField("unknown_random_id"), null)
    assert.equal(resolveFlipkartUploadField(""), null)
  })
})

describe("Flipkart Submit click script", () => {
  class MockElement {
    clicked = false
    constructor(
      readonly tagName: string,
      readonly textContent: string,
      readonly value = "",
      readonly disabled = false,
      readonly ariaDisabled: string | null = null,
      readonly offsetParent: object | null = {},
    ) {}
    getAttribute(name: string): string | null {
      return name === "aria-disabled" ? this.ariaDisabled : null
    }
    getBoundingClientRect(): { width: number; height: number } {
      return { width: 100, height: 30 }
    }
    scrollIntoView(): void {}
    click(): void {
      this.clicked = true
    }
  }

  function run(nodes: MockElement[]): MockElement | undefined {
    const document = { querySelectorAll: () => nodes }
    const window = { HTMLInputElement: function HTMLInputElement() {} }
    const fn = new Function("document", "window", "HTMLInputElement", `${flipkartSubmitClickScript()};`)
    fn(document, window, window.HTMLInputElement)
    return nodes.find((n) => n.clicked)
  }

  it("clicks only an enabled Submit or Submit Claim button", () => {
    const enabledSubmit = new MockElement("button", "Submit Claim")
    const disabledSubmit = new MockElement("button", "Submit Claim", "", true)
    const cancelBtn = new MockElement("button", "Cancel")

    assert.equal(run([disabledSubmit, cancelBtn, enabledSubmit]), enabledSubmit)
  })
})
