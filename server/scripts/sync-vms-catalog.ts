// VMS catalogue sync into product_master (VB EXPORT product master).
//
// The VMS database is STRICTLY READ-ONLY: every query runs through
// queryVmsReadOnly (allowlist + BEGIN READ ONLY). This script can only
// read VMS data and write to the local return-scan database. It never edits
// or deletes anything in VMS.
//
// Usage (from the project folder):
//   npm run sync:vms-catalog -- --help       this help (connects to nothing)
//   npm run sync:vms-catalog -- --fetch-ca   pin the VMS server certificate (once; stored git-ignored)
//   npm run sync:vms-catalog -- --probe      inspect the VMS schema (tables, columns, estimates)
//   npm run sync:vms-catalog -- --dry-run    read the catalogue, report what would be stored (default)
//   npm run sync:vms-catalog -- --apply      fill blank product_master image links (merge, never replace)
// Schedule --apply daily (e.g. Windows Task Scheduler) for the daily catalogue sync.

import dotenv from "dotenv"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkVmsConnection, closeVmsPool, fetchVmsCa } from "../vms/db.js"
import { probeVmsCatalogue, sampleVmsCatalogue } from "../vms/catalog.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
dotenv.config({ path: path.join(root, ".env") })

function printHelp(): void {
  console.log(`VMS Catalogue Sync (VMS is strictly READ-ONLY).
Reads channel listing SKUs, master SKU mappings, categories and catalog images from
the VMS tables (omsguru_listings, sku_images, sku_photos) and syncs into product_master.
Merge-only: adds missing mappings and fills blank image links. Existing mappings and images are preserved.

  --help       this help (connects to nothing)
  --fetch-ca   pin the VMS server certificate once (stored git-ignored)
  --probe      inspect the VMS schema + masked catalogue sample (VMS read-only)
  --dry-run    report what would be filled and mapped (default; writes nothing anywhere)
  --apply      create mappings and fill blank image links + write one vms_catalog_sync_runs row`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    return
  }
  console.log("=== VMS Catalogue Sync (VMS is strictly READ-ONLY) ===")

  if (args.includes("--fetch-ca")) {
    const pinned = await fetchVmsCa()
    console.log(pinned.message)
    if (pinned.fingerprint) console.log("SHA-256:", pinned.fingerprint)
    if (!pinned.ok) process.exit(1)
    const pinnedConn = await checkVmsConnection()
    console.log("VMS database:", pinnedConn.message)
    process.exit(pinnedConn.ok ? 0 : 1)
  }

  const conn = await checkVmsConnection()
  console.log("VMS database:", conn.message)
  if (!conn.ok) {
    console.error("Cannot reach the VMS database. Set VMS_DATABASE_URL and try again.")
    console.error("For a self-signed server certificate, pin it first: npm run sync:vms-catalog -- --fetch-ca")
    process.exit(1)
  }

  if (args.includes("--probe")) {
    const probe = await probeVmsCatalogue()
    if (!probe.ok) {
      console.error("Probe failed:", probe.error)
      process.exit(1)
    }
    console.log(`Found ${probe.tables.length} table(s):`)
    for (const table of probe.tables) {
      console.log(`- ${table.schema}.${table.table} (~${table.estimatedRows} rows)`)
      for (const col of table.columns) {
        console.log(`    ${col.name} (${col.type})`)
      }
    }
    const sample = await sampleVmsCatalogue()
    if (sample.listingsSample?.length) {
      console.log(`\nFound Catalogue Listings Master (omsguru_listings):`)
      for (const entry of sample.listingsSample) {
        console.log(`  listing='${entry.listingSku}' master='${entry.masterSku}' category='${entry.category}' host='${entry.imageHost}' scope='${entry.marketplace}'`)
      }
    }
    console.log(`\nCatalogue candidate: ${sample.table}: ${sample.rows} rows, ${sample.withImage} with image, ${sample.blankSku} blank SKU.`)
    if (sample.marketplaces.length) {
      console.log("By marketplace scope:")
      for (const scope of sample.marketplaces) {
        console.log(`  '${scope.marketplace || "(blank)"}': ${scope.rows} rows`)
      }
    }
    console.log("Sample image rows (image shown as host only):")
    for (const entry of sample.sample) {
      console.log(`  sku='${entry.sku}' title='${entry.title}' host='${entry.imageHost}' scope='${entry.marketplace}'`)
    }
    return
  }

  const { getPool } = await import("../db.js")
  const { dryRunVmsCatalogue, ensureVmsCatalogSchema } = await import("../vms/catalog.js")
  const pool = getPool()
  try {
    await ensureVmsCatalogSchema(pool)
    const report = await dryRunVmsCatalogue(pool)
    console.log(`VMS catalogue total entries: ${report.vmsRows}.`)
    console.log(`VMS omsguru_listings mappings: ${report.vmsMappings} (${report.mappingsToInsert} new mappings to create locally).`)
    console.log(`VMS image catalogue: ${report.vmsUsable} distinct SKUs with images.`)
    console.log(`Local product master: ${report.masterRows} rows, ${report.masterImageless} without an image.`)
    console.log(`Matched listings: ${report.matchedListings} distinct keys (of which ${report.blankImagesFilled} blank images would be filled, ${report.alreadyHaveImage} already have one).`)
    if (!args.includes("--apply")) {
      console.log("Dry run only — nothing was written. Add --apply to create new mappings and fill blank image links.")
      return
    }

    const { applyVmsCatalogue } = await import("../vms/catalog.js")
    const applied = await applyVmsCatalogue(pool)
    console.log(`Created ${applied.mappingsCreated} new product master mapping(s) from VMS omsguru_listings.`)
    console.log(`Filled ${applied.imagesFilled} blank image link(s) across matched listings (run ${applied.runId}).`)
  } finally {
    await pool.end().catch(() => {})
    await closeVmsPool()
  }
}

main().catch((err) => {
  console.error("Error running VMS catalogue sync:", err instanceof Error ? err.message : err)
  process.exit(1)
})
