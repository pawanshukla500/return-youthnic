// Checks a marketplace export against its header profile, without saving anything.
//
//   npm run layout:inspect -- "<path to the file>" "<marketplace name>"
//
// Prints the detected profile, the normalized headers, any required header that is missing, and the first data row.
// Buyer fields (GSTIN, company name, comments, delivery proof links) are masked. Nothing is written to the database.

import fs from "node:fs"
import path from "node:path"
import { inspectLayout } from "../sheets.js"

const MASKED = /gstin|company_name|comment|proof|customer_name|buyer|email|phone|address/i

const [, , filePath, marketplace = "Myntra VB"] = process.argv
if (!filePath) {
  console.error('Usage: npm run layout:inspect -- "<file>" "<marketplace name>"')
  process.exit(1)
}

const resolved = path.resolve(filePath)
const buffer = fs.readFileSync(resolved)
const result = inspectLayout(buffer, path.basename(resolved), marketplace, 1)

console.log(`File: ${path.basename(resolved)}`)
console.log(`Marketplace: ${marketplace}`)
console.log(`Layout profile: ${result.profileId}`)
console.log(`Headers (${result.headers.length}): ${result.headers.join(", ")}`)
if (result.missingRequired.length) {
  console.log(`MISSING required headers: ${result.missingRequired.join(", ")}`)
} else {
  console.log("All required headers are present.")
}
const first = result.sample[0]
if (first) {
  console.log("First data row (buyer fields masked):")
  first.forEach((value, index) => {
    const header = result.headers[index] ?? `column ${index + 1}`
    const shown = MASKED.test(header) ? "[masked]" : value.length > 60 ? `${value.slice(0, 57)}...` : value
    console.log(`  ${header}: ${shown}`)
  })
} else {
  console.log("No data rows below the header.")
}
