import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  MEESHO_SCENARIOS,
  resolveMeeshoScenario,
  analyzeMeeshoFollowUpResponse,
  isMeeshoTicketTerminal,
  MEESHO_LEARNED_RECOVERY_PROCEDURES,
} from "./src/marketplaces/meesho-scenarios.js"

describe("Meesho Claim Scenarios Registry & Verification Rules", () => {
  it("resolves all 6 core Meesho claim scenarios with strict evidence rules", () => {
    const wrong = resolveMeeshoScenario("wrong_return")
    assert.equal(wrong.id, "customer_wrong_return")
    assert.equal(wrong.portalCategoryLabel, "I have received wrong return")
    assert.deepEqual(wrong.mandatoryUploads, ["reverse_waybill", "product_images", "unboxing_video"])

    const missing = resolveMeeshoScenario("missing_items")
    assert.equal(missing.id, "customer_missing_items")
    assert.equal(missing.portalCategoryLabel, "Item/s are missing in my return")
    assert.equal(missing.requiredPacketState, "Tampered")
    assert.deepEqual(missing.mandatoryUploads, ["reverse_waybill", "unboxing_video", "attachments"])

    const damaged = resolveMeeshoScenario("damaged", "customer")
    assert.equal(damaged.id, "customer_damaged_return")
    assert.equal(damaged.portalCategoryLabel, "I have received damaged return")
    assert.equal(damaged.requiredPacketState, "Intact")

    const used = resolveMeeshoScenario("used")
    assert.equal(used.id, "customer_used_return")
    assert.equal(used.portalCategoryLabel, "I have received used return")

    const courierWrong = resolveMeeshoScenario("courier_return", "courier")
    assert.equal(courierWrong.id, "courier_wrong_barcode")
    assert.equal(courierWrong.portalCategoryLabel, "I have received wrong barcoded RTO")
    assert.equal(courierWrong.returnType, "courier")

    const courierDamaged = resolveMeeshoScenario("damaged", "courier")
    assert.equal(courierDamaged.id, "courier_damaged_rto")
    assert.equal(courierDamaged.portalCategoryLabel, "Damaged RTO received")
  })

  it("generates strict factual claim descriptions without inventing details", () => {
    const scenario = MEESHO_SCENARIOS.customer_wrong_return
    const desc = scenario.descriptionTemplate({
      subOrderId: "345847242806503426_1",
      awb: "R2775598956MEO",
      packetState: "Tampered",
      receivedItem: "Old Cotton Kurti",
      expectedItem: "Silk Embroidered Anarkali",
      notes: "Customer returned worn local dress",
    })

    assert.ok(desc.includes("Sub-Order 345847242806503426_1"))
    assert.ok(desc.includes("AWB: R2775598956MEO"))
    assert.ok(desc.includes("Tampered"))
    assert.ok(desc.includes('Received item: "Old Cotton Kurti"'))
    assert.ok(desc.includes('Expected item: "Silk Embroidered Anarkali"'))
    assert.ok(desc.includes("Customer returned worn local dress"))
    assert.ok(desc.includes("Requesting full SPF compensation."))
  })
})

describe("Meesho Follow-Up Response Tracking & Action Detection", () => {
  it("detects request for additional unboxing video", () => {
    const analysis = analyzeMeeshoFollowUpResponse(
      "Dear Seller, please upload unboxing video showing the reverse shipping label clearly.",
      "Action Required",
    )
    assert.equal(analysis.needsSellerResponse, true)
    assert.equal(analysis.responseType, "video_proof")
    assert.equal(analysis.isActionRequired, true)
  })

  it("detects request for clear waybill label image", () => {
    const analysis = analyzeMeeshoFollowUpResponse(
      "Please share clear image of reverse waybill to process SPF claim.",
      "Pending Details",
    )
    assert.equal(analysis.needsSellerResponse, true)
    assert.equal(analysis.responseType, "clear_waybill")
    assert.equal(analysis.isActionRequired, true)
  })

  it("detects request for outer box photos", () => {
    const analysis = analyzeMeeshoFollowUpResponse(
      "Please provide clear photos of all 6 sides of the outer packaging.",
      "Under Review",
    )
    assert.equal(analysis.needsSellerResponse, true)
    assert.equal(analysis.responseType, "outer_box_photo")
    assert.equal(analysis.isActionRequired, true)
  })

  it("detects general action required or reply deadline", () => {
    const analysis = analyzeMeeshoFollowUpResponse(
      "Action required: Waiting for your reply within 24 hours.",
      "Action Required",
    )
    assert.equal(analysis.needsSellerResponse, true)
    assert.equal(analysis.responseType, "general_reply")
    assert.equal(analysis.isActionRequired, true)
  })

  it("returns false when ticket is under normal review without seller action demand", () => {
    const analysis = analyzeMeeshoFollowUpResponse(
      "Your ticket has been assigned to a specialist and is currently under review.",
      "In Progress",
    )
    assert.equal(analysis.needsSellerResponse, false)
    assert.equal(analysis.responseType, "none")
    assert.equal(analysis.isActionRequired, false)
  })
})

describe("Meesho Ticket Terminal Closure Guard", () => {
  it("marks ticket terminal ONLY when approved, rejected, paid, or reconciled", () => {
    assert.equal(isMeeshoTicketTerminal("approved"), true)
    assert.equal(isMeeshoTicketTerminal("Approved"), true)
    assert.equal(isMeeshoTicketTerminal("rejected"), true)
    assert.equal(isMeeshoTicketTerminal("Rejected"), true)
    assert.equal(isMeeshoTicketTerminal("paid"), true)
    assert.equal(isMeeshoTicketTerminal("reconciled"), true)
    assert.equal(isMeeshoTicketTerminal("closed"), true)
    assert.equal(isMeeshoTicketTerminal("resolved"), true)
  })

  it("keeps ticket ACTIVE for all non-terminal in-progress or review states", () => {
    assert.equal(isMeeshoTicketTerminal("submitted"), false)
    assert.equal(isMeeshoTicketTerminal("under_review"), false)
    assert.equal(isMeeshoTicketTerminal("in_progress"), false)
    assert.equal(isMeeshoTicketTerminal("action_required"), false)
    assert.equal(isMeeshoTicketTerminal("needs_response"), false)
    assert.equal(isMeeshoTicketTerminal("escalated"), false)
  })
})

describe("Meesho Machine-Learned Recovery Procedures", () => {
  it("contains pre-approved recovery memory for portal failure modes", () => {
    assert.ok(MEESHO_LEARNED_RECOVERY_PROCEDURES.length >= 4)
    for (const proc of MEESHO_LEARNED_RECOVERY_PROCEDURES) {
      assert.equal(proc.marketplace, "Meesho")
      assert.equal(proc.status, "approved")
      assert.ok(proc.steps.length > 0)
      assert.ok(proc.errorSignature.length > 0)
    }
  })
})
