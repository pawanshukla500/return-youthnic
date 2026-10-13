// Pure marketplace rules: header names, return types, SKU variations, carrier tracking links, the AWB validation
// decision, and logistics partner detection. Nothing here touches the database, so every rule can be tested directly.
// The database-backed partner index is loaded in server/logistics.ts.

export const UNKNOWN_PARTNER = "Unknown / Pending Verification"

// Looks up a key in a table without reading inherited properties (so "constructor" is not a match).
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

// Header names are compared after this normalization, so "Return AWB No", "return-awb-no" and "Return_AWB_No" are
// one name. Column letters are never used.
export function normalizeHeader(value: string): string {
  return value
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
}

// Letters and digits only, lower case. Carrier names and aliases are compared with this key.
export function aliasKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

// How well a product-master row's marketplace scope fits one account. Higher wins; 0 means it does not apply, so an
// account never uses another account's mapping.
//   3  exact account match, for example "myntra vb"
//   2  a generic scope that names the account, for example "myntra" for "Myntra VB" (and the reverse)
//   1  "all", or a blank scope: applies to every account
//   0  a different account
// A marketplace row that fits is always preferred over the global row, so a specific mapping is never blocked.
export function marketplaceRank(scope: string, account: string): number {
  const wanted = (scope || "").trim().toLowerCase()
  const name = (account || "").trim().toLowerCase()
  if (!wanted || wanted === "all") return 1
  if (wanted === name) return 3
  if (name) {
    const paddedScope = ` ${wanted} `
    const paddedName = ` ${name} `
    // Whole-word containment only, so a one-letter scope does not match every account.
    if (paddedName.includes(paddedScope) || paddedScope.includes(paddedName)) return 2
  }
  return 0
}

// Return type codes: lower case, and any run of other characters becomes one underscore.
// "Courier Return (RTO)" becomes "courier_return_rto".
export function returnTypeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

// ---------------------------------------------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------------------------------------------

export const NORMALIZED_RETURN_TYPES = ["Customer Return", "RTO", "Replacement Order"] as const

// Source codes per marketplace, as each report writes them. A code that is not listed is kept as written and flagged.
// Amazon's codes are confirmed by the Amazon sample file (Return Type: CUSTOMER_RETURN, UNDELIVERED).
// Flipkart's codes are confirmed by the Flipkart sample (customer_return, courier_return).
// Meesho's codes are confirmed by the Meesho sample (Customer Return, Courier Return (RTO)).
const RETURN_TYPE_RULES: Record<string, Record<string, string>> = {
  "Myntra EJ": { return: "Customer Return", rto: "RTO" },
  "Myntra VB": { return: "Customer Return", rto: "RTO" },
  Flipkart: { customer_return: "Customer Return", courier_return: "RTO" },
  Meesho: { customer_return: "Customer Return", courier_return_rto: "RTO" },
  Ajio: { rvp: "Customer Return", rto: "RTO", repl: "Replacement Order" },
  Amazon: { customer_return: "Customer Return", undelivered: "RTO" },
}

// Used for a marketplace that has no layout of its own.
const GENERIC_RETURN_TYPE_RULES: Record<string, string> = {
  customer_return: "Customer Return",
  return: "Customer Return",
  rvp: "Customer Return",
  rto: "RTO",
  courier_return: "RTO",
  courier_return_rto: "RTO",
  undelivered: "RTO",
  repl: "Replacement Order",
  replacement: "Replacement Order",
  replacement_order: "Replacement Order",
}

export type ReturnTypeResult = {
  // The normalized type, or the code as written when it is not in the rules. Blank when the file gave none.
  value: string
  // False when blank or not in the rules. Such a row carries a warning and is never silently mapped.
  known: boolean
}

export function normalizeReturnType(marketplace: string, raw: string): ReturnTypeResult {
  const text = raw.trim()
  if (!text) return { value: "", known: false }
  const rules = own(RETURN_TYPE_RULES, marketplace) ?? GENERIC_RETURN_TYPE_RULES
  const mapped = own(rules, returnTypeKey(text))
  return mapped === undefined ? { value: text, known: false } : { value: mapped, known: true }
}

// Warning text for a return type that did not map. Empty when it mapped.
export function returnTypeWarning(result: ReturnTypeResult, raw: string): string {
  if (!raw.trim()) return "Return type is blank"
  if (!result.known) return `Unknown return type "${raw.trim()}" is kept as written. Check the return type mapping.`
  return ""
}

// ---------------------------------------------------------------------------------------------------------------
// SKU and variation (size)
// ---------------------------------------------------------------------------------------------------------------

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Joins a SKU and its variation (size). The variation is added with an underscore, unless the SKU already ends with it
// as its own part (after "_", "-", "/" or a space). "SYN-KURTA-M" + "M" stays as it is, and "SYN-KURTA-XM" + "M"
// becomes "SYN-KURTA-XM_M", because the M there is part of a longer word.
// Confirmed convention: the Flipkart and Amazon SKUs already carry the size after "_" (B126-kabira-Bottle Green_M,
// B143-Yamuna-Pink_XL). The Meesho sample has SKU "T91-Zoe-Rust_AI1" with Variation "L", which this rule combines to
// "T91-Zoe-Rust_AI1_L". Whether the product master keys on that form is NOT verified (see the status note).
export function skuWithVariation(sku: string, variation: string): { value: string; appended: boolean } {
  const base = sku.trim()
  const size = variation.trim()
  if (!base) return { value: "", appended: false }
  if (!size) return { value: base, appended: false }
  const ending = new RegExp(`(^|[\\s_\\-/])${escapeRegex(size)}$`, "i")
  if (ending.test(base)) return { value: base, appended: false }
  return { value: `${base}_${size}`, appended: true }
}

// Size tokens stay on the listing SKU. A short trailing token that is not a size, such as "_A" or "_Al",
// is an article suffix. "B126-kabira-Bottle Green_S_A" is also looked up as "B126-kabira-Bottle Green_S".
const SIZE_TOKENS = new Set(["xs", "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl", "4xl", "5xl", "free", "freesize"])

export function compactSkuKey(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase()
}

export function parentListingSku(listing: string): string {
  const match = listing.trim().match(/^(.*)_([^_\s]+)$/)
  if (!match) return ""
  const suffix = match[2].replace(/\s+/g, "").toLowerCase()
  if (!/^[a-z]+\d*$/.test(suffix) || suffix.length > 6 || SIZE_TOKENS.has(suffix)) return ""
  return match[1]
}

// Exact listing, the same text without spaces, and the parent listing when an article suffix is present.
export function listingSkuCandidates(listing: string): string[] {
  const exact = listing.trim()
  if (!exact) return []
  const keys = [exact]
  const compact = exact.replace(/\s+/g, "")
  if (compact !== exact) keys.push(compact)
  const parent = parentListingSku(exact)
  if (parent) {
    keys.push(parent)
    const parentCompact = parent.replace(/\s+/g, "")
    if (parentCompact !== parent) keys.push(parentCompact)
  }
  return [...new Set(keys)]
}

// ---------------------------------------------------------------------------------------------------------------
// Carrier tracking links
// ---------------------------------------------------------------------------------------------------------------

// Each rule is a link format confirmed in a real file, for one host. Only these hosts are read. Any other host is
// refused, and its link is never used to change an AWB.
//  - track.delhivery.com/p/<AWB>            (the example in the Meesho specification)
//  - www.delhivery.com/track/package/<AWB>  (Meesho.csv, Tracking Link column)
//  - track.shadowfax.in/track?...&trackingId=<AWB>  (Meesho.csv, Tracking Link column)
// correctRounding: only the Delhivery numeric AWBs are eligible for the rounding correction (the configured
// Meesho/Delhivery rule). Shadowfax AWBs are alphanumeric and are only compared, never corrected.
type LinkRule = {
  host: string
  carrier: string
  correctRounding: boolean
  readAwb: (url: URL) => string | null
}

function pathAwb(pattern: RegExp): (url: URL) => string | null {
  return (url) => {
    const match = url.pathname.match(pattern)
    return match ? match[1] : null
  }
}

const LINK_RULES: LinkRule[] = [
  { host: "track.delhivery.com", carrier: "Delhivery", correctRounding: true, readAwb: pathAwb(/^\/p\/(\d+)\/?$/) },
  {
    host: "www.delhivery.com",
    carrier: "Delhivery",
    correctRounding: true,
    readAwb: pathAwb(/^\/track\/package\/(\d+)\/?$/),
  },
  {
    host: "track.shadowfax.in",
    carrier: "Shadowfax",
    correctRounding: false,
    readAwb: (url) => {
      if (url.pathname !== "/track") return null
      const value = (url.searchParams.get("trackingId") || "").trim()
      return /^[A-Za-z0-9]+$/.test(value) ? value.toUpperCase() : null
    },
  },
  {
    host: "tracker.shadowfax.in",
    carrier: "Shadowfax",
    correctRounding: false,
    readAwb: (url) => {
      const hash = url.hash || ""
      const m = hash.match(/\/awb\/([A-Za-z0-9]+)/i) || url.pathname.match(/\/awb\/([A-Za-z0-9]+)/i)
      return m ? m[1].toUpperCase() : null
    },
  },
  {
    host: "meesho.portal.shipsy.io",
    carrier: "Valmo",
    correctRounding: false,
    readAwb: (url) => {
      const ref = (url.searchParams.get("refNum") || "").trim()
      return /^[A-Za-z0-9]+$/.test(ref) ? ref.toUpperCase() : null
    },
  },
  {
    host: "www.valmo.in",
    carrier: "PocketShip",
    correctRounding: false,
    readAwb: pathAwb(/^\/track\/([A-Za-z0-9]+)\/?$/i),
  },
  {
    host: "www.xpressbees.com",
    carrier: "Xpress Bees",
    correctRounding: false,
    readAwb: (url) => {
      const id = (url.searchParams.get("trackid") || "").trim()
      return /^[A-Za-z0-9]+$/.test(id) ? id.toUpperCase() : null
    },
  },
]

export function isVerifiedTrackingHost(host: string): boolean {
  return LINK_RULES.some((rule) => rule.host === host)
}

export function hostOf(url: string): string {
  const text = url.trim()
  if (!text) return ""
  try {
    return new URL(text).hostname.toLowerCase()
  } catch {
    return ""
  }
}

export type TrackingLinkRead = { host: string; carrier: string; awb: string; correctRounding: boolean }

export type TrackingLinkParse =
  | { status: "none" }
  | { status: "invalid" }
  | { status: "unverified"; host: string }
  | { status: "ok"; read: TrackingLinkRead }

// Reads the AWB from a carrier tracking link. Only https links on a verified host, in a verified format, are read.
export function parseTrackingLink(url: string): TrackingLinkParse {
  const text = url.trim()
  if (!text) return { status: "none" }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return { status: "invalid" }
  }
  if (parsed.protocol !== "https:") return { status: "invalid" }
  const host = parsed.hostname.toLowerCase()
  const rule = LINK_RULES.find((candidate) => candidate.host === host)
  if (!rule) return { status: "unverified", host }
  const awb = rule.readAwb(parsed)
  if (!awb) return { status: "invalid" }
  return { status: "ok", read: { host, carrier: rule.carrier, awb, correctRounding: rule.correctRounding } }
}

// Kept for callers that only need the AWB of a verified link.
export function awbFromTrackingUrl(url: string): { host: string; awb: string } | null {
  const parsed = parseTrackingLink(url)
  return parsed.status === "ok" ? { host: parsed.read.host, awb: parsed.read.awb } : null
}

// The 15 significant digits a spreadsheet keeps. A 16-digit number is rounded to 15 significant digits: the last digit
// becomes 0 and the rest is rounded half up. 1490711860180882 becomes 1490711860180880.
export function roundToFifteenDigits(digits: string): string {
  const value = BigInt(digits)
  return ((value + 5n) / 10n * 10n).toString()
}

// When Excel truncates digits beyond the 15th digit to zero (e.g. 1490711818486605 -> 1490711818486600).
export function truncateToFifteenDigits(digits: string): string {
  if (digits.length <= 15) return digits
  return digits.slice(0, 15) + "0".repeat(digits.length - 15)
}

// Checks if an Excel scientific notation string (e.g. 1.49071E+15 or 1.4907118184866E+15) represents a full AWB.
export function matchesScientificAwb(scientificStr: string, fullAwb: string): boolean {
  if (!/^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(scientificStr)) return false
  if (!/^\d+$/.test(fullAwb)) return false
  const [mantissaStr, expStr] = scientificStr.toUpperCase().split("E")
  const exp = parseInt(expStr, 10)
  if (isNaN(exp)) return false
  // Magnitude match: integer digits should equal exp + 1 (e.g. 15 exponent means 16 digits)
  if (fullAwb.length !== exp + 1) return false
  const sigDigits = mantissaStr.replace(".", "").replace(/^0+/, "")
  if (fullAwb.startsWith(sigDigits)) return true
  const numSci = Number(scientificStr)
  const numAwb = Number(fullAwb)
  if (!isNaN(numSci) && !isNaN(numAwb) && numAwb > 0) {
    return Math.abs(numSci - numAwb) / numAwb < 0.005
  }
  return false
}

export type TrackingValidation =
  | "not_applicable"
  | "blank_awb"
  | "damaged_awb"
  | "no_link"
  | "invalid_link"
  | "unverified_host"
  | "match"
  | "mismatch_resolved"
  | "mismatch_kept"

export type IdentifierSource = "csv_awb" | "tracking_link"

export type TrackingDecision = {
  // The AWB the lookup uses. Equal to the CSV value except in the one case that resolves to the link.
  trackingId: string
  // The AWB as the file wrote it. Never changed.
  csvTrackingId: string
  // The AWB read from a verified link, or "" when there is none.
  urlTrackingId: string
  // The carrier named by the verified link, or "".
  carrierFromLink: string
  identifierSource: IdentifierSource
  validation: TrackingValidation
  warning: string
}

// Decides the AWB of one Meesho row. Rules:
//  - A blank AWB is never filled from a link.
//  - A scientific notation AWB without a matching carrier link is treated as damaged_awb.
//  - If a carrier tracking link confirms the AWB (either exact match, 15-digit truncation by Excel, 15-digit rounding,
//    or scientific notation magnitude match for supported carriers like Delhivery), the full uncorrupted link AWB is used.
//  - No link, an invalid link, or an unverified host: the CSV value stands and the row is flagged.
//  - Any other difference: the CSV value stands and the difference is flagged for a person (mismatch_kept).
export function resolveTrackingId(csvValue: string, trackingUrl: string): TrackingDecision {
  const csv = csvValue.trim()
  const base = {
    trackingId: csv,
    csvTrackingId: csv,
    urlTrackingId: "",
    carrierFromLink: "",
    identifierSource: "csv_awb" as IdentifierSource,
  }
  if (!csv) return { ...base, validation: "blank_awb", warning: "" }
  if (/^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(csv)) return { ...base, validation: "damaged_awb", warning: "" }

  const link = parseTrackingLink(trackingUrl)
  if (link.status === "none") {
    return {
      ...base,
      validation: "no_link",
      warning: "No tracking link in the file, so this AWB is not checked against a carrier.",
    }
  }
  if (link.status === "invalid") {
    return {
      ...base,
      validation: "invalid_link",
      warning: "The tracking link is not a readable carrier link, so this AWB is not checked.",
    }
  }
  if (link.status === "unverified") {
    return {
      ...base,
      validation: "unverified_host",
      warning: `The tracking link host ${link.host} is not a verified carrier link, so it is not used.`,
    }
  }

  const read = link.read
  const withLink = { ...base, urlTrackingId: read.awb, carrierFromLink: read.carrier }

  if (read.awb === csv) return { ...withLink, validation: "match", warning: "" }

  if (read.correctRounding && /^\d{16,}$/.test(csv) && /^\d+$/.test(read.awb)) {
    const is15DigitTruncated = csv === truncateToFifteenDigits(read.awb)
    const is15DigitRounded = csv === roundToFifteenDigits(read.awb)

    if (is15DigitTruncated || is15DigitRounded) {
      return {
        ...withLink,
        trackingId: read.awb,
        identifierSource: "tracking_link",
        validation: "mismatch_resolved",
        warning: `CSV AWB ${csv} is the tracking link AWB ${read.awb} rounded to 15 digits, so the link AWB is used for lookup. The CSV value is kept.`,
      }
    }
  }

  return {
    ...withLink,
    validation: "mismatch_kept",
    warning: `CSV AWB ${csv} differs from the ${read.carrier} tracking link AWB ${read.awb}. The CSV value is kept; check the label.`,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Logistics partner detection
// ---------------------------------------------------------------------------------------------------------------

// Partner names and aliases as stored in the database. Aliases are keyed "<marketplace name or *>|<alias key>".
export type PartnerIndex = {
  aliases: Map<string, { partnerId: number; name: string }>
  hosts: Map<string, { partnerId: number; name: string }>
}

export type PartnerMatch = {
  partnerId: number | null
  name: string
  method: "explicit_carrier" | "marketplace_mapping" | "tracking_domain" | "none"
  confidence: "verified" | "none"
  // The carrier text as the file gave it. Kept for audit.
  sourceValue: string
  warning: string
}

// A written courier name uses a partner when it is that partner's alias, or when it starts with one.
// "delhiveryexpress" and "delhiversurface" are Delhivery. A tracking link is not read and does not name the partner.
const MIN_ALIAS_STEM = 6

function aliasHit(
  index: PartnerIndex,
  marketplace: string,
  key: string,
): { partnerId: number; name: string; method: "explicit_carrier" | "marketplace_mapping" } | undefined {
  const exactScoped = index.aliases.get(`${marketplace}|${key}`)
  if (exactScoped) return { ...exactScoped, method: "marketplace_mapping" }
  const exactGlobal = index.aliases.get(`*|${key}`)
  if (exactGlobal) return { ...exactGlobal, method: "explicit_carrier" }

  let best: { partnerId: number; name: string; method: "explicit_carrier" | "marketplace_mapping"; score: number } | undefined
  for (const [stored, hit] of index.aliases) {
    const bar = stored.indexOf("|")
    if (bar < 0) continue
    const scope = stored.slice(0, bar)
    const stem = stored.slice(bar + 1)
    if (stem.length < MIN_ALIAS_STEM || !key.startsWith(stem) || key.length === stem.length) continue
    const scoped = scope === marketplace
    if (!scoped && scope !== "*") continue
    const score = stem.length * 2 + (scoped ? 1 : 0)
    if (!best || score > best.score) {
      best = {
        partnerId: hit.partnerId,
        name: hit.name,
        method: scoped ? "marketplace_mapping" : "explicit_carrier",
        score,
      }
    }
  }
  return best
}

export function detectPartner(
  index: PartnerIndex,
  marketplace: string,
  carrierValue: string,
  _trackingUrl = "",
): PartnerMatch {
  const sourceValue = carrierValue.trim()
  const key = aliasKey(sourceValue)
  const found = key ? aliasHit(index, marketplace, key) : undefined
  if (found) {
    return {
      partnerId: found.partnerId,
      name: found.name,
      method: found.method,
      confidence: "verified",
      sourceValue,
      warning: "",
    }
  }
  const warning = key ? `Carrier "${sourceValue}" is not in the logistics partner list. Add it in Admin.` : ""
  return { partnerId: null, name: UNKNOWN_PARTNER, method: "none", confidence: "none", sourceValue, warning }
}
