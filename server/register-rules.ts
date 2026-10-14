// Pure rules for the return scan register. Nothing in this file touches the database, so every rule can be tested
// directly. The service layer (register-service.ts) loads the reference rows and applies these rules inside a
// transaction.

export const TICKET_STATUSES = ["Draft", "Raised", "Review", "Approved", "Rejected"] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

// Where a line's product SKU came from at upload time. "unrecorded" marks lines saved before this was recorded.
export const PRODUCT_SKU_SOURCES = ["product_master", "omsguru_master", "unresolved", "unrecorded"] as const

export const UNKNOWN_PARTNER_LABEL = "Unknown / Pending Verification"

export const MAX_NOTES_LENGTH = 500
export const MAX_TICKET_LENGTH = 60
export const MAX_REASON_LENGTH = 500

// Scan keys are made in the browser (crypto.randomUUID) and sent with every save. A retry reuses the same key.
export function isValidClientKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{8,100}$/.test(key)
}

// Tracking IDs are matched as the text in the file. Only surrounding spaces are removed, and letters are
// upper-cased the same way the import does. Scientific notation is refused, because its digits are already lost.
export function normalizeTracking(raw: string): { value: string; error: string } {
  let value = raw.trim().toUpperCase()
  if (!value) return { value, error: "Enter a tracking ID or Order ID" }
  if (/^[+-]?\d+(\.\d+)?E[+-]?\d+$/.test(value)) {
    return { value, error: `${value} is in scientific notation, so its digits were lost. Scan the label again.` }
  }
  // Strip common barcode prefixes: #, ORDER#, ORDER:, ORD#, ORD:
  if (value.startsWith("#")) value = value.slice(1).trim()
  if (/^ORDER[:#\s-]+/i.test(value)) value = value.replace(/^ORDER[:#\s-]+/i, "").trim()
  if (/^ORD[:#\s-]+/i.test(value)) value = value.replace(/^ORD[:#\s-]+/i, "").trim()

  // Check if string contains an Amazon Order ID pattern (e.g. 408-1234567-1234567)
  const amzMatch = value.match(/\b\d{3}-\d{7}-\d{7}\b/)
  if (amzMatch) {
    return { value: amzMatch[0], error: "" }
  }
  // If exactly 17 digits numeric starting with 40X (Amazon order format without hyphens), standardize with hyphens
  const amz17Match = value.match(/\b(40\d)(\d{7})(\d{7})\b/)
  if (amz17Match) {
    return { value: `${amz17Match[1]}-${amz17Match[2]}-${amz17Match[3]}`, error: "" }
  }
  if (!value) return { value, error: "Enter a tracking ID or Order ID" }
  return { value, error: "" }
}

export function normalizeTicketCode(raw: string): string {
  return raw.trim()
}

// The product SKU is shown only when it was resolved. An unresolved line shows nothing, so the scanner sees a gap.
export function productSkuFor(source: string | null, code: string): string {
  return source === "unresolved" ? "" : code
}

export function productSkuSourceFor(source: string | null): string {
  return source ?? "unrecorded"
}

// Which stored AWB of a return matched the scanned one, and which leg it is. The return leg is the reverse AWB
// (Myntra AG, Amazon Reverse Leg). The forward leg is the outbound AWB (Myntra AF, Amazon Forward Leg).
export type MatchedLeg = "return" | "forward" | "unknown"

export function legFor(trackingSource: string | null | undefined): MatchedLeg {
  if (trackingSource === "return_tracking") return "return"
  if (trackingSource === "forward_tracking") return "forward"
  return "unknown"
}

export function matchedFieldFor(
  scanned: string,
  trackingId: string,
  altTrackingId: string | null,
  trackingSource: string | null | undefined,
  orderNumber?: string | null,
  itemOrderIds?: string[],
): { field: "" | "tracking_id" | "alt_tracking_id" | "order_number"; leg: MatchedLeg } {
  if (!scanned) return { field: "", leg: "unknown" }
  if (scanned === trackingId) return { field: "tracking_id", leg: legFor(trackingSource) }
  if (altTrackingId && scanned === altTrackingId) return { field: "alt_tracking_id", leg: "forward" }
  const cleanScanned = scanned.replace(/[-\s]/g, "").toUpperCase()
  if (
    orderNumber &&
    (scanned.toUpperCase() === orderNumber.toUpperCase() ||
      (cleanScanned.length >= 8 && cleanScanned === orderNumber.replace(/[-\s]/g, "").toUpperCase()))
  ) {
    return { field: "order_number", leg: "return" }
  }
  if (
    itemOrderIds &&
    itemOrderIds.some(
      (id) =>
        id &&
        (id.toUpperCase() === scanned.toUpperCase() ||
          (cleanScanned.length >= 8 && cleanScanned === id.replace(/[-\s]/g, "").toUpperCase())),
    )
  ) {
    return { field: "order_number", leg: "return" }
  }
  return { field: "", leg: "unknown" }
}

export const MATCHED_TRACKING_LABELS: Record<string, string> = {
  "": "Not recorded",
  tracking_id: "Primary tracking ID",
  alt_tracking_id: "Alternate tracking ID",
  order_number: "Order ID (manual scan)",
}

export const MATCHED_LEG_LABELS: Record<string, string> = {
  return: "Return leg",
  forward: "Forward leg",
  unknown: "Not known",
}

export const TRACKING_SOURCE_LABELS: Record<string, string> = {
  return_tracking: "Return AWB (file column)",
  forward_tracking: "Forward AWB (file column, return AWB blank)",
  tracking_id: "Tracking ID (file column)",
  tracking_url: "Tracking link (verified)",
}

// ---------------------------------------------------------------------------------------------------------------
// Lookup decisions
// ---------------------------------------------------------------------------------------------------------------

export type LookupEntry = {
  // Null when the entry only records an earlier scan in an account that no longer has an active lookup row.
  shipmentId: number | null
  accountId: number
  accountName: string
  alreadyReceived: boolean
  orderId: string
  itemCount: number
  receivedAt: string
  scannedBy: string
}

export type LookupDecision =
  | { kind: "none" }
  | { kind: "single"; entry: LookupEntry }
  | { kind: "duplicate"; entry: LookupEntry }
  | { kind: "choose"; entries: LookupEntry[] }

// One match means one answer. More than one match (two accounts, or two shipments) means the employee must choose.
// Nothing is picked silently.
export function decideLookup(entries: LookupEntry[]): LookupDecision {
  if (entries.length === 0) return { kind: "none" }
  if (entries.length > 1) return { kind: "choose", entries }
  const [entry] = entries
  if (entry.alreadyReceived || entry.shipmentId === null) return { kind: "duplicate", entry }
  return { kind: "single", entry }
}

// ---------------------------------------------------------------------------------------------------------------
// Scan submission rules
// ---------------------------------------------------------------------------------------------------------------

export type CategoryRule = {
  code: string
  label: string
  isClear: boolean
  isMissing: boolean
  requiresTicket: boolean
  allowsSubIssue: boolean
  requiresSubIssue: boolean
  active: boolean
  // An operational category (Iron Send) is recorded with the scan but is not a return issue: it is not counted in the
  // issue figures or the claims, and its units are never sent to OMSGuru. See server/schema-iron.sql.
  isOperational?: boolean
}

// True when an issue in this category makes the scan an issue return. Unknown codes count as issues, so a category
// that is missing from the rules is never hidden from the issue figures.
export function countsAsReturnIssue(category: Pick<CategoryRule, "isOperational"> | undefined): boolean {
  return !category?.isOperational
}

export type SubIssueRule = { id: number; label: string; categoryCode: string; active: boolean }

export type LookupItemRule = { id: number; expectedQty: number }

export type SubmittedIssue = {
  categoryCode: string
  subIssueId: number | null
  qty: number
  ticketCode: string
  notes: string
}

export type SubmittedItem = {
  itemId: number
  receivedQty: number
  verified: boolean
  issues: SubmittedIssue[]
}

export type ScanSubmission = {
  shipmentId: number
  clientScanKey: string
  notes: string
  items: SubmittedItem[]
  // The AWB the employee scanned. Used to record which stored AWB matched (see matchedFieldFor).
  scannedTracking?: string
}

export type RuleResult = { ok: true } | { ok: false; errors: string[] }

// Every expected line must be listed exactly once and physically verified. The units that were not received must be
// covered, one for one, by missing-item issues. Issues on received units cannot exceed the units received.
export function validateScanSubmission(
  items: LookupItemRule[],
  submission: ScanSubmission,
  categories: CategoryRule[],
  subIssues: SubIssueRule[],
): RuleResult {
  const errors: string[] = []
  if (!isValidClientKey(submission.clientScanKey)) errors.push("The scan key is missing or malformed.")
  if (submission.notes.length > MAX_NOTES_LENGTH) {
    errors.push(`Notes must be ${MAX_NOTES_LENGTH} characters or fewer.`)
  }
  if (submission.items.length === 0) errors.push("Verify at least one item before saving.")

  const expectedById = new Map<number, number>()
  for (const item of items) expectedById.set(item.id, item.expectedQty)
  const categoryByCode = new Map<string, CategoryRule>()
  for (const category of categories) categoryByCode.set(category.code, category)
  const subById = new Map<number, SubIssueRule>()
  for (const sub of subIssues) subById.set(sub.id, sub)

  const listed = new Set<number>()
  for (const submitted of submission.items) {
    if (listed.has(submitted.itemId)) errors.push(`Item ${submitted.itemId} is listed more than once.`)
    listed.add(submitted.itemId)
    if (!expectedById.has(submitted.itemId)) {
      errors.push(`Item ${submitted.itemId} does not belong to this return.`)
    }
  }
  for (const item of items) {
    if (!listed.has(item.id)) errors.push(`Item ${item.id} has not been verified.`)
  }

  const ticketCodes = new Set<string>()
  for (const submitted of submission.items) {
    const expected = expectedById.get(submitted.itemId)
    if (expected === undefined) continue
    const label = `Item ${submitted.itemId}`

    if (!submitted.verified) errors.push(`${label}: confirm the physical check before saving.`)
    if (!Number.isInteger(submitted.receivedQty) || submitted.receivedQty < 0 || submitted.receivedQty > expected) {
      errors.push(`${label}: received quantity must be a whole number from 0 to ${expected}.`)
      continue
    }

    let missingIssueQty = 0
    let otherIssueQty = 0
    for (const issue of submitted.issues) {
      const category = categoryByCode.get(issue.categoryCode)
      if (!category || !category.active) {
        errors.push(`${label}: the issue category "${issue.categoryCode}" is not available.`)
        continue
      }
      if (category.isClear) {
        errors.push(`${label}: "${category.label}" is not an issue. Leave it out.`)
        continue
      }
      if (!Number.isInteger(issue.qty) || issue.qty < 1 || issue.qty > expected) {
        errors.push(`${label}: ${category.label} needs a quantity from 1 to ${expected}.`)
        continue
      }
      if (issue.notes.length > MAX_NOTES_LENGTH) {
        errors.push(`${label}: notes must be ${MAX_NOTES_LENGTH} characters or fewer.`)
      }

      if (issue.subIssueId === null) {
        if (category.requiresSubIssue) {
          errors.push(`${label}: choose what is missing for ${category.label}.`)
          continue
        }
      } else if (!category.allowsSubIssue) {
        errors.push(`${label}: ${category.label} does not take a sub-issue.`)
        continue
      } else {
        const sub = subById.get(issue.subIssueId)
        if (!sub || !sub.active || sub.categoryCode !== category.code) {
          errors.push(`${label}: the sub-issue is not valid for ${category.label}.`)
          continue
        }
      }

      const code = normalizeTicketCode(issue.ticketCode)
      if (category.requiresTicket && !code) {
        errors.push(`${label}: ${category.label} needs a ticket ID.`)
        continue
      }
      if (!category.requiresTicket && code) {
        errors.push(`${label}: ${category.label} does not take a ticket ID.`)
        continue
      }
      if (code.length > MAX_TICKET_LENGTH) {
        errors.push(`${label}: the ticket ID must be ${MAX_TICKET_LENGTH} characters or fewer.`)
        continue
      }
      if (code) {
        if (ticketCodes.has(code)) {
          errors.push(`The ticket ${code} is used more than once.`)
          // The qty of this issue is still excluded from the coverage math, so a missing-item issue
          // with a duplicate ticket does not silently satisfy the missing-unit check.
          continue
        }
        ticketCodes.add(code)
      }

      if (category.isMissing) missingIssueQty += issue.qty
      else otherIssueQty += issue.qty
    }

    const missingUnits = expected - submitted.receivedQty
    if (missingIssueQty !== missingUnits) {
      errors.push(
        `${label}: ${missingUnits} unit(s) are not received, and the missing-item issues cover ${missingIssueQty}. They must match.`,
      )
    }
    if (otherIssueQty > submitted.receivedQty) {
      errors.push(
        `${label}: issues on received units (${otherIssueQty}) are more than the ${submitted.receivedQty} received.`,
      )
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

// The scan-level status stored on receipt_scans. Clear means nothing was wrong. Raised means a ticket was opened.
export function scanStatusFor(hasIssue: boolean, hasTicket: boolean): "Clear" | "Raised" | "Draft" {
  if (!hasIssue) return "Clear"
  return hasTicket ? "Raised" : "Draft"
}

export type IssuePart = { categoryLabel: string; subIssueLabel: string; qty: number }

// The short text kept on receipt_scans.issue_label and shown in the register.
export function describeIssues(parts: IssuePart[]): string {
  if (parts.length === 0) return "No issue"
  return parts
    .map((part) => {
      const sub = part.subIssueLabel ? ` (${part.subIssueLabel})` : ""
      const qty = part.qty > 1 ? ` ×${part.qty}` : ""
      return `${part.categoryLabel}${sub}${qty}`
    })
    .join("; ")
}

// ---------------------------------------------------------------------------------------------------------------
// Ticket status changes
// ---------------------------------------------------------------------------------------------------------------

// Returns the reason the change is refused, or null when it may be saved.
export function ticketStatusError(current: string, next: string, reason: string): string | null {
  if (!(TICKET_STATUSES as readonly string[]).includes(next)) return "Choose a valid ticket status."
  if (next === current) return `The ticket is already ${next}.`
  const trimmed = reason.trim()
  if (trimmed.length > MAX_REASON_LENGTH) return `The reason must be ${MAX_REASON_LENGTH} characters or fewer.`
  if (next === "Rejected" && !trimmed) return "A rejection reason is required when a ticket is rejected."
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Register rows
// ---------------------------------------------------------------------------------------------------------------

export type RawIssue = {
  categoryCode?: string
  categoryLabel?: string
  subIssueLabel?: string
  qty?: number
  notes?: string
  ticketId?: number | null
  ticketCode?: string | null
  ticketStatus?: string | null
  rejectionReason?: string | null
}

// One row of the register query: one verified item (or one legacy shipment line), with its issues as JSON.
// The fields after line_no are optional so that rows read from older queries still map.
export type RawRegisterRow = {
  row_key: string
  source: string
  scan_id: number
  scanned_at: Date
  scan_day: string
  scan_time: string
  scan_status: string
  scanner_name: string
  marketplace_id: number
  marketplace: string
  tracking_id: string
  order_number: string
  order_item_id: string
  marketplace_sku: string
  product_sku: string
  product_sku_source: string
  marketplace_sku_identifier: string
  product_name: string
  return_type: string
  return_reason: string
  expected_qty: number
  received_qty: number | null
  line_no: number
  issues: RawIssue[] | null
  logistic_partner_name?: string | null
  partner_method?: string | null
  matched_tracking_field?: string | null
  matched_leg?: string | null
  tracking_validation?: string | null
  display_identifier_kind?: string | null
  return_type_raw?: string | null
  alt_tracking_id?: string | null
  scanned_tracking?: string | null
  csv_tracking?: string | null
  url_tracking?: string | null
  tracking_source?: string | null
  forward_tracking?: string | null
  return_event?: string | null
  source_filename?: string | null
  source_batch_id?: number | null
  sales_amount?: number | string | null
}

export type RegisterTicket = { id: number; code: string; status: string; rejectionReason: string }

export type RegisterIssue = {
  categoryCode: string
  categoryLabel: string
  subIssueLabel: string
  qty: number
  notes: string
  ticket: RegisterTicket | null
}

export type RegisterRow = {
  key: string
  source: "item" | "legacy"
  scanId: number
  scannedAt: string
  scanDay: string
  scanTime: string
  scanStatus: string
  scannedBy: string
  marketplaceId: number
  marketplace: string
  // The lookup AWB (the resolved tracking ID the scan matched on).
  trackingId: string
  // The AWB exactly as the upload file wrote it. Equal to trackingId unless a verified link corrected it.
  originalTrackingId: string
  urlTrackingId: string
  trackingSource: string
  forwardTrackingId: string
  returnEventId: string
  // The AWB the employee scanned, and which stored AWB and leg it matched.
  scannedTracking: string
  orderId: string
  orderItemId: string
  displayIdentifierKind: string
  marketplaceSku: string
  productSku: string
  productSkuSource: string
  marketplaceSkuIdentifier: string
  productName: string
  logisticPartner: string
  partnerMethod: string
  trackingValidation: string
  matchedTrackingField: string
  matchedLeg: string
  returnType: string
  returnTypeRaw: string
  returnReason: string
  expectedQty: number
  receivedQty: number | null
  // The original marketplace source: the file name and the import batch it came from.
  sourceFile: string
  sourceBatchId: number | null
  // Reserved for the Sales Database integration. Always null until a verified source exists.
  amount: number | null
  // Reserved for the claims integration. Always null until a verified source exists.
  claimAmount: number | null
  issues: RegisterIssue[]
}

// "no_issue" entries are dropped, so a clean line has an empty issue list. Legacy scans keep their old label.
export function mapRegisterRow(raw: RawRegisterRow): RegisterRow {
  const issues: RegisterIssue[] = (raw.issues || [])
    .filter((issue) => Boolean(issue) && issue.categoryCode !== "no_issue")
    .map((issue) => ({
      categoryCode: String(issue.categoryCode ?? ""),
      categoryLabel: String(issue.categoryLabel ?? ""),
      subIssueLabel: String(issue.subIssueLabel ?? ""),
      qty: Number(issue.qty ?? 0),
      notes: String(issue.notes ?? ""),
      ticket: issue.ticketId
        ? {
            id: Number(issue.ticketId),
            code: String(issue.ticketCode ?? ""),
            status: String(issue.ticketStatus ?? ""),
            rejectionReason: String(issue.rejectionReason ?? ""),
          }
        : null,
    }))
  return {
    key: raw.row_key,
    source: raw.source === "legacy" ? "legacy" : "item",
    scanId: Number(raw.scan_id),
    scannedAt: new Date(raw.scanned_at).toISOString(),
    scanDay: raw.scan_day,
    scanTime: raw.scan_time,
    scanStatus: raw.scan_status,
    scannedBy: raw.scanner_name,
    marketplaceId: Number(raw.marketplace_id),
    marketplace: raw.marketplace,
    trackingId: raw.tracking_id,
    originalTrackingId: String(raw.csv_tracking || raw.tracking_id),
    urlTrackingId: String(raw.url_tracking || ""),
    trackingSource: String(raw.tracking_source || "tracking_id"),
    forwardTrackingId: String(raw.forward_tracking || ""),
    returnEventId: String(raw.return_event || ""),
    scannedTracking: String(raw.scanned_tracking || ""),
    orderId: raw.order_number,
    orderItemId: raw.order_item_id,
    displayIdentifierKind: String(raw.display_identifier_kind ?? ""),
    marketplaceSku: raw.marketplace_sku,
    productSku: raw.product_sku,
    productSkuSource: raw.product_sku_source,
    marketplaceSkuIdentifier: raw.marketplace_sku_identifier,
    productName: raw.product_name,
    logisticPartner: String(raw.logistic_partner_name || UNKNOWN_PARTNER_LABEL),
    partnerMethod: String(raw.partner_method ?? "none"),
    trackingValidation: String(raw.tracking_validation ?? "not_applicable"),
    matchedTrackingField: String(raw.matched_tracking_field ?? ""),
    matchedLeg: String(raw.matched_leg ?? "unknown"),
    returnType: raw.return_type,
    returnTypeRaw: String(raw.return_type_raw ?? ""),
    returnReason: raw.return_reason,
    expectedQty: Number(raw.expected_qty),
    receivedQty: raw.received_qty === null ? null : Number(raw.received_qty),
    sourceFile: String(raw.source_filename || ""),
    sourceBatchId: raw.source_batch_id === null || raw.source_batch_id === undefined ? null : Number(raw.source_batch_id),
    amount: raw.sales_amount !== null && raw.sales_amount !== undefined && raw.sales_amount !== "" ? Number(raw.sales_amount) : null,
    claimAmount: null,
    issues,
  }
}

// The 19 columns of the approved mapping, in order. The default export uses exactly these.
export const REGISTER_APPROVED_HEADERS = [
  "Date",
  "Marketplace",
  "Tracking ID",
  "Order ID",
  "Order Item ID",
  "Marketplace SKU",
  "Product SKU",
  "Marketplace SKU Identification (FNSKU/ASIN/Myntra FSN)",
  "Logistic Partner Name",
  "Return Type",
  "Qty",
  "Amount",
  "Return Reason",
  "Return Received Issue",
  "Return Received Sub Issue (Only If Missing)",
  "Ticket ID (Only If Return Received Issue)",
  "Ticket ID Status",
  "Claim Amount",
  "If Rejected, What the Reason",
]

// The 19 approved columns, then four service columns. Kept under its original name for existing callers.
export const REGISTER_CSV_HEADERS = [
  ...REGISTER_APPROVED_HEADERS,
  "Received Qty",
  "Scanned By",
  "Source",
  "Matched Tracking",
]

// The extended set, then the traceability columns that are kept for audit: the original AWB, the link AWB, the
// scanned AWB, the leg, the source file and batch, and the partner's validation. Optional, for operations.
export const REGISTER_OPERATIONAL_HEADERS = [
  ...REGISTER_CSV_HEADERS,
  "Original Tracking ID (file)",
  "Link Tracking ID",
  "Scanned Tracking ID",
  "Tracking Source",
  "Forward Tracking ID",
  "Return Event ID",
  "Source File",
  "Import Batch ID",
  "Return Type (as file)",
  "Display Identifier Kind",
  "Tracking Validation",
]

export type RegisterColumnMode = "approved" | "extended" | "operational"

export function headersFor(mode: RegisterColumnMode): string[] {
  if (mode === "approved") return REGISTER_APPROVED_HEADERS
  if (mode === "operational") return REGISTER_OPERATIONAL_HEADERS
  return REGISTER_CSV_HEADERS
}

function uniqueJoin(values: string[]): string {
  return [...new Set(values.filter(Boolean))].join("; ")
}

// One row of cells, in the order of headersFor(mode). Used by the CSV and the Excel export, so both match the screen.
export function registerRecords(rows: RegisterRow[], mode: RegisterColumnMode = "extended"): (string | number)[][] {
  return rows.map((row) => {
    const tickets = row.issues.map((issue) => issue.ticket).filter((ticket): ticket is RegisterTicket => ticket !== null)
    const approved: (string | number)[] = [
      row.scanDay,
      row.marketplace,
      row.trackingId,
      row.orderId,
      row.orderItemId,
      row.marketplaceSku,
      row.productSku,
      row.marketplaceSkuIdentifier,
      row.logisticPartner,
      row.returnType,
      row.expectedQty,
      row.amount ?? "",
      row.returnReason,
      row.issues.length ? uniqueJoin(row.issues.map((issue) => issue.categoryLabel)) : "No issue",
      uniqueJoin(row.issues.map((issue) => issue.subIssueLabel)),
      uniqueJoin(tickets.map((ticket) => ticket.code)),
      uniqueJoin(tickets.map((ticket) => ticket.status)),
      row.claimAmount ?? "",
      uniqueJoin(tickets.map((ticket) => ticket.rejectionReason)),
    ]
    if (mode === "approved") return approved
    const extended: (string | number)[] = [
      ...approved,
      row.receivedQty ?? "",
      row.scannedBy,
      row.source === "legacy" ? "Legacy scan (item quantities not recorded)" : "Verified scan",
      `${MATCHED_TRACKING_LABELS[row.matchedTrackingField] ?? "Not recorded"}; ${MATCHED_LEG_LABELS[row.matchedLeg] ?? "Not known"}`,
    ]
    if (mode === "extended") return extended
    return [
      ...extended,
      row.originalTrackingId,
      row.urlTrackingId,
      row.scannedTracking,
      TRACKING_SOURCE_LABELS[row.trackingSource] ?? row.trackingSource,
      row.forwardTrackingId,
      row.returnEventId,
      row.sourceFile,
      row.sourceBatchId ?? "",
      row.returnTypeRaw,
      row.displayIdentifierKind,
      row.trackingValidation,
    ]
  })
}

// A cell that starts with a formula character is prefixed with an apostrophe, so a spreadsheet shows it as text.
function csvCell(value: string | number): string {
  const text = String(value)
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${guarded.replace(/"/g, '""')}"`
}

export function registerCsv(rows: RegisterRow[], mode: RegisterColumnMode = "extended"): string {
  const lines = [headersFor(mode).map(csvCell).join(",")]
  for (const record of registerRecords(rows, mode)) lines.push(record.map(csvCell).join(","))
  return lines.join("\n") + "\n"
}
