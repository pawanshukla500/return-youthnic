// M7 §6/§10: Meesho portal mapping and ticket-row parsing are pure so fixtures
// can test them without a browser. SYN data only.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  MEESHO_PORTAL_ISSUE_LABELS,
  parseMeeshoTicketRow,
  resolveMeeshoIssueLabel,
  resolveMeeshoPacketLabel,
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
    assert.deepEqual(parseMeeshoTicketRow(rows, "SYN-222222222"), { statusText: "Resolved | 2026-10-02", normalizedStatus: "approved" })
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
  })

  it("infers nothing when the ticket row is absent", () => {
    assert.equal(parseMeeshoTicketRow([["SYN-1", "Resolved"]], "SYN-9"), null)
    assert.equal(parseMeeshoTicketRow([], "SYN-1"), null)
    assert.equal(parseMeeshoTicketRow([["SYN-1", "Resolved"]], ""), null)
  })
})
