import dotenv from "dotenv"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getPool, initDatabase } from "../db.js"
import { checkShopifyConnection } from "../shopify/db.js"
import { syncShopifyReturns } from "../shopify/sync.js"
import { getShopifyMetrics } from "../shopify/service.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
dotenv.config({ path: path.join(root, ".env") })

async function main() {
  console.log("=== Shopify Manual CLI Sync Trigger ===")

  const dbInit = await initDatabase()
  if (!dbInit.ok) {
    console.error("Local database failed to init:", dbInit.message)
    process.exit(1)
  }
  const pool = getPool()

  const conn = await checkShopifyConnection()
  console.log("Shopify DB Connection:", conn.message, conn.orderCount ? `(${conn.orderCount} orders)` : "")
  if (!conn.ok) {
    console.error("Error:", conn.message)
    process.exit(1)
  }

  console.log("Syncing returns & RTOs (Strictly Read-Only on Shopify)...")
  const syncResult = await syncShopifyReturns(pool)
  console.log("Result:", syncResult)

  const metrics = await getShopifyMetrics(pool)
  console.log("\nFormula Metrics:")
  console.log(`Created (${metrics.formula.created}) - Received (${metrics.formula.received}) = Pending (${metrics.formula.pending})`)
  console.log(`Breakdown:`)
  console.log(`  Customer Returns: Created ${metrics.breakdown.returns.created} - Received ${metrics.breakdown.returns.received} = Pending ${metrics.breakdown.returns.pending}`)
  console.log(`  Courier RTOs:     Created ${metrics.breakdown.rtos.created} - Received ${metrics.breakdown.rtos.received} = Pending ${metrics.breakdown.rtos.pending}`)

  await pool.end()
  process.exit(0)
}

main().catch((err) => {
  console.error("Error running sync:", err)
  process.exit(1)
})
