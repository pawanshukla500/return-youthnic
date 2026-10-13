// SYNTHETIC FIXTURES ONLY. Partner names are the carriers named in the marketplace samples. The 16-digit AWBs are invented
// and built the way a spreadsheet rounds a 16-digit number to 15 significant digits. No database is used.
//
// Run: npm test

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  aliasKey,
  awbFromTrackingUrl,
  detectPartner,
  type PartnerIndex,
  listingSkuCandidates,
  compactSkuKey,
  parentListingSku,
  marketplaceRank,
  normalizeHeader,
  normalizeReturnType,
  parseTrackingLink,
  resolveTrackingId,
  returnTypeKey,
  returnTypeWarning,
  roundToFifteenDigits,
  skuWithVariation,
  UNKNOWN_PARTNER,
} from "../marketplace-rules.js"

// ---------- Product master marketplace scope ----------

test("[synthetic] marketplaceRank prefers the exact account, then a scope that names it, then all, never another account", () => {
  // The exact account wins.
  assert.equal(marketplaceRank("Myntra VB", "myntra vb"), 3)
  // A generic scope that names the account is used for it.
  assert.equal(marketplaceRank("myntra", "Myntra VB"), 2)
  // The reverse direction is symmetric.
  assert.equal(marketplaceRank("Myntra VB", "myntra"), 2)
  // All, and a blank scope, apply to every account.
  assert.equal(marketplaceRank("all", "Myntra VB"), 1)
  assert.equal(marketplaceRank("", "Myntra VB"), 1)
  // A different account is never used.
  assert.equal(marketplaceRank("flipkart", "Myntra VB"), 0)
  assert.equal(marketplaceRank("Myntra EJ", "Myntra VB"), 0)
})

test("[synthetic] marketplaceRank matches whole words only, so a short scope does not leak to every account", () => {
  // "ej" is not a whole word inside "myntra ej vb", so it must not apply.
  assert.equal(marketplaceRank("ej", "Myntra VB"), 0)
  // But a real account name that contains it as a word does match.
  assert.equal(marketplaceRank("ej", "EJ"), 3)
  assert.equal(marketplaceRank("myntra", "Myntra EJ"), 2)
  assert.equal(marketplaceRank("ej", "Myntra EJ"), 2)
})

// ---------- Headers and keys ----------

test("[synthetic] header names match regardless of case, spaces, hyphens, and underscores", () => {
  assert.equal(normalizeHeader("Return AWB No"), "return_awb_no")
  assert.equal(normalizeHeader("return-awb-no"), "return_awb_no")
  assert.equal(normalizeHeader("  Return_AWB__No  "), "return_awb_no")
  assert.equal(normalizeHeader("﻿Seller_Id"), "seller_id")
  assert.equal(normalizeHeader("Reverse Leg Tracking ID"), "reverse_leg_tracking_id")
  assert.equal(normalizeHeader("mSKU"), "msku")
})

test("[synthetic] return type keys turn any punctuation into one underscore", () => {
  assert.equal(returnTypeKey("Courier Return (RTO)"), "courier_return_rto")
  assert.equal(returnTypeKey("CUSTOMER_RETURN"), "customer_return")
  assert.equal(returnTypeKey("  RVP  "), "rvp")
})

test("[synthetic] alias keys keep letters and digits only", () => {
  assert.equal(aliasKey("Xpress Bees"), "xpressbees")
  assert.equal(aliasKey("delhivery-COD"), "delhiverycod")
})

// ---------- Return types: every mapping in the specification and confirmed by the samples ----------

test("[synthetic] Myntra: Return maps to Customer Return, RTO maps to RTO", () => {
  assert.deepEqual(normalizeReturnType("Myntra EJ", "Return"), { value: "Customer Return", known: true })
  assert.deepEqual(normalizeReturnType("Myntra VB", "RTO"), { value: "RTO", known: true })
})

test("[synthetic] Ajio: RVP maps to Customer Return, RTO to RTO, REPL to Replacement Order", () => {
  assert.equal(normalizeReturnType("Ajio", "RVP").value, "Customer Return")
  assert.equal(normalizeReturnType("Ajio", "RTO").value, "RTO")
  assert.equal(normalizeReturnType("Ajio", "REPL").value, "Replacement Order")
})

test("[synthetic] Amazon: CUSTOMER_RETURN maps to Customer Return, UNDELIVERED to RTO", () => {
  assert.equal(normalizeReturnType("Amazon", "CUSTOMER_RETURN").value, "Customer Return")
  assert.equal(normalizeReturnType("Amazon", "UNDELIVERED").value, "RTO")
})

test("[synthetic] Flipkart: customer_return maps to Customer Return, courier_return to RTO", () => {
  assert.equal(normalizeReturnType("Flipkart", "customer_return").value, "Customer Return")
  assert.equal(normalizeReturnType("Flipkart", "courier_return").value, "RTO")
})

test("[synthetic] Meesho: Customer Return maps to Customer Return, Courier Return (RTO) to RTO", () => {
  assert.equal(normalizeReturnType("Meesho", "Customer Return").value, "Customer Return")
  assert.equal(normalizeReturnType("Meesho", "Courier Return (RTO)").value, "RTO")
})

test("[synthetic] a code from another marketplace's list is unknown here, not borrowed", () => {
  const result = normalizeReturnType("Meesho", "RVP")
  assert.deepEqual(result, { value: "RVP", known: false })
  assert.match(returnTypeWarning(result, "RVP"), /Unknown return type "RVP"/)
})

test("[synthetic] a blank return type is flagged, and an inherited property name is never a mapping", () => {
  assert.deepEqual(normalizeReturnType("Ajio", ""), { value: "", known: false })
  assert.equal(returnTypeWarning({ value: "", known: false }, ""), "Return type is blank")
  assert.equal(normalizeReturnType("Ajio", "constructor").known, false)
  assert.equal(normalizeReturnType("No Such Channel", "toString").known, false)
})

// ---------- SKU and variation ----------

test("[synthetic] a variation is added with an underscore when the SKU does not end with it", () => {
  assert.deepEqual(skuWithVariation("SYN-KURTA-RED", "M"), { value: "SYN-KURTA-RED_M", appended: true })
})

test("[synthetic] a variation already at the end of the SKU is not added again", () => {
  assert.deepEqual(skuWithVariation("SYN-KURTA-RED_M", "M"), { value: "SYN-KURTA-RED_M", appended: false })
  assert.deepEqual(skuWithVariation("SYN-KURTA-M", "M"), { value: "SYN-KURTA-M", appended: false })
  assert.deepEqual(skuWithVariation("SYN-KURTA FREE SIZE", "Free Size"), { value: "SYN-KURTA FREE SIZE", appended: false })
})

test("[synthetic] a size letter inside a longer word is not a suffix", () => {
  assert.deepEqual(skuWithVariation("SYN-KURTA-XM", "M"), { value: "SYN-KURTA-XM_M", appended: true })
})

test("[synthetic] a blank variation leaves the SKU unchanged, and a blank SKU stays blank", () => {
  assert.deepEqual(skuWithVariation("SYN-KURTA", ""), { value: "SYN-KURTA", appended: false })
  assert.deepEqual(skuWithVariation("", "M"), { value: "", appended: false })
})

test("[synthetic] an article suffix is also looked up as the parent listing", () => {
  assert.deepEqual(listingSkuCandidates("B126-kabira-Bottle Green_S_A"), [
    "B126-kabira-Bottle Green_S_A",
    "B126-kabira-BottleGreen_S_A",
    "B126-kabira-Bottle Green_S",
    "B126-kabira-BottleGreen_S",
  ])
  assert.equal(parentListingSku("T26-Bubbly-Pink_XL"), "")
  assert.equal(parentListingSku("T86-Coffee-Rust_M_Al"), "T86-Coffee-Rust_M")
  assert.equal(compactSkuKey("B126-kabira-Bottle Green_S"), "b126-kabira-bottlegreen_s")
})

test("[synthetic] a variation with regular-expression characters is matched literally", () => {
  assert.deepEqual(skuWithVariation("SYN-A.B", "A.B"), { value: "SYN-A.B", appended: false })
  assert.deepEqual(skuWithVariation("SYN-AXB", "A.B"), { value: "SYN-AXB_A.B", appended: true })
})

// ---------- Carrier tracking links: formats confirmed by the Meesho sample ----------

test("[synthetic] the Delhivery track host reads the AWB from /p/<AWB>", () => {
  assert.deepEqual(awbFromTrackingUrl("https://track.delhivery.com/p/9000000000000003"), {
    host: "track.delhivery.com",
    awb: "9000000000000003",
  })
})

test("[synthetic] the www.delhivery.com host reads the AWB from /track/package/<AWB> (format in Meesho.csv)", () => {
  const parsed = parseTrackingLink("https://www.delhivery.com/track/package/9000000000000003")
  assert.equal(parsed.status, "ok")
  if (parsed.status === "ok") {
    assert.equal(parsed.read.awb, "9000000000000003")
    assert.equal(parsed.read.carrier, "Delhivery")
    assert.equal(parsed.read.correctRounding, true)
  }
})

test("[synthetic] the Shadowfax host reads trackingId from the query (format in Meesho.csv), and is never corrected", () => {
  const parsed = parseTrackingLink("https://track.shadowfax.in/track?order=return&trackingId=SYNR2617119547FPL")
  assert.equal(parsed.status, "ok")
  if (parsed.status === "ok") {
    assert.equal(parsed.read.awb, "SYNR2617119547FPL")
    assert.equal(parsed.read.carrier, "Shadowfax")
    assert.equal(parsed.read.correctRounding, false)
  }
})

test("[synthetic] links that are not https, not in a verified format, or on another host are not read", () => {
  assert.equal(parseTrackingLink("http://track.delhivery.com/p/9000000000000003").status, "invalid")
  assert.equal(parseTrackingLink("https://track.delhivery.com/track/9000000000000003").status, "invalid")
  assert.equal(parseTrackingLink("not a url").status, "invalid")
  assert.equal(parseTrackingLink("").status, "none")
  assert.deepEqual(parseTrackingLink("https://example.invalid/p/9000000000000003"), {
    status: "unverified",
    host: "example.invalid",
  })
  assert.equal(awbFromTrackingUrl("https://example.invalid/p/9000000000000003"), null)
})

test("[synthetic] rounding to 15 digits matches how a spreadsheet keeps a 16-digit number", () => {
  // A spreadsheet keeps 15 significant digits: 1490711860180882 becomes 1490711860180880.
  assert.equal(roundToFifteenDigits("1490711860180882"), "1490711860180880")
  assert.equal(roundToFifteenDigits("9000000000000003"), "9000000000000000")
  assert.equal(roundToFifteenDigits("9000000000000005"), "9000000000000010")
  assert.equal(roundToFifteenDigits("9999999999999995"), "10000000000000000")
})

// ---------- The AWB decision for a Meesho row ----------

test("[synthetic] a 16-digit CSV AWB that is the link AWB rounded to 15 digits takes the link AWB for lookup", () => {
  const decision = resolveTrackingId("9000000000000000", "https://track.delhivery.com/p/9000000000000003")
  assert.equal(decision.trackingId, "9000000000000003")
  assert.equal(decision.csvTrackingId, "9000000000000000", "the CSV value is kept")
  assert.equal(decision.urlTrackingId, "9000000000000003")
  assert.equal(decision.identifierSource, "tracking_link")
  assert.equal(decision.validation, "mismatch_resolved")
  assert.match(decision.warning, /rounded to 15 digits/)
})

test("[synthetic] a difference that is not a 15-digit rounding is never corrected automatically", () => {
  const decision = resolveTrackingId("9000000000000001", "https://track.delhivery.com/p/9000000000000003")
  assert.equal(decision.trackingId, "9000000000000001")
  assert.equal(decision.identifierSource, "csv_awb")
  assert.equal(decision.validation, "mismatch_kept")
  assert.match(decision.warning, /check the label/)
})

test("[synthetic] an AWB that the link confirms stands, with validation match and no warning", () => {
  const decision = resolveTrackingId("9000000000000005", "https://track.delhivery.com/p/9000000000000005")
  assert.equal(decision.trackingId, "9000000000000005")
  assert.equal(decision.urlTrackingId, "9000000000000005")
  assert.equal(decision.validation, "match")
  assert.equal(decision.warning, "")
})

test("[synthetic] a Shadowfax difference is kept and flagged, never rounded", () => {
  const decision = resolveTrackingId(
    "SYNR2617119547FPL",
    "https://track.shadowfax.in/track?order=return&trackingId=SYNR2617119548FPL",
  )
  assert.equal(decision.trackingId, "SYNR2617119547FPL")
  assert.equal(decision.validation, "mismatch_kept")
  assert.match(decision.warning, /Shadowfax tracking link/)
})

test("[synthetic] a missing link, an invalid link and an unverified host are each flagged, and never used", () => {
  assert.equal(resolveTrackingId("SYNR0001FPL", "").validation, "no_link")
  assert.match(resolveTrackingId("SYNR0001FPL", "").warning, /No tracking link/)
  assert.equal(resolveTrackingId("SYNR0001FPL", "not a url").validation, "invalid_link")
  const unverified = resolveTrackingId("9000000000000001", "https://example.invalid/p/9000000000000003")
  assert.equal(unverified.validation, "unverified_host")
  assert.equal(unverified.trackingId, "9000000000000001")
})

test("[synthetic] a blank or damaged CSV AWB is never filled or repaired from a link", () => {
  const blank = resolveTrackingId("", "https://track.delhivery.com/p/9000000000000003")
  assert.equal(blank.trackingId, "")
  assert.equal(blank.validation, "blank_awb")
  const damaged = resolveTrackingId("1.49E+15", "https://track.delhivery.com/p/1490711860180882")
  assert.equal(damaged.trackingId, "1.49E+15")
  assert.equal(damaged.validation, "damaged_awb")
  assert.equal(damaged.urlTrackingId, "")
})

// ---------- Logistics partner detection ----------

const index: PartnerIndex = {
  aliases: new Map([
    ["*|shadowfax", { partnerId: 2, name: "Shadowfax" }],
    ["*|delhiverycod", { partnerId: 1, name: "Delhivery" }],
    ["Flipkart|flipkartlogistics", { partnerId: 3, name: "Flipkart Logistics" }],
  ]),
  hosts: new Map([["track.delhivery.com", { partnerId: 1, name: "Delhivery" }]]),
}

test("[synthetic] an explicit carrier in the file is identified and marked verified", () => {
  const match = detectPartner(index, "Meesho", "Shadowfax", "")
  assert.equal(match.name, "Shadowfax")
  assert.equal(match.method, "explicit_carrier")
  assert.equal(match.confidence, "verified")
  assert.equal(match.sourceValue, "Shadowfax")
  assert.equal(match.warning, "")
})

test("[synthetic] a marketplace-specific alias is recorded as a marketplace mapping", () => {
  const match = detectPartner(index, "Flipkart", "flipkartlogistics", "")
  assert.equal(match.name, "Flipkart Logistics")
  assert.equal(match.method, "marketplace_mapping")
})

test("[synthetic] a COD suffix in the file's carrier name matches the alias without the suffix", () => {
  const match = detectPartner(index, "Flipkart", "delhivery-cod", "")
  assert.equal(match.name, "Delhivery")
})

test("[synthetic] delhiveryexpress and delhiversurface are Delhivery", () => {
  const named: PartnerIndex = {
    aliases: new Map([["*|delhivery", { partnerId: 1, name: "Delhivery" }]]),
    hosts: new Map(),
  }
  const express = detectPartner(named, "Meesho", "delhiveryexpress", "")
  const surface = detectPartner(named, "Meesho", "Delhivery Surface", "https://track.delhivery.com/p/9000000000000003")
  assert.equal(express.name, "Delhivery")
  assert.equal(express.method, "explicit_carrier")
  assert.equal(surface.name, "Delhivery")
  assert.equal(surface.method, "explicit_carrier")
})

test("[synthetic] a tracking link does not name the partner", () => {
  const match = detectPartner(index, "Meesho", "", "https://track.delhivery.com/p/9000000000000003")
  assert.equal(match.name, UNKNOWN_PARTNER)
  assert.equal(match.method, "none")
  assert.equal(match.warning, "")
})

test("[synthetic] the file's carrier name is kept when a tracking link names a different host", () => {
  const match = detectPartner(index, "Meesho", "Shadowfax", "https://track.delhivery.com/p/9000000000000003")
  assert.equal(match.name, "Shadowfax")
  assert.equal(match.warning, "")
})

test("[synthetic] an unknown carrier name is never guessed; it is Unknown / Pending Verification", () => {
  const match = detectPartner(index, "Meesho", "SYN Courier", "")
  assert.equal(match.name, UNKNOWN_PARTNER)
  assert.equal(match.method, "none")
  assert.equal(match.partnerId, null)
  assert.equal(match.confidence, "none")
  assert.match(match.warning, /is not in the logistics partner list/)
})

test("[synthetic] Amazon's carrier ATSPL is not on the list, so it stays Unknown with the value kept", () => {
  const match = detectPartner(index, "Amazon", "ATSPL", "")
  assert.equal(match.name, UNKNOWN_PARTNER)
  assert.equal(match.sourceValue, "ATSPL")
  assert.match(match.warning, /"ATSPL" is not in the logistics partner list/)
})

test("[synthetic] a row with no carrier and no link is Unknown with no warning", () => {
  const match = detectPartner(index, "Myntra VB", "", "")
  assert.equal(match.name, UNKNOWN_PARTNER)
  assert.equal(match.warning, "")
})
