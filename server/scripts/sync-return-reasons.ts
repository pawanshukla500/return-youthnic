// Utility script to apply canonical return reason normalization and sizing extraction across existing returns in DB.
//
// Usage:
//   npm run sync:reasons

import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { getPool, applySchema } from "../db.js"
import { syncCanonicalReturnReasons, getWeeklyReasonSummary, getTopSellerFaultSKUs, getGarmentSizeDigest } from "../return-reasons.js"
import { ALL_ACCOUNTS } from "../access.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
dotenv.config({ path: path.join(root, ".env") })

async function main() {
  const db = getPool()
  console.log("Applying additive schema (schema-return-reasons.sql)...")
  await applySchema(db)
  console.log("Schema applied successfully!")

  console.log("Applying return reason normalization & backfilling existing expected_returns rows...")
  const res = await syncCanonicalReturnReasons(db)
  console.log(`Updated / categorized ${res.backfilledRows} rows.`)

  console.log("\nFetching summary overview...")
  const summary = await getWeeklyReasonSummary(db, ALL_ACCOUNTS)
  console.log(`Total Returns: ${summary.totalReturns}`)
  console.log(`Seller Faults (Mistakes From Our Side): ${summary.sellerFaultCount} (${summary.sellerFaultPct})`)
  console.log(`Sizing & Fit Issues: ${summary.sizeIssueCount} (${summary.sizeIssuePct})`)
  console.log(`Customer Remorse: ${summary.customerRemorseCount} (${summary.customerRemorsePct})`)
  console.log(`Logistics & RTO: ${summary.logisticsRtoCount} (${summary.logisticsRtoPct})`)

  console.log("\nTop 5 Problematic SKUs with Seller Mistakes:")
  const faults = await getTopSellerFaultSKUs(db, ALL_ACCOUNTS, undefined, undefined, 5)
  for (const f of faults) {
    console.log(`- [${f.productSku}] ${f.primaryDefect}: ${f.sellerFaultCount} faults (${f.faultRatePct}) -> ${f.recommendation}`)
  }

  console.log("\nTop 5 Garment Sizing Issue SKUs:")
  const sizing = await getGarmentSizeDigest(db, ALL_ACCOUNTS, undefined, undefined, 5)
  for (const s of sizing) {
    console.log(`- [${s.productSku}] Total Size Returns: ${s.totalSizeReturns} (Too Small: ${s.tooSmallPct}, Too Large: ${s.tooLargePct}) | Top Size: ${s.primaryProblematicSize} -> ${s.actionableRecommendation}`)
  }

  await db.end()
}

main().catch(console.error)
