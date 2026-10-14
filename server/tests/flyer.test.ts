import test from "node:test"
import assert from "node:assert/strict"
import { flyerErrorFor, isMeeshoMarketplace, normalizeFlyer } from "../register-rules.js"

test("flyer: only the Meesho account takes a flyer", () => {
  assert.equal(isMeeshoMarketplace("Meesho"), true)
  assert.equal(isMeeshoMarketplace("meesho"), true)
  assert.equal(isMeeshoMarketplace("Myntra EJ"), false)
  assert.equal(isMeeshoMarketplace(""), false)
})

test("flyer: scientific and short flyer IDs are refused", () => {
  assert.match(normalizeFlyer("1.49E+15").error, /scientific/i)
  assert.match(normalizeFlyer("AB").error, /too short/i)
  assert.equal(normalizeFlyer("SYN-FLY-1").error, "")
  assert.equal(normalizeFlyer("SYN-FLY-1").value, "SYN-FLY-1")
})

test("flyer: Meesho issue returns need a decision, then a valid ID or an explicit unavailable", () => {
  const base = { marketplace: "Meesho", hasRealIssue: true, returnTrackingId: "SYN-AWB-1" }
  assert.match(String(flyerErrorFor({ ...base, flyerId: "", flyerState: "not_required" })), /flyer/i)
  assert.equal(flyerErrorFor({ ...base, flyerId: "SYN-FLY-1", flyerState: "scanned" }), null)
  assert.match(
    String(flyerErrorFor({ ...base, flyerId: "SYN-AWB-1", flyerState: "scanned" })),
    /differ from the return tracking/i,
  )
  assert.equal(flyerErrorFor({ ...base, flyerId: "", flyerState: "unavailable" }), null)
  assert.match(
    String(flyerErrorFor({ ...base, flyerId: "SYN-FLY-1", flyerState: "unavailable" })),
    /unavailable/i,
  )
})

test("flyer: never stored outside a Meesho issue return (clear, Iron-only, other marketplaces)", () => {
  assert.match(
    String(
      flyerErrorFor({
        marketplace: "Meesho",
        hasRealIssue: false,
        flyerId: "SYN-FLY-1",
        flyerState: "scanned",
        returnTrackingId: "SYN-AWB-1",
      }),
    ),
    /only stored for Meesho issue returns/i,
  )
  assert.match(
    String(
      flyerErrorFor({
        marketplace: "Myntra EJ",
        hasRealIssue: true,
        flyerId: "SYN-FLY-1",
        flyerState: "scanned",
        returnTrackingId: "SYN-AWB-1",
      }),
    ),
    /only stored for Meesho issue returns/i,
  )
  assert.equal(
    flyerErrorFor({
      marketplace: "Meesho",
      hasRealIssue: false,
      flyerId: "",
      flyerState: "not_required",
      returnTrackingId: "SYN-AWB-1",
    }),
    null,
  )
  assert.equal(
    flyerErrorFor({
      marketplace: "Myntra EJ",
      hasRealIssue: true,
      flyerId: "",
      flyerState: "not_required",
      returnTrackingId: "SYN-AWB-1",
    }),
    null,
  )
})
