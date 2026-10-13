import fs from "node:fs"
import path from "node:path"
import { parseSpreadsheet } from "../sheets.js"
import { profileForMarketplace } from "../import-profiles.js"
import { countPreview, activationBlockers, confirmationsNeeded } from "../upload-policy.js"

const filesDir = "C:/Users/Pawan Shukla/Desktop/Return File Formate"

const marketplaceFiles = [
  { file: "Myntra EJ.csv", account: "Myntra EJ" },
  { file: "Myntra VB.csv", account: "Myntra VB" },
  { file: "Ajio Return.xlsx", account: "Ajio" },
  { file: "Amazon Return.csv", account: "Amazon" },
  { file: "Flipkart Return.csv", account: "Flipkart" },
  { file: "Meesho Return.csv", account: "Meesho" },
]

for (const { file, account } of marketplaceFiles) {
  const fullPath = path.join(filesDir, file)
  if (!fs.existsSync(fullPath)) {
    console.log(`[NOT FOUND] ${file}`)
    continue
  }
  const buffer = fs.readFileSync(fullPath)
  console.log(`\n======================================================`)
  console.log(`AUDITING: ${file} for account [${account}] (${buffer.length} bytes)`)
  console.log(`======================================================`)

  const parsed = parseSpreadsheet(buffer, account, file)
  console.log(`Profile: ${parsed.profileId}`)
  console.log(`Fatal error: ${parsed.fatal || "None"}`)
  console.log(`Total rows parsed: ${parsed.rows.length}`)
  console.log(`Warning count: ${parsed.warningCount}`)

  if (parsed.rows.length > 0) {
    const counts = countPreview(parsed.rows)
    console.log(`Counts:`, counts)
    const blockers = activationBlockers({ fatal: parsed.fatal, accountAllowed: true, counts })
    console.log(`Blockers:`, blockers)
    const confirms = confirmationsNeeded(counts)
    console.log(`Confirmations needed:`, confirms)

    // Inspect sample of warnings / pending / errors
    const sampleInvalid = parsed.rows.filter((r) => !r.valid).slice(0, 3)
    if (sampleInvalid.length > 0) {
      console.log(`Sample invalid rows:`, sampleInvalid.map((r) => ({ line: r.sourceLineNo, error: r.error })))
    }
    const samplePending = parsed.rows.filter((r) => (r.pendingReasons || []).length > 0).slice(0, 3)
    if (samplePending.length > 0) {
      console.log(`Sample pending rows:`, samplePending.map((r) => ({ line: r.sourceLineNo, pending: r.pendingReasons })))
    }
    const sampleWarnings = parsed.rows.filter((r) => (r.warnings || []).length > 0).slice(0, 3)
    if (sampleWarnings.length > 0) {
      console.log(`Sample warnings:`, sampleWarnings.map((r) => ({ line: r.sourceLineNo, warnings: r.warnings })))
    }
  }
}
