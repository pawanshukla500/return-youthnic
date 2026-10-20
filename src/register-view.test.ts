import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildQuery,
  DEFAULT_SORT,
  EMPTY_FILTERS,
  flyerLabel,
  issueText,
  matchedText,
  parseRegisterTab,
  subIssueText,
  ticketStatusTone,
  tickets,
  unique,
  VIEW_TABS,
} from "./register-view.js"
import type { RegisterIssue, RegisterRow, RegisterTicket } from "./types.js"

function issue(label: string, sub = "", ticket: RegisterTicket | null = null): RegisterIssue {
  return { categoryCode: "SYN", categoryLabel: label, subIssueLabel: sub, qty: 1, notes: "", ticket }
}

function ticket(id: number): RegisterTicket {
  return { id, code: `SYN-T-${id}`, status: "Raised", rejectionReason: "" }
}

function baseRow(issues: RegisterIssue[]): RegisterRow {
  return {
    key: "SYN-row-1",
    source: "item",
    scanId: 1,
    scannedAt: "2026-10-20T07:00:00.000Z",
    scanDay: "20/10/2026",
    scanTime: "12:30 PM",
    scanStatus: "verified",
    scannedBy: "SYN-Scanner",
    marketplaceId: 1,
    marketplace: "Amazon",
    trackingId: "SYN-AWB-1",
    originalTrackingId: "",
    urlTrackingId: "",
    trackingSource: "tracking_id",
    forwardTrackingId: "",
    returnEventId: "",
    scannedTracking: "SYN-AWB-1",
    orderId: "SYN-ORDER-1",
    orderItemId: "SYN-ITEM-1",
    displayIdentifierKind: "order_line",
    marketplaceSku: "SYN-MSKU-1",
    productSku: "SYN-PSKU-1",
    productSkuSource: "",
    marketplaceSkuIdentifier: "",
    productName: "",
    logisticPartner: "",
    partnerMethod: "none",
    trackingValidation: "not_applicable",
    matchedTrackingField: "",
    matchedLeg: "",
    returnType: "",
    returnTypeRaw: "",
    returnReason: "",
    expectedQty: 1,
    receivedQty: 1,
    sourceFile: "",
    sourceBatchId: null,
    amount: null,
    claimAmount: null,
    issues,
  }
}

// Characterization pins: these lock the register page's current data
// behavior so the rebuild cannot silently change filters, labels, or tabs.

describe("register-view query", () => {
  it("skips empty filters and trims values", () => {
    const query = buildQuery({ ...EMPTY_FILTERS, tracking: "  SYN-AWB-9  " }, DEFAULT_SORT)
    assert.equal(query, "tracking=SYN-AWB-9&sort=scanned_at&direction=desc")
  })

  it("adds pagination only when a page is given", () => {
    assert.ok(buildQuery(EMPTY_FILTERS, DEFAULT_SORT, 3).includes("page=3&pageSize=50"))
    assert.ok(!buildQuery(EMPTY_FILTERS, DEFAULT_SORT).includes("page="))
  })

  it("sorts Amount through the server amount column", () => {
    assert.equal(buildQuery(EMPTY_FILTERS, { key: "amount", direction: "asc" }), "sort=amount&direction=asc")
  })

  it("omits sort params for unknown sort keys", () => {
    assert.equal(buildQuery(EMPTY_FILTERS, { key: "claimAmount", direction: "asc" }), "")
  })
})

describe("register-view labels", () => {
  it("unique drops blanks and duplicates", () => {
    assert.deepEqual(unique(["a", "", "b", "a"]), ["a", "b"])
  })

  it("issueText says No issue when there are none", () => {
    assert.equal(issueText(baseRow([])), "No issue")
    assert.equal(issueText(baseRow([issue("SYN-Missing"), issue("SYN-Missing")])), "SYN-Missing")
  })

  it("subIssueText joins distinct sub-issues", () => {
    assert.equal(subIssueText(baseRow([issue("SYN-Missing", "SYN-Short"), issue("SYN-Missing")])), "SYN-Short")
  })

  it("tickets dedupes by id and skips ticketless issues", () => {
    const found = tickets(baseRow([issue("a", "", ticket(7)), issue("b", "", ticket(7)), issue("c")]))
    assert.equal(found.length, 1)
    assert.equal(found[0].code, "SYN-T-7")
  })

  it("ticketStatusTone maps lifecycle states", () => {
    assert.equal(ticketStatusTone("Approved"), "success")
    assert.equal(ticketStatusTone("Rejected"), "danger")
    assert.equal(ticketStatusTone("Review"), "warning")
    assert.equal(ticketStatusTone("Raised"), "warning")
    assert.equal(ticketStatusTone("AnythingElse"), "neutral")
  })

  it("flyerLabel prefers the captured ID, then the bench outcome", () => {
    assert.equal(flyerLabel("SYN-FLY-1", "scanned"), "SYN-FLY-1")
    assert.equal(flyerLabel("", "unavailable"), "Unavailable at bench")
    assert.equal(flyerLabel("", "scanned"), "—")
    assert.equal(flyerLabel(undefined, undefined), "Not required")
  })

  it("matchedText covers field and leg variants", () => {
    const base = baseRow([])
    assert.equal(matchedText(base), "Not recorded")
    assert.equal(
      matchedText({ ...base, matchedTrackingField: "alt_tracking_id", matchedLeg: "forward" }),
      "Forward (alternate) AWB, forward leg",
    )
    assert.equal(
      matchedText({ ...base, matchedTrackingField: "tracking_id", matchedLeg: "return" }),
      "Primary AWB, return leg",
    )
    assert.equal(
      matchedText({ ...base, matchedTrackingField: "order_number", matchedLeg: "" }),
      "Order ID, leg not known",
    )
    assert.equal(
      matchedText({ ...base, matchedTrackingField: "unknown_field", matchedLeg: "return" }),
      "Not recorded, return leg",
    )
  })
})

describe("register-view tabs", () => {
  it("defines four tabs in order with stable keys", () => {
    assert.deepEqual(
      VIEW_TABS.map((tab) => tab.key),
      ["register", "analytics", "shopify", "omsguru"],
    )
  })

  it("parses the tab query param, unknown tabs fall back to register", () => {
    assert.equal(parseRegisterTab("analytics"), "analytics")
    assert.equal(parseRegisterTab("omsguru"), "omsguru")
    assert.equal(parseRegisterTab("shopify"), "shopify")
    assert.equal(parseRegisterTab(null), "register")
    assert.equal(parseRegisterTab("reasons"), "register")
    assert.equal(parseRegisterTab("sizing"), "register")
    assert.equal(parseRegisterTab("nope"), "register")
  })
})
