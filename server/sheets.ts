import { createHash } from "node:crypto"
import * as XLSX from "xlsx"
import {
  AJIO_RETURNS,
  AJIO_OPTIONAL,
  AMAZON_OPTIONAL,
  AMAZON_RETURNS,
  FLIPKART_OPTIONAL,
  FLIPKART_RETURNS,
  MEESHO_RETURNS,
  MYNTRA_OPTIONAL,
  MYNTRA_SELLER_RETURNS,
  profileForMarketplace,
  type ImportProfile,
} from "./import-profiles.js"
import {
  normalizeHeader,
  normalizeReturnType,
  resolveTrackingId,
  returnTypeWarning,
  skuWithVariation,
  type IdentifierSource,
  type ReturnTypeResult,
  type TrackingValidation,
} from "./marketplace-rules.js"
import { normalizeImageUrl } from "./oms/client.js"

// Project rule (DashBorad AGENTS.md, Myntra blank tracking number): an order with no tracking
// number was cancelled before dispatch. It is recorded as a Courier Return with this reason.
// It has no AWB, so it can never be scanned.
export const CANCELLED_RETURN_TYPE = "Courier Return"
export const CANCELLED_REASON = "Cancel Before Dispached"

// Where the lookup AWB of a row came from.
//  return_tracking / forward_tracking: Myntra AG, or AF when AG is blank.
//  tracking_id: the file's single tracking column (Flipkart, Ajio, Amazon, Meesho CSV value).
//  tracking_url: a verified carrier link gave the lookup AWB (Meesho rounding rule only).
export type TrackingSource = "return_tracking" | "forward_tracking" | "tracking_id" | "tracking_url"

// What the register's Order Item ID means. Only "order_line" is a real channel order line. The other two are display
// identifiers of their own type, and they are never used as order-line keys.
export type DisplayIdentifierKind = "" | "order_line" | "ajio_return_order_number" | "amazon_shipment_id"

// The marketplace SKU identification, and which kind of identifier it is. The kinds are never mixed.
export type MarketplaceSkuIdentifierKind = "" | "fsn" | "asin" | "jiocode" | "myntra_sku_code"

// exact_import_row: the whole row matches an earlier row in the same file. Not counted again.
export type DuplicateKind = "" | "exact_import_row"

export type ParsedRow = {
  // Lookup key (the AWB the lookup uses). Blank when the AWB could not be trusted (see the pending reason on the row).
  trackingId: string
  // The other tracking column, if it differs. Scans match either one. Myntra only: forward tracking (AF).
  altTrackingId: string
  orderId: string
  // Internal order line key. Only real order lines: Myntra order_line_id, Flipkart Order Item ID, Meesho Suborder
  // Number. Empty for Ajio and Amazon, and empty when the file's value could not be trusted.
  orderLineId: string
  // Channel listing id: Myntra seller_sku_code, Flipkart and Meesho SKU (with variation), Ajio SELLER SKU, Amazon mSKU.
  channelListingId: string
  channelSku: string
  // Item code. Once the product master is joined it is the VB EXPORT master SKU,
  // otherwise the seller SKU code.
  sku: string
  productName: string
  qty: number
  courier: string
  returnType: string
  returnReason: string
  colorName: string
  keyDetail: string
  brandLabel: string
  setContents: string
  marketplace: string
  // True for a Myntra row with no tracking number that was cancelled before dispatch.
  // These are stored in cancelled_returns, not in expected_returns.
  cancelled: boolean
  valid: boolean
  error: string
  // Non-blocking problems, such as identifiers whose digits were lost in the source file.
  warnings: string[]
  // A structurally readable row that cannot be a scan lookup yet, such as a missing or untrusted return AWB.
  // Pending rows stay in upload_rows but are not written to expected_returns.
  pendingReasons: string[]
  // Every column of the uploaded row, keyed by normalized header name, minus the profile's redacted columns.
  // Stored in upload_rows so the full report can be checked later.
  raw?: Record<string, string>

  // Added with the marketplace layouts. Optional, so a row built elsewhere still type-checks.
  profileId?: string
  // 1-based data line of the row in the file (the header is not counted).
  sourceLineNo?: number
  // SHA-256 of the row's raw values. Two rows with the same fingerprint are exact duplicates.
  rowFingerprint?: string
  trackingSource?: TrackingSource
  // The AWB exactly as the file wrote it. Never changed.
  csvTrackingId?: string
  // The carrier tracking link from the file (Meesho), kept for audit.
  trackingUrl?: string
  // The AWB read from a verified carrier link, or "".
  urlTrackingId?: string
  // The carrier named by a verified link, or "". Compared with the file's carrier, never trusted over it.
  carrierFromLink?: string
  // How the lookup AWB was decided. See marketplace-rules.ts.
  trackingValidation?: TrackingValidation
  identifierSource?: IdentifierSource
  // The forward (outbound) AWB, kept for audit: Myntra AF, Amazon Forward Leg Tracking ID.
  forwardTrackingId?: string
  // The return event id: Myntra return_id, Flipkart Return ID, Amazon RMA ID.
  returnEventId?: string
  // What the register shows as Order Item ID, and what kind of identifier it is.
  displayOrderItemId?: string
  displayIdentifierKind?: DisplayIdentifierKind
  // Marketplace SKU identification from the layout's own column, and its kind.
  marketplaceSkuIdentifier?: string
  marketplaceSkuIdentifierKind?: MarketplaceSkuIdentifierKind
  // The return type as the file wrote it, before normalization.
  returnTypeRaw?: string
  // The carrier name as the file wrote it (Ajio return carrier, Flipkart vendor name, Meesho courier partner, Amazon carrier).
  carrierValue?: string
  // Shipment ID from the file layout (Amazon shipment_id, Flipkart shipment_id, Ajio return_shipment_id)
  shipmentId?: string
  // True when the row is not counted (an exact duplicate of an earlier row). The row is still kept in upload_rows.
  duplicate?: boolean
  duplicateKind?: DuplicateKind
}

export type ParseResult = {
  // "generic" or an import profile id such as "myntra-seller-returns".
  profileId: string
  rows: ParsedRow[]
  // Non-empty means the whole file was rejected before any row was saved.
  fatal: string
  warningCount: number
}

export type MasterRow = {
  listingSku: string
  marketplace: string
  masterSku: string
  category: string
  cogs: number | null
  weightSlab: number | null
  // The channel image link for this listing SKU. Empty when the file has no image column, or the link is not http(s).
  imageUrl: string
}

export type MasterParseResult = {
  rows: MasterRow[]
  skipped: number
  // Rows whose image cell was present but not an http(s) link, so it was left blank. Never repaired.
  invalidImages: number
  // Listing SKUs that the file gives more than one product SKU for, after the key is normalized. The last row wins,
  // so the earlier value is not used. Never silently guessed; the preview reports these.
  conflictCount: number
  conflicts: { listingSku: string; marketplace: string; masterSkus: string[] }[]
  fatal: string
}

export type MasterPreview = {
  fatal: string
  rows: number
  listings: number
  masters: number
  withImage: number
  withoutImage: number
  invalidImages: number
  categories: number
  skipped: number
  conflictCount: number
  conflictSample: { listingSku: string; marketplace: string; masterSkus: string[] }[]
  // The marketplace scope the rows will be stored under, with the row count for each.
  scopes: { marketplace: string; rows: number }[]
  sample: { listingSku: string; masterSku: string; category: string; imageUrl: string }[]
}

const CONFLICT_LIMIT = 20

type Fields = Map<string, string>

// A parsed grid. suspect[i] holds the column indexes of row i whose cell was a number that cannot be trusted as an
// identifier: a number with more than 15 digits (Excel keeps 15), or a non-whole number. CSV cells are text, so their
// sets are always empty.
type Grid = { rows: string[][]; suspect: Set<number>[] }

// Generic aliases, used for marketplaces without their own header profile.
// Keys are matched after normalizeHeader, so "tracking id" and "tracking_id" both match.
const GENERIC = {
  tracking: ["tracking_id", "tracking", "awb"],
  orderId: ["order_id", "order"],
  channelSku: ["channel_sku", "order_item"],
  sku: ["product_sku", "sku"],
  productName: ["product_name", "product"],
  quantity: ["quantity", "qty"],
  courier: ["courier", "carrier"],
  returnType: ["return_type", "type"],
  returnReason: ["return_reason", "reason"],
  colorName: ["color", "colour"],
  keyDetail: ["key_detail"],
  brandLabel: ["brand_label", "brand"],
  setContents: ["set_contents", "contents"],
  marketplace: ["marketplace", "channel"],
}

// A number with more than 15 digits, or a number that is not whole, cannot be trusted as an identifier. Excel keeps 15
// significant digits, and a number above about 9 quadrillion cannot hold every digit even in the reader.
function isUntrustedNumber(value: number): boolean {
  return !Number.isInteger(value) || Math.abs(value) >= 1e15
}

// Cells become text here. A whole number is written out in full, never in Excel's display format.
function cellText(value: unknown) {
  if (value === null || value === undefined) return ""
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value).toString() : String(value)
  return String(value).trim()
}

// Removes Excel and CSV wrappers from an ID. Exports write IDs as ="0012345" to keep leading
// zeros, or prefix them with an apostrophe. Spaces inside an ID are dropped.
function cleanId(value: string) {
  let text = value.trim()
  const wrapped = text.match(/^="(.*)"$/)
  if (wrapped) text = wrapped[1]
  if (text.startsWith("'")) text = text.slice(1)
  return text.replace(/\s+/g, "")
}

// Minimal RFC 4180 CSV reader. Every field stays text, so nothing is coerced to a number and
// leading zeros survive. Quoted fields may contain commas and line breaks (Flipkart comments do).
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  const source = text.replace(/^﻿/, "")
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"' && field === "") {
      quoted = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += ch
    }
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function readGrid(buffer: Buffer, filename: string): Grid {
  if (/\.csv$/i.test(filename)) {
    const rows = parseCsv(buffer.toString("utf8")).map((cells) => cells.map((cell) => cell.trim()))
    return { rows, suspect: rows.map(() => new Set<number>()) }
  }
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return { rows: [], suspect: [] }
  const sheet = workbook.Sheets[sheetName]
  // raw: true keeps the stored value. raw: false would return Excel's display text,
  // which turns long IDs into scientific notation. The type of each cell is checked here, before it becomes text.
  const cells = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  })
  const suspect = cells.map((row) => {
    const columns = new Set<number>()
    row.forEach((cell, index) => {
      if (typeof cell === "number" && isUntrustedNumber(cell)) columns.add(index)
    })
    return columns
  })
  return { rows: cells.map((row) => row.map((cell) => cellText(cell))), suspect }
}

// Rows with at least one non-empty cell. A row of blank cells is neither data nor a header.
function usableGrid(grid: Grid): Grid {
  const rows: string[][] = []
  const suspect: Set<number>[] = []
  grid.rows.forEach((cells, index) => {
    if (!cells.some((cell) => cell !== "")) return
    rows.push(cells)
    suspect.push(grid.suspect[index] ?? new Set<number>())
  })
  return { rows, suspect }
}

// Finds the header row by its required names, looking at the first 40 usable rows.
// Returns the row that has the most required names, and which names it lacks.
function locateHeader(rows: string[][], required: string[], aliases?: Record<string, string[]>) {
  let best = { index: 0, missing: required, score: -1 }
  const limit = Math.min(rows.length, 40)
  for (let index = 0; index < limit; index++) {
    const headers = rows[index].map((cell) => normalizeHeader(cell))
    const missing = required.filter((name) => {
      if (headers.includes(name)) return false
      const altList = aliases?.[name] || []
      return !altList.some((alt) => headers.includes(normalizeHeader(alt)))
    })
    const score = required.length - missing.length
    if (score > best.score) best = { index, missing, score }
    if (missing.length === 0) break
  }
  return best
}

// Key and value lines above the header row, such as "Supplier ID","10874" (Meesho).
function readPreamble(rows: string[][]) {
  const values = new Map<string, string>()
  for (const cells of rows) {
    if (cells.length >= 2 && cells[0] && cells[1]) values.set(normalizeHeader(cells[0]), cells[1])
  }
  return values
}

// The columns of each record whose cell was an untrusted number, keyed by the record's field map.
const SUSPECT_COLUMNS = new WeakMap<Fields, Set<string>>()

function suspectColumn(fields: Fields, header: string): boolean {
  return SUSPECT_COLUMNS.get(fields)?.has(header) ?? false
}

function toFields(grid: Grid, headerIndex: number, aliases?: Record<string, string[]>) {
  const headers = grid.rows[headerIndex].map((cell) => normalizeHeader(cell))
  const aliasToCanonical = new Map<string, string>()
  if (aliases) {
    for (const [canonical, altList] of Object.entries(aliases)) {
      for (const alt of altList) {
        aliasToCanonical.set(normalizeHeader(alt), canonical)
      }
    }
  }

  const records: Fields[] = []
  for (let row = headerIndex + 1; row < grid.rows.length; row++) {
    const cells = grid.rows[row]
    const fields: Fields = new Map()
    const suspect = new Set<string>()

    // Pass 1: exact column headers
    headers.forEach((header, index) => {
      if (header) {
        const val = cells[index] ?? ""
        if (!fields.has(header)) fields.set(header, val)
        if (grid.suspect[row]?.has(index)) suspect.add(header)
      }
    })

    // Pass 2: canonical aliases only when the canonical field is missing or empty
    if (aliasToCanonical.size > 0) {
      headers.forEach((header, index) => {
        if (header) {
          const canonical = aliasToCanonical.get(header)
          if (canonical && canonical !== header) {
            const val = cells[index] ?? ""
            if ((!fields.has(canonical) || !fields.get(canonical)) && val) {
              fields.set(canonical, val)
              if (grid.suspect[row]?.has(index)) suspect.add(canonical)
            }
          }
        }
      })
    }

    SUSPECT_COLUMNS.set(fields, suspect)
    records.push(fields)
  }
  return { headers, records }
}

function pick(fields: Fields, keys: string[]) {
  for (const key of keys) {
    const value = fields.get(normalizeHeader(key))
    if (value) return value
  }
  return ""
}

// The header name to read for an identifier: the first of the names that has a value in this row.
function firstHeader(fields: Fields, keys: string[]): string {
  const names = keys.map((key) => normalizeHeader(key))
  return names.find((name) => (fields.get(name) ?? "") !== "") ?? names[0]
}

// The first of the named columns that holds a value, trimmed. Used for return type columns.
function pickFirst(fields: Fields, names: string[]): string {
  for (const name of names) {
    const value = (fields.get(name) || "").trim()
    if (value) return value
  }
  return ""
}

// Reads an identifier cell. An identifier that cannot be trusted is never used:
//  - a lookup key (isKey) that is scientific text, or a number with more than 15 digits, is pending when the caller
//    supplies a pending list, otherwise it is an error for legacy layouts;
//  - any other identifier is left blank, with a warning that names it.
// Nothing is repaired or guessed.
function readId(
  fields: Fields,
  header: string,
  label: string,
  isKey: boolean,
  errors: string[],
  warnings: string[],
  pending?: string[],
): string {
  const text = cleanId(fields.get(header) ?? "")
  if (!text) return ""
  if (isScientific(text)) {
    if (isKey && pending) pending.push(`${label} "${text}" is in scientific notation; its exact digits are unavailable, so the row is pending and cannot be scanned.`)
    else if (isKey) errors.push(scientificError(text))
    else warnings.push(`${label} "${text}" is in scientific notation, so its digits were lost. It is not shown or used.`)
    return ""
  }
  if (suspectColumn(fields, header)) {
    if (isKey) {
      const message = `${label} is stored as a number in the file. Excel keeps 15 digits, so its exact digits may be unavailable.`
      if (pending) pending.push(`${message} The row is pending and cannot be scanned. Re-save the file as CSV with IDs as text, or upload the marketplace's CSV download.`)
      else errors.push(`${message} Re-save the file as CSV with IDs as text, or upload the marketplace's CSV download.`)
    } else {
      warnings.push(`${label} is stored as a number in the file, so its digits may be lost. It is not shown or used.`)
    }
    return ""
  }
  return text
}

// A quantity must be a whole number of 1 or more. A blank or any other value is an error. It is never guessed.
function parseQuantity(value: string, zeroIsPending = false): { qty: number; error: string; pending: string } {
  const text = value.trim()
  if (!text) return { qty: 0, error: "Missing quantity", pending: "" }
  const number = Number(text)
  if (zeroIsPending && number === 0) {
    return { qty: 0, error: "", pending: `Quantity "${text}" is zero; the row is pending and cannot be scanned.` }
  }
  if (!Number.isInteger(number) || number < 1) {
    return { qty: 0, error: `Quantity "${text}" is not a whole number of 1 or more`, pending: "" }
  }
  return { qty: number, error: "", pending: "" }
}

// A row can be readable and complete enough to keep in the upload history while still being unsafe to use as a
// lookup. Pending rows have no trustworthy return AWB or a positive quantity, so they never reach expected_returns.
export type RowStatus = "scannable" | "pending" | "rejected" | "duplicate" | "cancelled"

export function rowStatus(row: ParsedRow): RowStatus {
  if (!row.valid) return "rejected"
  if (row.cancelled) return "cancelled"
  if (row.duplicate) return "duplicate"
  if (Boolean(row.trackingId) && row.qty > 0 && (row.pendingReasons ?? []).length === 0) return "scannable"
  return "pending"
}

export function isScannableRow(row: ParsedRow): boolean {
  return rowStatus(row) === "scannable"
}

function toMoney(value: string | undefined) {
  if (!value) return null
  const amount = Number(value.replace(/,/g, ""))
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

// Excel and CSV exports often write long IDs as 1.00346E+11. Those digits were already lost
// before the file reached us.
function isScientific(value: string) {
  return /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(value)
}

// A text value of 16 or more digits may have been rounded by a spreadsheet at some point.
function isOverPrecision(value: string) {
  return /^\d{16,}$/.test(value)
}

function scientificError(value: string) {
  return `${value} is in scientific notation; its digits were lost in the source file. Re-export with IDs as text`
}

function overPrecisionWarning(value: string) {
  return `${value} has more than 15 digits. Confirm it was stored as text`
}

// Sample codes such as "order_cancelled" or "mind_changed" become readable text.
function humanize(code: string) {
  const text = code.replace(/_/g, " ").trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ""
}

// Every column of the row, minus the profile's redacted columns. Keys are the normalized header names.
function rowData(fields: Fields, redact: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of fields) {
    if (redact.includes(key)) continue
    out[key] = value
  }
  return out
}

// SHA-256 over the row's values in a fixed key order. Equal fingerprints mean equal rows.
function fingerprintOf(raw: Record<string, string>): string {
  const entries = Object.keys(raw)
    .sort()
    .map((key) => [key, raw[key]])
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex")
}

function withRaw(row: ParsedRow, fields: Fields, profile: ImportProfile | null, lineNo: number): ParsedRow {
  const raw = rowData(fields, profile?.redactColumns ?? [])
  return { ...row, raw, rowFingerprint: fingerprintOf(raw), sourceLineNo: lineNo }
}

function countWarnings(rows: ParsedRow[]) {
  return rows.filter((row) => row.warnings.length > 0).length
}

function keepRow(row: ParsedRow) {
  return Boolean(row.trackingId || row.sku || row.orderId || row.productName)
}

// Every field that a layout can fill has a neutral value here, so each mapper only sets what its file gives.
function baseRow(marketplace: string, profileId: string): ParsedRow {
  return {
    profileId,
    trackingId: "",
    altTrackingId: "",
    orderId: "",
    orderLineId: "",
    channelListingId: "",
    channelSku: "",
    sku: "",
    productName: "",
    qty: 1,
    courier: "—",
    returnType: "",
    returnReason: "",
    colorName: "—",
    keyDetail: "",
    brandLabel: "",
    setContents: "",
    marketplace,
    cancelled: false,
    valid: true,
    error: "",
    warnings: [],
    pendingReasons: [],
    trackingValidation: "not_applicable",
    identifierSource: "csv_awb",
    displayIdentifierKind: "",
    marketplaceSkuIdentifier: "",
    marketplaceSkuIdentifierKind: "",
    shipmentId: "",
    duplicateKind: "",
  }
}

// Sets the fields every row has once its mapper has filled the rest.
function finish(row: ParsedRow, errors: string[], warnings: string[], pendingReasons: string[] = []): ParsedRow {
  return {
    ...row,
    csvTrackingId: row.csvTrackingId ?? row.trackingId,
    valid: errors.length === 0,
    error: errors.join("; "),
    warnings,
    pendingReasons: [...new Set(pendingReasons)],
  }
}

// Descriptive fields (key detail, brand label, set contents) are left empty when the file does not
// give them. The app never fills them with invented text.
function genericRow(fields: Fields, marketplace: string): ParsedRow {
  const errors: string[] = []
  const warnings: string[] = []
  const pendingReasons: string[] = []
  const trackingHeader = firstHeader(fields, GENERIC.tracking)
  const trackingRaw = cleanId(pick(fields, GENERIC.tracking))
  const trackingId = readId(fields, trackingHeader, "tracking id", true, errors, warnings, pendingReasons).toUpperCase()
  const trackingBlank = cleanId(pick(fields, GENERIC.tracking)) === ""
  const sku = pick(fields, GENERIC.sku)
  const quantity = parseQuantity(pick(fields, GENERIC.quantity))
  const rawType = pick(fields, GENERIC.returnType)
  const resultType: ReturnTypeResult = normalizeReturnType("generic", rawType)
  if (!trackingId && trackingBlank) pendingReasons.push("Missing tracking id; the row is pending and cannot be scanned.")
  if (!sku) errors.push("Missing product sku")
  if (quantity.error) errors.push(quantity.error)
  if (isOverPrecision(trackingId)) warnings.push(overPrecisionWarning(trackingId))
  const typeWarning = returnTypeWarning(resultType, rawType)
  if (typeWarning) warnings.push(typeWarning)
  const row = baseRow(marketplace, "generic")
  return finish(
    {
      ...row,
      trackingId,
      csvTrackingId: trackingRaw,
      trackingSource: "tracking_id",
      orderId: readId(fields, firstHeader(fields, GENERIC.orderId), "order id", false, errors, warnings),
      channelListingId: "",
      channelSku: pick(fields, GENERIC.channelSku),
      sku,
      productName: pick(fields, GENERIC.productName) || sku,
      qty: quantity.qty,
      courier: pick(fields, GENERIC.courier) || "—",
      carrierValue: pick(fields, GENERIC.courier),
      returnType: resultType.value,
      returnTypeRaw: rawType,
      returnReason: pick(fields, GENERIC.returnReason),
      colorName: pick(fields, GENERIC.colorName) || "—",
      keyDetail: pick(fields, GENERIC.keyDetail),
      brandLabel: pick(fields, GENERIC.brandLabel),
      setContents: pick(fields, GENERIC.setContents),
      marketplace: pick(fields, GENERIC.marketplace) || marketplace,
    },
    errors,
    warnings,
    pendingReasons,
  )
}

// Myntra seller returns. EJ and VB share this mapper, and each row keeps its own account.
function myntraRow(fields: Fields, marketplace: string, profileId: string): ParsedRow {
  const cols = MYNTRA_SELLER_RETURNS
  const errors: string[] = []
  const warnings: string[] = []
  const pendingReasons: string[] = []
  const returnBlank = cleanId(fields.get(cols.returnTracking) ?? "") === ""
  const forwardBlank = cleanId(fields.get(cols.forwardTracking) ?? "") === ""
  const returnTracking = readId(fields, cols.returnTracking, "return_tracking_number", true, errors, warnings, pendingReasons).toUpperCase()
  // The forward AWB is the lookup key only when the return AWB is blank. Otherwise it is kept as the alternate.
  const forwardTracking = readId(fields, cols.forwardTracking, "forward_tracking_number", returnBlank, errors, warnings, pendingReasons).toUpperCase()
  const trackingId = returnTracking || forwardTracking
  const altTrackingId = returnTracking && forwardTracking && forwardTracking !== returnTracking ? forwardTracking : ""
  const orderId = readId(fields, cols.orderId, "order_id", false, errors, warnings)
  const orderLineRaw = cleanId(fields.get(cols.orderLineId) ?? "")
  const orderLineId = readId(fields, cols.orderLineId, "order_line_id", false, errors, warnings)
  const channelListingId = (fields.get(cols.channelListing) || "").trim()

  // No tracking number in either column, but an order line: cancelled before dispatch (project rule).
  // A tracking number that is present but unusable is an error, never a cancellation.
  const trackingBlank = returnBlank && forwardBlank
  const cancelled = trackingBlank && orderLineRaw !== ""
  const quantity = parseQuantity(fields.get(cols.quantity) || "")
  const rawType = (fields.get(cols.returnType) || "").trim()
  const resultType = cancelled ? { value: CANCELLED_RETURN_TYPE, known: true } : normalizeReturnType(marketplace, rawType)

  if (trackingId === "" && trackingBlank && !cancelled) pendingReasons.push("Missing tracking id; the row is pending and cannot be scanned.")
  if (cancelled && orderLineId === "") errors.push("The order line id is unusable, so this cancelled order cannot be recorded")
  if (!channelListingId) errors.push("Missing seller_sku_code")
  if (quantity.error) errors.push(quantity.error)
  if (isOverPrecision(trackingId)) warnings.push(overPrecisionWarning(trackingId))
  if (isOverPrecision(orderId)) warnings.push(`order_id ${orderId} has more than 15 digits. Do not use it as a key`)
  if (!cancelled) {
    const typeWarning = returnTypeWarning(resultType, rawType)
    if (typeWarning) warnings.push(typeWarning)
  }

  const row = baseRow(marketplace, profileId)
  return finish(
    {
      ...row,
      trackingId,
      csvTrackingId: trackingId,
      trackingSource: returnTracking ? "return_tracking" : forwardTracking ? "forward_tracking" : "tracking_id",
      altTrackingId,
      forwardTrackingId: forwardTracking,
      returnEventId: readId(fields, MYNTRA_OPTIONAL.returnId, "return_id", false, errors, warnings),
      orderId,
      orderLineId,
      displayOrderItemId: orderLineId,
      displayIdentifierKind: orderLineId ? "order_line" : "",
      channelListingId,
      channelSku: channelListingId,
      // Until the product master is joined (see resolveProductSkus in server/lookup-import.ts), the seller SKU code is the item code.
      sku: channelListingId,
      productName: channelListingId,
      marketplaceSkuIdentifier: (fields.get(MYNTRA_OPTIONAL.skuIdentifier) || "").trim(),
      marketplaceSkuIdentifierKind: (fields.get(MYNTRA_OPTIONAL.skuIdentifier) || "").trim() ? "myntra_sku_code" : "",
      qty: quantity.qty,
      returnType: resultType.value,
      returnTypeRaw: rawType,
      returnReason: cancelled ? CANCELLED_REASON : fields.get(cols.returnReason) || "",
      cancelled,
    },
    errors,
    warnings,
    pendingReasons,
  )
}

// Flipkart return codes are normalized by normalizeReturnType ("customer_return" and "courier_return").
function flipkartRow(fields: Fields, marketplace: string, profileId: string): ParsedRow {
  const cols = FLIPKART_RETURNS
  const errors: string[] = []
  const warnings: string[] = []
  const pendingReasons: string[] = []
  const trackingRaw = cleanId(fields.get(cols.trackingId) ?? "")
  const trackingId = readId(fields, cols.trackingId, "Tracking ID", true, errors, warnings, pendingReasons).toUpperCase()
  const orderId = readId(fields, cols.orderId, "Order ID", false, errors, warnings)
  const orderItemId = readId(fields, cols.orderItemId, "Order Item ID", false, errors, warnings)
  const sku = (fields.get(cols.sku) || "").trim()
  const quantity = parseQuantity(fields.get(cols.quantity) || "")
  const rawType = (fields.get(cols.returnType) || "").trim()
  const resultType = normalizeReturnType(marketplace, rawType)
  const carrier = (fields.get(cols.vendorName) || "").trim()
  const fsn = (fields.get(FLIPKART_OPTIONAL.fsn) || "").trim()
  const shipmentId = readId(fields, FLIPKART_OPTIONAL.shipmentId, "Shipment ID", false, errors, warnings)

  if (!trackingId && trackingRaw === "") pendingReasons.push("Missing Tracking ID; the row is pending and cannot be scanned.")
  if (!sku) errors.push("Missing SKU")
  if (quantity.error) errors.push(quantity.error)
  if (isOverPrecision(trackingId)) warnings.push(overPrecisionWarning(trackingId))
  const typeWarning = returnTypeWarning(resultType, rawType)
  if (typeWarning) warnings.push(typeWarning)

  const reason = [
    humanize(fields.get(cols.returnReason) || ""),
    humanize(fields.get(cols.returnSubReason) || ""),
  ]
    .filter(Boolean)
    .join(" · ")

  const row = baseRow(marketplace, profileId)
  return finish(
    {
      ...row,
      trackingId,
      csvTrackingId: trackingRaw,
      trackingSource: "tracking_id",
      returnEventId: readId(fields, FLIPKART_OPTIONAL.returnId, "Return ID", false, errors, warnings),
      orderId,
      orderLineId: orderItemId,
      displayOrderItemId: orderItemId,
      displayIdentifierKind: orderItemId ? "order_line" : "",
      shipmentId: shipmentId || "",
      channelListingId: sku,
      channelSku: sku,
      sku,
      productName: (fields.get(cols.product) || "").trim() || sku,
      marketplaceSkuIdentifier: fsn,
      marketplaceSkuIdentifierKind: fsn ? "fsn" : "",
      qty: quantity.qty,
      carrierValue: carrier,
      courier: carrier || "—",
      returnType: resultType.value,
      returnTypeRaw: rawType,
      returnReason: reason,
    },
    errors,
    warnings,
    pendingReasons,
  )
}

// Meesho: the AWB is checked against the carrier tracking link (see resolveTrackingId). A number in the file that the
// link does not confirm is an error, because its digits may have been rounded. The SKU and its variation are combined
// without repeating a size already in the SKU.
function meeshoRow(fields: Fields, marketplace: string, profileId: string): ParsedRow {
  const cols = MEESHO_RETURNS
  const errors: string[] = []
  const warnings: string[] = []
  // The AWB is stored as text, unchanged apart from case. A stored number keeps its digits as far as the reader can.
  const awbHeader = cols.awbNumber
  const csvAwb = cleanId(fields.get(awbHeader) ?? "").toUpperCase()
  const storedAsNumber = suspectColumn(fields, awbHeader) && csvAwb !== ""
  const trackingUrl = (fields.get(cols.trackingLink) || "").trim()
  const decision = resolveTrackingId(csvAwb, trackingUrl)
  const orderId = readId(fields, cols.orderNumber, "Order Number", false, errors, warnings)
  const orderLineId = readId(fields, cols.suborderNumber, "Suborder Number", false, errors, warnings)
  const combined = skuWithVariation(fields.get(cols.sku) || "", fields.get(cols.variation) || "")
  const quantity = parseQuantity(fields.get(cols.qty) || "")
  const rawType = (fields.get(cols.typeOfReturn) || "").trim()
  const resultType = normalizeReturnType(marketplace, rawType)
  const carrier = (fields.get(cols.courierPartner) || "").trim()

  if (!decision.trackingId) errors.push("Missing AWB Number")
  if (!combined.value) errors.push("Missing SKU")
  if (quantity.error) errors.push(quantity.error)
  if (decision.validation === "damaged_awb") errors.push(scientificError(csvAwb))
  // A number is trusted only when the verified link confirms it, either equal or as the 15-digit rounding.
  const linkBacked = decision.validation === "match" || decision.validation === "mismatch_resolved"
  if (storedAsNumber && !linkBacked && decision.validation !== "damaged_awb") {
    errors.push(
      `AWB ${csvAwb} is stored as a number in the file, and no verified tracking link confirms its digits. Excel keeps 15 digits, so the last digits may be rounded. Re-save the file as CSV with IDs as text, or upload the marketplace's CSV download.`,
    )
  }
  if (isOverPrecision(decision.trackingId) && !linkBacked && !storedAsNumber) {
    warnings.push(overPrecisionWarning(decision.trackingId))
  }
  if (decision.warning) warnings.push(decision.warning)
  if (isOverPrecision(orderId)) warnings.push(`Order Number ${orderId} has more than 15 digits. Do not use it as a key`)
  const typeWarning = returnTypeWarning(resultType, rawType)
  if (typeWarning) warnings.push(typeWarning)

  // Keep the buyer's reason and the detail together, so the scanner sees both.
  const reason = [fields.get(cols.returnReason) || "", fields.get(cols.detailedReturnReason) || ""]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" · ")

  const row = baseRow(marketplace, profileId)
  return finish(
    {
      ...row,
      trackingId: decision.trackingId,
      csvTrackingId: csvAwb,
      trackingSource: decision.identifierSource === "tracking_link" ? "tracking_url" : "tracking_id",
      identifierSource: decision.identifierSource,
      trackingValidation: decision.validation,
      trackingUrl,
      urlTrackingId: decision.urlTrackingId,
      carrierFromLink: decision.carrierFromLink,
      orderId,
      orderLineId,
      displayOrderItemId: orderLineId,
      displayIdentifierKind: orderLineId ? "order_line" : "",
      channelListingId: combined.value,
      channelSku: combined.value,
      sku: combined.value,
      productName: (fields.get(cols.productName) || "").trim() || combined.value,
      qty: quantity.qty,
      carrierValue: carrier,
      courier: carrier || "—",
      returnType: resultType.value,
      returnTypeRaw: rawType,
      returnReason: reason,
    },
    errors,
    warnings,
  )
}

// Ajio: Return AWB No is the lookup key. RETURN ORDER NUMBER is the display identifier of its own kind. It is not an
// order line, so orderLineId stays empty.
function ajioRow(fields: Fields, marketplace: string, profileId: string, returnTypeHeaders: string[]): ParsedRow {
  const cols = AJIO_RETURNS
  const errors: string[] = []
  const warnings: string[] = []
  const pendingReasons: string[] = []
  const trackingRaw = cleanId(fields.get(cols.trackingId) ?? "")
  const trackingId = readId(fields, cols.trackingId, "Return AWB No", true, errors, warnings, pendingReasons).toUpperCase()
  const orderId = readId(fields, cols.orderId, "Cust Order No", false, errors, warnings)
  const returnOrderNumber = readId(fields, cols.returnOrderNumber, "RETURN ORDER NUMBER", false, errors, warnings)
  const listing = (fields.get(cols.channelListing) || "").trim()
  const identifier = (fields.get(cols.identifier) || "").trim()
  const quantity = parseQuantity(fields.get(cols.quantity) || "", true)
  const rawType = pickFirst(fields, returnTypeHeaders)
  const resultType = normalizeReturnType(marketplace, rawType)
  const carrier = (fields.get(AJIO_OPTIONAL.carrier) || "").trim()
  const shipmentId = readId(fields, AJIO_OPTIONAL.shipmentId, "Return Shipment ID", false, errors, warnings)

  if (!trackingId && trackingRaw === "") pendingReasons.push("Missing Return AWB No; the row is pending and cannot be scanned.")
  if (!listing) errors.push("Missing SELLER SKU")
  if (quantity.error) errors.push(quantity.error)
  if (quantity.pending) pendingReasons.push(quantity.pending)
  if (isOverPrecision(trackingId)) warnings.push(overPrecisionWarning(trackingId))
  const typeWarning = returnTypeWarning(resultType, rawType)
  if (typeWarning) warnings.push(typeWarning)

  const row = baseRow(marketplace, profileId)
  return finish(
    {
      ...row,
      trackingId,
      csvTrackingId: trackingRaw,
      trackingSource: "tracking_id",
      trackingValidation: trackingId ? "not_applicable" : trackingRaw ? "damaged_awb" : "blank_awb",
      orderId,
      orderLineId: "",
      displayOrderItemId: returnOrderNumber,
      displayIdentifierKind: returnOrderNumber ? "ajio_return_order_number" : "",
      shipmentId: shipmentId || "",
      channelListingId: listing,
      channelSku: listing,
      sku: listing,
      productName: listing,
      marketplaceSkuIdentifier: identifier,
      marketplaceSkuIdentifierKind: identifier ? "jiocode" : "",
      qty: quantity.qty,
      carrierValue: carrier,
      courier: carrier || "—",
      returnType: resultType.value,
      returnTypeRaw: rawType,
      returnReason: (fields.get(cols.returnReason) || "").trim(),
    },
    errors,
    warnings,
    pendingReasons,
  )
}

// Amazon: Reverse Leg Tracking ID is the lookup AWB. Forward Leg Tracking ID and RMA ID are kept separately for
// audit. When reverse tracking is blank, the row is pending and cannot be scanned; forward tracking is never substituted.
// Shipment ID is preserved and shown as display Order Item ID.
function amazonRow(fields: Fields, marketplace: string, profileId: string, returnTypeHeaders: string[]): ParsedRow {
  const cols = AMAZON_RETURNS
  const errors: string[] = []
  const warnings: string[] = []
  const pendingReasons: string[] = []
  const trackingRaw = cleanId(fields.get(cols.trackingId) ?? "")
  const reverseBlank = trackingRaw === ""
  const reverseTracking = readId(fields, cols.trackingId, "Reverse Leg Tracking ID", true, errors, warnings, pendingReasons).toUpperCase()
  const forwardRaw = cleanId(fields.get(AMAZON_OPTIONAL.forwardLegTracking) ?? "")
  const forwardTracking = readId(fields, AMAZON_OPTIONAL.forwardLegTracking, "Forward Leg Tracking ID", false, errors, warnings).toUpperCase()
  const orderId = readId(fields, cols.orderId, "Customer Order ID", false, errors, warnings)
  const shipmentId = readId(fields, cols.shipmentId, "Shipment ID", false, errors, warnings)
  const listing = (fields.get(cols.channelListing) || "").trim()
  const identifier = (fields.get(cols.identifier) || "").trim()
  const skuListing = (fields.get(AMAZON_OPTIONAL.sku) || "").trim()
  const quantity = parseQuantity(fields.get(cols.quantity) || "")
  const rawType = pickFirst(fields, returnTypeHeaders)
  const resultType = normalizeReturnType(marketplace, rawType)
  const carrier = (fields.get(AMAZON_OPTIONAL.carrier) || "").trim()

  const trackingId = reverseTracking
  const trackingSource: TrackingSource = "tracking_id"
  const altTrackingId = ""

  if (!trackingId && reverseBlank) {
    pendingReasons.push("Missing Reverse Leg Tracking ID; the row is pending and cannot be scanned.")
  }
  if (!listing) errors.push("Missing mSKU")
  if (quantity.error) errors.push(quantity.error)
  if (isOverPrecision(trackingId)) warnings.push(overPrecisionWarning(trackingId))
  const typeWarning = returnTypeWarning(resultType, rawType)
  if (typeWarning) warnings.push(typeWarning)

  const row = baseRow(marketplace, profileId)
  return finish(
    {
      ...row,
      trackingId,
      csvTrackingId: trackingRaw,
      trackingSource,
      trackingValidation: trackingId ? "not_applicable" : trackingRaw ? "damaged_awb" : "blank_awb",
      altTrackingId,
      forwardTrackingId: forwardTracking,
      returnEventId: readId(fields, AMAZON_OPTIONAL.rmaId, "RMA ID", false, errors, warnings),
      orderId,
      orderLineId: "",
      displayOrderItemId: shipmentId,
      displayIdentifierKind: shipmentId ? "amazon_shipment_id" : "",
      shipmentId: shipmentId || "",
      channelListingId: listing,
      channelSku: skuListing || listing,
      sku: listing,
      productName: listing,
      marketplaceSkuIdentifier: identifier,
      marketplaceSkuIdentifierKind: identifier ? "asin" : "",
      qty: quantity.qty,
      carrierValue: carrier,
      courier: carrier || "—",
      returnType: resultType.value,
      returnTypeRaw: rawType,
      returnReason: (fields.get(cols.returnReason) || "").trim(),
    },
    errors,
    warnings,
    pendingReasons,
  )
}

function mapRow(profile: ImportProfile, fields: Fields, marketplace: string): ParsedRow {
  switch (profile.id) {
    case "myntra-seller-returns":
      return myntraRow(fields, marketplace, profile.id)
    case "flipkart-returns":
      return flipkartRow(fields, marketplace, profile.id)
    case "meesho-returns":
      return meeshoRow(fields, marketplace, profile.id)
    case "ajio-returns":
      return ajioRow(fields, marketplace, profile.id, profile.returnTypeHeaders)
    case "amazon-returns":
      return amazonRow(fields, marketplace, profile.id, profile.returnTypeHeaders)
    default:
      return genericRow(fields, marketplace)
  }
}

// Repeats within one file are classified, never merged by AWB alone:
//  - exact_import_row: the same values as an earlier row. Not counted again (kept in upload_rows).
//  - same AWB, SKU and order line with different details, or a second return event: both rows are kept as separate
//    lines and flagged. Nothing is summed.
//  - same AWB with another SKU (several products in one shipment), or the same SKU on another line (several units or
//    lines): normal, no flag.
function flagRepeats(rows: ParsedRow[]): void {
  const exact = new Set<string>()
  const lines = new Map<string, ParsedRow>()
  for (const row of rows) {
    if (!row.valid) continue
    const fingerprint = row.rowFingerprint ?? ""
    if (fingerprint && exact.has(fingerprint)) {
      row.duplicate = true
      row.duplicateKind = "exact_import_row"
      row.warnings = [
        ...row.warnings,
        "Identical to an earlier row in this file. Not counted again. If the report lists separate units on identical rows, check the file.",
      ]
      continue
    }
    if (fingerprint) exact.add(fingerprint)

    const key = [row.trackingId, row.channelListingId || row.sku, row.orderLineId || row.displayOrderItemId || ""].join("|")
    const earlier = lines.get(key)
    if (!earlier) {
      lines.set(key, row)
      continue
    }
    if (row.returnEventId && earlier.returnEventId && row.returnEventId !== earlier.returnEventId) {
      row.warnings = [
        ...row.warnings,
        `Second return event (${row.returnEventId}) for this AWB and line. Kept as a separate line.`,
      ]
    } else {
      row.warnings = [
        ...row.warnings,
        "Same AWB, SKU and order line as an earlier row, with different details. Kept as a separate line; check the file.",
      ]
    }
  }
}

// Returns "" when the file's seller matches the marketplace. Otherwise returns the reason to reject it.
// Checked before any row is saved, so a wrong-account file leaves the database unchanged.
function sellerProblem(
  profile: ImportProfile,
  marketplace: string,
  records: Fields[],
  preamble: Map<string, string>,
) {
  const expected = profile.sellerIds?.[marketplace]
  if (!expected) return ""
  const label = profile.sellerLabel || "seller"

  let found: string[] = []
  if (profile.sellerColumn) {
    const column = profile.sellerColumn
    found = [...new Set(records.map((fields) => (fields.get(column) || "").trim()).filter(Boolean))]
  } else if (profile.sellerPreambleKey) {
    const value = (preamble.get(profile.sellerPreambleKey) || "").trim()
    if (!value) return `No ${label} was found above the header row. Nothing was imported.`
    found = [value]
  }

  const wrong = found.filter((seller) => seller !== expected)
  if (!wrong.length) return ""
  const accounts = Object.entries(profile.sellerIds || {})
    .map(([name, id]) => `${id} = ${name}`)
    .join(", ")
  return `This file has ${label} ${wrong.join(", ")}, but ${marketplace} is ${expected}. Nothing was imported. Pick the marketplace that matches the file (${accounts}).`
}

export function parseSpreadsheet(buffer: Buffer, fallbackMarketplace: string, filename = ""): ParseResult {
  const grid = usableGrid(readGrid(buffer, filename))
  if (!grid.rows.length) {
    return { profileId: "none", rows: [], fatal: "The file has no header row.", warningCount: 0 }
  }

  const profile = profileForMarketplace(fallbackMarketplace)
  if (!profile) {
    const { records } = toFields(grid, 0)
    const parsed = records
      .map((fields, index) => withRaw(genericRow(fields, fallbackMarketplace), fields, null, index + 1))
      .filter(keepRow)
    flagRepeats(parsed)
    return { profileId: "generic", rows: parsed, fatal: "", warningCount: countWarnings(parsed) }
  }

  const located = locateHeader(grid.rows, profile.requiredHeaders, profile.headerAliases)
  if (located.missing.length) {
    return {
      profileId: profile.id,
      rows: [],
      fatal: `${profile.label}: missing required header(s) ${located.missing.join(", ")}. The export layout changed. Update server/import-profiles.ts or re-download the report.`,
      warningCount: 0,
    }
  }

  const preamble = readPreamble(grid.rows.slice(0, located.index))
  const { records } = toFields(grid, located.index, profile.headerAliases)

  const problem = sellerProblem(profile, fallbackMarketplace, records, preamble)
  if (problem) return { profileId: profile.id, rows: [], fatal: problem, warningCount: 0 }

  const parsed = records
    .map((fields, index) => withRaw(mapRow(profile, fields, fallbackMarketplace), fields, profile, index + 1))
    .filter(keepRow)
  flagRepeats(parsed)
  return { profileId: profile.id, rows: parsed, fatal: "", warningCount: countWarnings(parsed) }
}

// Lists the headers and the first data rows of a file, for checking a layout against a real export. Nothing is
// stored. The header row is found the same way the importer finds it.
export function inspectLayout(buffer: Buffer, filename: string, marketplace: string, sampleRows = 3) {
  const grid = usableGrid(readGrid(buffer, filename))
  const profile = profileForMarketplace(marketplace)
  if (!grid.rows.length) return { headers: [], sample: [] as string[][], profileId: "none", missingRequired: [] as string[] }
  const located = profile ? locateHeader(grid.rows, profile.requiredHeaders, profile.headerAliases) : { index: 0, missing: [] as string[], score: 0 }
  const headerIndex = profile ? located.index : 0
  return {
    headers: grid.rows[headerIndex].map((cell) => normalizeHeader(cell)),
    sample: grid.rows.slice(headerIndex + 1, headerIndex + 1 + sampleRows),
    profileId: profile ? profile.id : "generic",
    missingRequired: profile ? located.missing : [],
    headerRowIndex: headerIndex,
  }
}

// Reads the product master: a channel listing SKU to a VB EXPORT product SKU, with its category and image link.
//
// Two known layouts are accepted, matched by header name (never by column letter):
//   - "Product SKU Codes" export: Channel Listing SKU Code, Product SkuCode, Product Category, Channel Image URL
//   - VB EXPORT product category workbook: Marketplace SKU, VB EXPORT SKU's, VB Export Product Category, COGS, Weight Slab
//
// The marketplace scope of every row comes from, in order:
//   1. marketplaceOverride, when it names one account (the administrator's choice on the Admin screen or --marketplace);
//   2. a "Marketplace" column in the file;
//   3. "all" (applies to every account).
// A scope of "all" is the fallback the lookup uses when no row names the account.
export function parseProductMaster(buffer: Buffer, filename: string, marketplaceOverride?: string): MasterParseResult {
  const forcedScope = (marketplaceOverride || "").trim().toLowerCase()
  const forced = forcedScope && forcedScope !== "all" ? forcedScope : ""
  const grid = usableGrid(readGrid(buffer, filename))
  if (!grid.rows.length) {
    return { rows: [], skipped: 0, invalidImages: 0, conflictCount: 0, conflicts: [], fatal: "The product master file has no rows." }
  }
  const { headers, records } = toFields(grid, 0)
  const listingHeader = headers.find((h) =>
    ["marketplace_sku", "channel_listing_sku_code", "channel_listing_sku", "seller_sku", "seller_sku_code"].includes(h),
  )
  const masterHeader = headers.find((h) =>
    ["vb_export_sku's", "vb_export_sku", "master_sku", "product_skucode", "product_sku_code", "product_sku"].includes(h),
  )
  const categoryHeader = headers.find((h) => h === "vb_export_product_category" || h === "product_category" || h === "category")
  const imageHeader = headers.find((h) => h === "channel_image_url" || h === "image_url" || h === "image_link" || h === "image")
  const cogsHeader = headers.find((h) => h.startsWith("cogs"))
  const weightHeader = headers.find((h) => h.startsWith("weight_slab") || h === "weight")

  if (!listingHeader || !masterHeader || listingHeader === masterHeader) {
    return {
      rows: [],
      skipped: 0,
      invalidImages: 0,
      conflictCount: 0,
      conflicts: [],
      fatal: `The product master needs a listing SKU column ("Marketplace SKU" or "Channel Listing SKU Code") and a product SKU column ("VB EXPORT SKU's" or "Product SkuCode"). Found: ${headers.join(", ") || "none"}.`,
    }
  }

  const byKey = new Map<string, MasterRow>()
  const conflictMasters = new Map<string, Set<string>>()
  let skipped = 0
  let invalidImages = 0
  for (const fields of records) {
    const listingSku = cleanId(fields.get(listingHeader) || "")
    const masterSku = cleanId(fields.get(masterHeader) || "")
    if (!listingSku || !masterSku) {
      skipped++
      continue
    }
    const rawImage = imageHeader ? (fields.get(imageHeader) || "").trim() : ""
    const imageUrl = normalizeImageUrl(rawImage)
    if (rawImage && !imageUrl) invalidImages++
    const marketplace = forced || (fields.get("marketplace") || "").trim().toLowerCase() || "all"
    const key = `${marketplace}|${listingSku}`
    // The same listing SKU with a different product SKU is a conflict in the file. The last row wins, as before, but
    // the conflict is reported so a wrong mapping is never silent.
    const previous = byKey.get(key)
    if (previous && previous.masterSku !== masterSku) {
      const set = conflictMasters.get(key) ?? new Set([previous.masterSku])
      set.add(masterSku)
      conflictMasters.set(key, set)
    }
    byKey.set(key, {
      listingSku,
      marketplace,
      masterSku,
      category: categoryHeader ? (fields.get(categoryHeader) || "").trim() : "",
      cogs: toMoney(cogsHeader ? fields.get(cogsHeader) : undefined),
      weightSlab: toMoney(weightHeader ? fields.get(weightHeader) : undefined),
      imageUrl,
    })
  }
  const conflicts = [...conflictMasters].slice(0, CONFLICT_LIMIT).map(([key, masterSkus]) => {
    const [marketplace, listingSku] = key.split("|")
    return { listingSku, marketplace, masterSkus: [...masterSkus] }
  })
  return { rows: [...byKey.values()], skipped, invalidImages, conflictCount: conflictMasters.size, conflicts, fatal: "" }
}

// Counts what a parsed product master holds, without touching the database. Used by the Admin preview.
export function summarizeProductMaster(
  rows: MasterRow[],
): Omit<MasterPreview, "fatal" | "invalidImages" | "skipped" | "conflictCount" | "conflictSample" | "sample"> {
  const listings = new Set<string>()
  const masters = new Set<string>()
  const categories = new Set<string>()
  const scopeCounts = new Map<string, number>()
  let withImage = 0
  for (const row of rows) {
    listings.add(row.listingSku)
    masters.add(row.masterSku)
    if (row.category) categories.add(row.category)
    if (row.imageUrl) withImage++
    scopeCounts.set(row.marketplace, (scopeCounts.get(row.marketplace) ?? 0) + 1)
  }
  return {
    rows: rows.length,
    listings: listings.size,
    masters: masters.size,
    withImage,
    withoutImage: rows.length - withImage,
    categories: categories.size,
    scopes: [...scopeCounts].map(([marketplace, count]) => ({ marketplace, rows: count })),
  }
}

// One entry point for the Admin preview: parse the file, then summarize it with a few sample rows.
export function previewProductMaster(buffer: Buffer, filename: string, marketplaceOverride?: string): MasterPreview {
  const parsed = parseProductMaster(buffer, filename, marketplaceOverride)
  if (parsed.fatal) {
    return {
      fatal: parsed.fatal,
      rows: 0,
      listings: 0,
      masters: 0,
      withImage: 0,
      withoutImage: 0,
      invalidImages: 0,
      categories: 0,
      skipped: 0,
      conflictCount: 0,
      conflictSample: [],
      scopes: [],
      sample: [],
    }
  }
  const summary = summarizeProductMaster(parsed.rows)
  return {
    fatal: "",
    ...summary,
    invalidImages: parsed.invalidImages,
    skipped: parsed.skipped,
    conflictCount: parsed.conflictCount,
    conflictSample: parsed.conflicts,
    sample: parsed.rows.slice(0, 20).map((row) => ({
      listingSku: row.listingSku,
      masterSku: row.masterSku,
      category: row.category,
      imageUrl: row.imageUrl,
    })),
  }
}

// Header row only. The template carries no sample data, so an unchanged copy cannot import a made-up return.
export function templateCsv() {
  return "tracking_id,order_id,channel_sku,product_sku,product_name,quantity,courier,return_type,return_reason,color,key_detail,brand_label,set_contents\n"
}

// Header row only for the product SKU master. No sample rows, so loading the file unchanged stores nothing.
export function productMasterTemplateCsv() {
  return "Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL\n"
}
