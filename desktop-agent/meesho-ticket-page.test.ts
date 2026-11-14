// Meesho per-ticket deep-link tracking: classifyMeeshoTicketPageText and
// pickLongestTicketText are pure so fixtures can test them without a browser.
// SYN data only. Vocabulary is aligned with parseMeeshoTicketRow and the server
// normalizeFollowUpStatus keys (no "response_needed" key exists server-side).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  TICKET_PAGE_TEXT_MAX_CHARS,
  classifyMeeshoTicketPageText,
  pickLongestTicketText,
} from "./src/marketplaces/meesho.js"

describe("classifyMeeshoTicketPageText", () => {
  it("classifies every status class from its keywords", () => {
    assert.deepEqual(classifyMeeshoTicketPageText("Claim rejected by Meesho"), {
      statusText: "Claim rejected by Meesho",
      normalizedStatus: "rejected",
    })
    assert.deepEqual(classifyMeeshoTicketPageText("Claim approved by Meesho"), {
      statusText: "Claim approved by Meesho",
      normalizedStatus: "approved",
    })
    // Payment-flavoured wording maps to "paid" like the table reader does.
    assert.deepEqual(classifyMeeshoTicketPageText("Refund credited to your settlement"), {
      statusText: "Refund credited to your settlement",
      normalizedStatus: "paid",
    })
    assert.deepEqual(classifyMeeshoTicketPageText("Status: In Progress"), {
      statusText: "Status: In Progress",
      normalizedStatus: "under_review",
    })
    assert.deepEqual(classifyMeeshoTicketPageText("Ticket escalated to senior team"), {
      statusText: "Ticket escalated to senior team",
      normalizedStatus: "escalated",
    })
    assert.deepEqual(classifyMeeshoTicketPageText("Ticket created"), {
      statusText: "Ticket created",
      normalizedStatus: "submitted",
    })
    assert.deepEqual(classifyMeeshoTicketPageText("Status: Open"), {
      statusText: "Status: Open",
      normalizedStatus: "submitted",
    })
  })

  it("maps response/action-needed wording to under_review and keeps the phrase in statusText", () => {
    const result = classifyMeeshoTicketPageText("Action required: please provide images of the packet")
    assert.equal(result.normalizedStatus, "under_review")
    assert.match(result.statusText, /provide/i)
    assert.equal(classifyMeeshoTicketPageText("Waiting for you to share proof").normalizedStatus, "under_review")
    assert.equal(classifyMeeshoTicketPageText("Reply required from supplier").normalizedStatus, "under_review")
  })

  it("rejected beats approved when both appear on the matching line", () => {
    assert.equal(
      classifyMeeshoTicketPageText("Your claim was rejected and is not approved by Meesho").normalizedStatus,
      "rejected",
    )
  })

  it("does not read 'not approved' as an approval", () => {
    const result = classifyMeeshoTicketPageText("Claim not approved")
    assert.equal(result.normalizedStatus, "rejected")
  })

  it("approved beats paid when both appear on the matching line (server priority)", () => {
    assert.equal(
      classifyMeeshoTicketPageText("Claim approved and refund credited").normalizedStatus,
      "approved",
    )
  })

  it("is case-insensitive", () => {
    assert.equal(classifyMeeshoTicketPageText("CLAIM REJECTED").normalizedStatus, "rejected")
    assert.equal(classifyMeeshoTicketPageText("Payment PROCESSED").normalizedStatus, "paid")
    assert.equal(classifyMeeshoTicketPageText("AWAITING UPDATE").normalizedStatus, "under_review")
  })

  it("prefers a short status-chip line over an earlier long body line", () => {
    const text = [
      "We have received your claim and it is pending review by our team while the investigation continues across several sentences.",
      "Status: Rejected",
      "Resolution: invalid claim submitted",
    ].join("\n")
    const result = classifyMeeshoTicketPageText(text)
    assert.equal(result.normalizedStatus, "rejected")
    assert.equal(result.statusText, "Status: Rejected")
  })

  it("still classifies a long body line when no chip-like line matches", () => {
    const body = "This ticket is currently in progress while our team verifies the return details end to end."
    const result = classifyMeeshoTicketPageText(body)
    assert.equal(result.normalizedStatus, "under_review")
    assert.equal(result.statusText, body)
  })

  it("caps statusText at 200 characters", () => {
    const longLine = `Rejected ${"x".repeat(300)}`
    const result = classifyMeeshoTicketPageText(longLine)
    assert.equal(result.normalizedStatus, "rejected")
    assert.equal(result.statusText.length, 200)
  })

  it("returns undefined for unknown text and for empty/whitespace text", () => {
    assert.deepEqual(classifyMeeshoTicketPageText("lorem ipsum dolor sit amet consectetur"), {
      statusText: "",
      normalizedStatus: undefined,
    })
    assert.deepEqual(classifyMeeshoTicketPageText(""), { statusText: "", normalizedStatus: undefined })
    assert.deepEqual(classifyMeeshoTicketPageText("  \n \n"), { statusText: "", normalizedStatus: undefined })
  })
})

describe("pickLongestTicketText", () => {
  it("returns the longest non-empty trimmed candidate", () => {
    assert.equal(pickLongestTicketText(["short", "", "  the longest candidate  ", "tiny"]), "the longest candidate")
  })

  it("caps the result at TICKET_PAGE_TEXT_MAX_CHARS", () => {
    const long = "x".repeat(TICKET_PAGE_TEXT_MAX_CHARS + 2000)
    assert.equal(pickLongestTicketText([long]).length, TICKET_PAGE_TEXT_MAX_CHARS)
  })

  it("returns an empty string for empty input", () => {
    assert.equal(pickLongestTicketText([]), "")
    assert.equal(pickLongestTicketText(["", "   "]), "")
  })
})
