// Standalone CLI script to synchronize sales and order payment amounts from PAYMENT_DATABASE_URL.
//
// Usage:
//   npm run sync:payment
//   npm run sync:payment -- --force    (checks all scanned return items, including those already synced)
//
// Complies with AGENTS.md Invariants 1, 3, 6, 8 (No secrets printed, strictly additive).

import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { getPool } from "../db.js"
import { syncPaymentAmounts } from "../payment/sync.js"
import { paymentDatabaseUrl } from "../payment/db.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
dotenv.config({ path: path.join(root, ".env") })

async function main() {
  const force = process.argv.includes("--force")

  console.log("=== Youthnic Return Management · Payment Amount Synchronization ===")

  if (!paymentDatabaseUrl()) {
    console.error("❌ PAYMENT_DATABASE_URL is not set in environment or .env file.")
    console.error("Please add PAYMENT_DATABASE_URL=postgresql://... to your .env file.")
    process.exit(1)
  }

  const db = getPool()
  try {
    console.log(`Starting payment sync (mode: ${force ? "FORCE ALL" : "UNSYNCED ITEMS ONLY"})...`)
    const result = await syncPaymentAmounts(db, { forceAll: force, trigger: "script" })

    if (result.status === "success") {
      console.log(`✅ Success: ${result.details}`)
      console.log(`Items Checked: ${result.checked}`)
      console.log(`Items Matched: ${result.matched}`)
      console.log(`Items Updated: ${result.updated}`)
      console.log(`Total Sales Amount: ₹${result.totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
      process.exit(0)
    } else {
      console.error(`⚠️ Sync completed with status '${result.status}': ${result.details}`)
      process.exit(result.status === "locked" ? 0 : 1)
    }
  } catch (err: unknown) {
    console.error("❌ Fatal error during payment sync:", err instanceof Error ? err.message : err)
    process.exit(1)
  } finally {
    await db.end()
  }
}

main()
