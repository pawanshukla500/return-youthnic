// Read-only diagnostic: parse a real marketplace file through the running build's parser and print the
// same counts a fresh upload preview would show. Nothing is stored. Nothing is activated. The script
// does not touch the database. It is invoked manually by an agent who already has the file path.
//
// Usage: npx tsx server/scripts/diagnose-file.ts "<file>" "<marketplace>"
// Example: npx tsx server/scripts/diagnose-file.ts "C:\Users\Pawan Shukla\Desktop\Ajio return .xlsx" "Ajio"
//
// The script prints: source rows, scannable, pending, error, duplicate, cancelled, exact duplicate,
// repeated, unverified tracking, blank tracking, zero quantity, untrusted identifiers, tracking
// corrected, tracking kept, tracking unchecked, and warnings (with samples).

import fs from "node:fs"
import path from "node:path"
import { countPreview } from "../upload-policy.js"
import { inspectLayout, parseSpreadsheet } from "../sheets.js"

function usage(): never {
  console.error("Usage: tsx server/scripts/diagnose-file.ts \"<file>\" \"<marketplace>\"")
  process.exit(2)
}

const args = process.argv.slice(2)
if (args.length < 2) usage()
const [filePath, marketplace] = args

const resolved = path.resolve(filePath)
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`)
  process.exit(2)
}
const buffer = fs.readFileSync(resolved)
const filename = path.basename(resolved)

console.log(`File:       ${filename}`)
console.log(`Marketplace:${marketplace}`)
console.log(`Size:       ${buffer.length} bytes`)

const layout = inspectLayout(buffer, filename, marketplace)
console.log(`\nLayout profile: ${layout.profileId}`)
console.log(`Headers found:  ${layout.headers.filter((h) => h !== "").length}`)
if (layout.missingRequired.length) {
  console.log(`Missing required headers: ${layout.missingRequired.join(", ")}`)
} else {
  console.log("Missing required headers: (none)")
}

const parsed = parseSpreadsheet(buffer, marketplace, filename)
if (parsed.fatal) {
  console.log(`\nFATAL: ${parsed.fatal}`)
  process.exit(1)
}

const counts = countPreview(parsed.rows)
console.log(`\nRow counts (total / valid / scannable / pending / error / duplicate / cancelled):`)
console.log(`  rows:           ${counts.rows}`)
console.log(`  validRows:      ${counts.validRows}`)
console.log(`  scannableRows:  ${counts.scannableRows}`)
console.log(`  pendingRows:    ${counts.pendingRows}`)
console.log(`  errorRows:      ${counts.errorRows}`)
console.log(`  duplicateRows:  ${counts.duplicateRows}`)
console.log(`  cancelledRows:  ${counts.cancelledRows}`)
console.log(`\nDetail:`)
console.log(`  exactDuplicateRows: ${counts.exactDuplicateRows}`)
console.log(`  repeatedRows:       ${counts.repeatedRows}`)
console.log(`  unverifiedTracking: ${counts.unverifiedTrackingRows}`)
console.log(`  blankTracking:      ${counts.blankTrackingRows}`)
console.log(`  zeroQuantity:       ${counts.zeroQuantityRows}`)
console.log(`  untrustedIds:       ${counts.untrustedIdentifierRows}`)
console.log(`  trackingCorrected:  ${counts.trackingCorrectedRows}`)
console.log(`  trackingKept:       ${counts.trackingKeptRows}`)
console.log(`  trackingUnchecked:  ${counts.trackingUncheckedRows}`)
console.log(`  warningRows:        ${counts.warningRows}`)

if (parsed.rows.some((row) => row.valid && row.cancelled)) {
  const cancelled = parsed.rows.filter((row) => row.valid && row.cancelled).slice(0, 5)
  console.log(`\nCancelled (sample, up to 5):`)
  for (const row of cancelled) console.log(`  line ${row.sourceLineNo ?? "?"}: ${row.trackingId || "(blank)"} / ${row.orderId}`)
}

if (parsed.rows.some((row) => row.warnings.length > 0)) {
  const seen = new Set<string>()
  console.log(`\nWarnings (unique, up to 10):`)
  for (const row of parsed.rows) {
    for (const warning of row.warnings) {
      if (!seen.has(warning)) {
        seen.add(warning)
        console.log(`  ${warning}`)
        if (seen.size >= 10) break
      }
    }
    if (seen.size >= 10) break
  }
}

console.log(`\nNo data was stored. No upload was activated.`)