// Loads the VB EXPORT product master (channel listing SKU to product SKU, with category and image link) into product_master.
//
// Usage (from the project folder):
//   npx tsx server/scripts/load-product-master.ts "C:\Users\Pawan Shukla\Desktop\Product SKU Codes.xlsx"
//   npx tsx server/scripts/load-product-master.ts "C:\Users\Pawan Shukla\Desktop\Product SKU Codes.xlsx" --marketplace "Myntra VB"
//
// Two layouts are accepted, matched by header name: "Channel Listing SKU Code" + "Product SkuCode" (the Product SKU
// Codes export), or "Marketplace SKU" + "VB EXPORT SKU's" (the older product category workbook).
// --marketplace names the account the rows are stored for. Without it the file's own Marketplace column is used, and
// without that the rows apply to every account ("all"). The product SKU lookup uses the account's rows first and falls
// back to the all-marketplaces rows.
// Each run replaces the whole product_master table, so the newest catalog file is the only source.
// The same load is available to an administrator from the Admin "Product SKU master" tab.
// Start the app once before the first run so the schema exists.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { getPool } from "../db.js"
import { inheritBlankMasterImages, inheritedImageCount, loadStoredMasterImages, pasteBlankMasterImages } from "../product-master.js"
import { parseProductMaster } from "../sheets.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
dotenv.config({ path: path.join(root, ".env") })

// The path is the first argument that is not a flag, so "--marketplace X file.xlsx" and "file.xlsx --marketplace X"
// both work.
function readArgs(argv: string[]): { filePath: string; marketplace: string } {
  let filePath = ""
  let marketplace = ""
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--marketplace") {
      marketplace = argv[index + 1] ?? ""
      index++
      continue
    }
    if (!arg.startsWith("--") && !filePath) filePath = arg
  }
  return { filePath, marketplace }
}

async function main() {
  const { filePath, marketplace } = readArgs(process.argv.slice(2))
  if (!filePath) {
    throw new Error(
      'Usage: npx tsx server/scripts/load-product-master.ts "<path to Product SKU Codes.xlsx>" [--marketplace "<account name>"]',
    )
  }

  const parsed = parseProductMaster(fs.readFileSync(filePath), path.basename(filePath), marketplace)
  if (parsed.fatal) throw new Error(parsed.fatal)
  if (!parsed.rows.length) throw new Error("No row has both a listing SKU and a product SKU. Nothing was loaded.")

  const db = getPool()
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const schema = await client.query("SELECT to_regclass('public.expected_returns') IS NOT NULL AS ready")
    if (!schema.rows[0].ready) {
      throw new Error("The app schema does not exist yet. Start the app once (npm run dev), then run this again.")
    }
    await client.query(fs.readFileSync(path.join(root, "server", "schema-import.sql"), "utf8"))

    const donors = await loadStoredMasterImages(client, parsed.rows.map((row) => row.masterSku))
    const loaded = inheritBlankMasterImages(parsed.rows, donors)
    const imagesFilled = inheritedImageCount(parsed.rows, loaded)
    const removed = await client.query("DELETE FROM product_master")
    const CHUNK = 1000
    for (let start = 0; start < loaded.length; start += CHUNK) {
      const chunk = loaded.slice(start, start + CHUNK)
      const values: unknown[] = []
      const groups = chunk.map((row) => {
        const base = values.length
        values.push(row.marketplace, row.listingSku, row.masterSku, row.category || null, row.cogs, row.weightSlab, row.imageUrl)
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
      })
      await client.query(
        `INSERT INTO product_master (marketplace, listing_sku, master_sku, category, cogs, weight_slab, image_url) VALUES ${groups.join(", ")}`,
        values,
      )
    }
    const pasted = imagesFilled + await pasteBlankMasterImages(client, loaded.map((row) => row.masterSku))
    await client.query("COMMIT")
    const withImage = loaded.filter((row) => row.imageUrl).length
    const scopes = new Map<string, number>()
    for (const row of parsed.rows) scopes.set(row.marketplace, (scopes.get(row.marketplace) ?? 0) + 1)
    console.log(
      `Loaded ${parsed.rows.length} listings (${withImage} with an image link, ${pasted} blank cells filled from the same product SKU). Replaced ${removed.rowCount ?? 0} earlier rows. Skipped ${parsed.skipped} rows without both SKUs.`,
    )
    console.log(
      `Stored for: ${[...scopes].map(([scope, count]) => `${scope === "all" ? "all marketplaces" : scope} (${count})`).join(", ")}`,
    )
    if (parsed.conflictCount > 0) {
      console.log(
        `${parsed.conflictCount} listing SKU(s) have more than one product SKU in the file. The last row for each was kept. Check these:`,
      )
      for (const conflict of parsed.conflicts.slice(0, 20)) {
        console.log(`  ${conflict.listingSku}: ${conflict.masterSkus.join(" / ")}`)
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
