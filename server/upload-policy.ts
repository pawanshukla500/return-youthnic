// Activation rules for an uploaded return file. Pure: nothing here touches the database, so each rule is tested directly.
//
// A file becomes the account's active lookup data only when nothing blocks it (activationBlockers returns no reason),
// and the person has confirmed anything the file needs confirmed (confirmationsNeeded). Row errors and pending rows
// remain in upload history and are excluded from active lookup data; they do not discard the safe rows in the file.

import { isScannableRow, rowStatus, type ParsedRow } from "./sheets.js"
import { NO_ACCESS_MESSAGE } from "./access.js"

export type PreviewCounts = {
  rows: number
  // Structurally readable rows, including pending rows that are not safe lookup rows yet.
  validRows: number
  // Rows with a positive, trustworthy return AWB and quantity that can become active lookup data.
  scannableRows: number
  // Structurally readable but not currently scannable: missing/untrusted AWB, zero quantity, or another pending reason.
  pendingRows: number
  duplicateRows: number
  unverifiedTrackingRows: number
  blankTrackingRows: number
  zeroQuantityRows: number
  errorRows: number
  cancelledRows: number
  // Exact duplicates of an earlier row. Kept in upload_rows and not counted.
  exactDuplicateRows: number
  // Same AWB, SKU and line with different details, or a second return event. Kept as separate lines.
  repeatedRows: number
  // Identifiers that Excel stored as numbers with more than 15 digits, or as text in scientific notation. Blank, not used.
  untrustedIdentifierRows: number
  // A Meesho AWB that the tracking link corrected (the 15-digit rounding).
  trackingCorrectedRows: number
  // A Meesho AWB that differs from its tracking link and was kept as the file wrote it.
  trackingKeptRows: number
  // Rows whose tracking link could not be checked (no link, unreadable link, or an unverified host).
  trackingUncheckedRows: number
  warningRows: number
}

const UNTRUSTED_WARNING = /is stored as a number in the file|is in scientific notation, so its digits were lost/
const REPEAT_WARNING = /Same AWB, SKU and order line as an earlier row|Second return event/

export function countPreview(rows: ParsedRow[]): PreviewCounts {
  const counts: PreviewCounts = {
    rows: rows.length,
    validRows: 0,
    scannableRows: 0,
    pendingRows: 0,
    duplicateRows: 0,
    unverifiedTrackingRows: 0,
    blankTrackingRows: 0,
    zeroQuantityRows: 0,
    errorRows: 0,
    cancelledRows: 0,
    exactDuplicateRows: 0,
    repeatedRows: 0,
    untrustedIdentifierRows: 0,
    trackingCorrectedRows: 0,
    trackingKeptRows: 0,
    trackingUncheckedRows: 0,
    warningRows: 0,
  }
  for (const row of rows) {
    if (row.valid) counts.validRows += 1
    else counts.errorRows += 1
    if (isScannableRow(row)) counts.scannableRows += 1
    else if (rowStatus(row) === "pending") counts.pendingRows += 1
    if (rowStatus(row) === "duplicate") counts.duplicateRows += 1
    if (row.pendingReasons?.some((reason) => /scientific|stored as a number|unavailable|damaged/i.test(reason))) {
      counts.unverifiedTrackingRows += 1
    }
    if (row.pendingReasons?.some((reason) => /missing .*tracking|missing .*awb/i.test(reason))) {
      counts.blankTrackingRows += 1
    }
    if (row.pendingReasons?.some((reason) => /quantity .*zero/i.test(reason))) counts.zeroQuantityRows += 1
    if (row.valid && row.cancelled) counts.cancelledRows += 1
    if (row.duplicateKind === "exact_import_row") counts.exactDuplicateRows += 1
    if (row.warnings.some((warning) => REPEAT_WARNING.test(warning))) counts.repeatedRows += 1
    if (row.warnings.some((warning) => UNTRUSTED_WARNING.test(warning))) counts.untrustedIdentifierRows += 1
    if (row.trackingValidation === "mismatch_resolved") counts.trackingCorrectedRows += 1
    if (row.trackingValidation === "mismatch_kept") counts.trackingKeptRows += 1
    if (
      row.trackingValidation === "no_link" ||
      row.trackingValidation === "invalid_link" ||
      row.trackingValidation === "unverified_host"
    ) {
      counts.trackingUncheckedRows += 1
    }
    if (row.warnings.length > 0) counts.warningRows += 1
  }
  return counts
}

// Reasons the file cannot be activated. Row-level errors and pending rows are excluded with confirmation rather than
// blocking otherwise scannable rows.
export function activationBlockers(input: {
  fatal: string
  accountAllowed: boolean
  counts: PreviewCounts
}): string[] {
  const blockers: string[] = []
  if (!input.accountAllowed) blockers.push(NO_ACCESS_MESSAGE)
  if (input.fatal) blockers.push(`The file cannot be read: ${input.fatal}`)
  if (!input.fatal && input.counts.rows === 0) blockers.push("The file has no return rows.")
  if (!input.fatal && input.counts.rows > 0 && input.counts.scannableRows === 0) {
    blockers.push("No row has a trustworthy return AWB and a positive quantity, so there is nothing safe to activate.")
  }
  return blockers
}

// Things the person must confirm before activation. Each one is shown on the upload screen.
export function confirmationsNeeded(counts: PreviewCounts): string[] {
  const items: string[] = []
  if (counts.errorRows > 0 || counts.pendingRows > 0 || counts.cancelledRows > 0 || counts.duplicateRows > 0) {
    const excluded = counts.errorRows + counts.pendingRows + counts.cancelledRows + counts.duplicateRows
    items.push(
      `${excluded.toLocaleString("en-US")} row(s) will remain in upload history but will not become active scan lookups. Confirm the partial activation and review the row exceptions.`,
    )
  }
  if (counts.untrustedIdentifierRows > 0) {
    items.push(
      `${counts.untrustedIdentifierRows.toLocaleString("en-US")} row(s) have an identifier that Excel stored as a number. Those identifiers are shown blank, never guessed. Confirm, or re-export the file as CSV with IDs as text.`,
    )
  }
  if (counts.trackingKeptRows > 0) {
    items.push(
      `${counts.trackingKeptRows.toLocaleString("en-US")} row(s) have a tracking link that disagrees with the file's AWB. The file's AWB is used. Confirm the labels for these rows.`,
    )
  }
  return items
}

export function canActivate(input: { blockers: string[]; counts: PreviewCounts }): boolean {
  return input.blockers.length === 0 && input.counts.scannableRows > 0
}
