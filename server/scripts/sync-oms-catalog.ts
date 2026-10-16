// Daily OMSGuru pull: channel listings and the master SKU list. Orders and invoices are not part of this job.
//
// Usage (from the project folder):
//   npm run sync:oms -- --list          list the OMSGuru channels only (no database writes)
//   npm run sync:oms                    every active channel, then the master SKU list (the daily run)
//   npm run sync:oms -- --channel 12    one channel company id, then the master SKU list
//   npm run sync:oms -- --skip-skus     listings only
//   npm run sync:oms -- --skip-master-bridge   listings + SKUs, without the product-master bridge
//
// Writes:
//   oms_listings   every listing record, with the OMSGuru master SKU it is mapped to (oms_sku_id)
//   oms_skus       every master SKU record (the SKU record has no image field)
//   sku_catalog    one title and image per listing SKU, read by the upload preview
//   product_master new (marketplace, listing_sku) mappings from mapped listings, plus image fills
//                  for blank product_master images; matching unmapped_listing_skus flip to mapped.
//                  Skipped with --skip-master-bridge. Recorded in oms_sync_runs as kind='master-bridge'.
// Each step is recorded in oms_sync_runs. The OMSGuru limit is 60 requests per 5 minutes. The client waits when
// credits run low, so a full run takes longer. It does not fail.
//
// Needs OMSGURU_API_TOKEN and OMSGURU_CLIENT_ID in .env. Values are never printed.
// Start the app once before the first run so the schema exists.

import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import type pg from "pg"
import { getPool } from "../db.js"
import { syncChannelListings, type ListingSyncTotals } from "../oms/catalog.js"
import { OmsClient, omsConfigFromEnv, type OmsRow } from "../oms/client.js"
import { bridgeMasterMappings } from "../oms/master-bridge.js"
import { syncSkuMaster } from "../oms/skus.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
dotenv.config({ path: path.join(root, ".env") })

function argValue(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function channelId(row: OmsRow) {
  return Number(row.id)
}

function channelName(row: OmsRow) {
  return String(row.name || row.channel_name || `Channel ${row.id}`)
}

function isActive(row: OmsRow) {
  return ["active", "a"].includes(String(row.status ?? "active").toLowerCase())
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function openRun(db: pg.Pool, kind: string): Promise<number> {
  const result = await db.query<{ id: number }>("INSERT INTO oms_sync_runs (kind) VALUES ($1) RETURNING id", [kind])
  return result.rows[0].id
}

async function closeRun(
  db: pg.Pool,
  id: number,
  ok: boolean,
  counts: { pages: number; rows: number; newRows: number },
  error: string,
) {
  await db.query(
    `UPDATE oms_sync_runs
        SET finished_at = now(), status = $2, pages = $3, rows_stored = $4, new_rows = $5, error = $6
      WHERE id = $1`,
    [id, ok ? "ok" : "error", counts.pages, counts.rows, counts.newRows, error.slice(0, 300)],
  )
}

async function main() {
  const client = new OmsClient(omsConfigFromEnv())
  const channels = await client.listChannels()
  console.log(`OMSGuru returned ${channels.length} channel(s):`)
  for (const row of channels) {
    console.log(`  ${channelId(row)}  ${channelName(row)}  status=${String(row.status ?? "active")}`)
  }
  if (process.argv.includes("--list")) return

  const only = argValue("--channel")
  const targets = only
    ? channels.filter((row) => String(channelId(row)) === only)
    : channels.filter(isActive)
  if (!targets.length) {
    throw new Error(only ? `No channel with id ${only} was returned by OMSGuru.` : "No active channels to sync.")
  }
  const skipSkus = process.argv.includes("--skip-skus")

  const db = getPool()
  let failed = 0
  try {
    const ready = await db.query<{ ready: boolean }>(
      `SELECT to_regclass('public.oms_listings') IS NOT NULL
          AND to_regclass('public.oms_skus') IS NOT NULL
          AND to_regclass('public.sku_catalog') IS NOT NULL AS ready`,
    )
    if (!ready.rows[0].ready) {
      throw new Error("The app schema does not exist yet. Start the app once (npm run dev), then run this again.")
    }

    // Listings, one channel at a time. A failed channel is reported and the others still run.
    const listingRun = await openRun(db, "listings")
    const listingTotals: ListingSyncTotals = { pages: 0, listings: 0, mapped: 0, newListings: 0, newMapped: 0 }
    let listingError = ""
    for (const row of targets) {
      const id = channelId(row)
      const name = channelName(row)
      try {
        const totals = await syncChannelListings(db, client, id, (page) => {
          process.stdout.write(`\r  channel ${id}: ${page.listings} listing rows, ${page.pages} page(s)`)
        })
        process.stdout.write("\n")
        console.log(
          `channel ${id} ${name}: ${totals.listings} listings, ${totals.mapped} mapped to a master SKU, ` +
            `${totals.newListings} new (${totals.newMapped} new and mapped)`,
        )
        listingTotals.pages += totals.pages
        listingTotals.listings += totals.listings
        listingTotals.mapped += totals.mapped
        listingTotals.newListings += totals.newListings
        listingTotals.newMapped += totals.newMapped
      } catch (error) {
        process.stdout.write("\n")
        failed++
        listingError = errorText(error)
        console.error(`channel ${id} ${name}: failed, ${listingError}`)
      }
    }
    await closeRun(
      db,
      listingRun,
      failed === 0,
      { pages: listingTotals.pages, rows: listingTotals.listings, newRows: listingTotals.newListings },
      listingError,
    )

    // Master SKUs, for the whole client. Skipped with --skip-skus.
    if (!skipSkus) {
      const skuRun = await openRun(db, "skus")
      try {
        const totals = await syncSkuMaster(db, client, (page) => {
          process.stdout.write(`\r  master SKUs: ${page.skus} rows, ${page.pages} page(s)`)
        })
        process.stdout.write("\n")
        console.log(`master SKUs: ${totals.skus} stored, ${totals.newSkus} new`)
        await closeRun(db, skuRun, true, { pages: totals.pages, rows: totals.skus, newRows: totals.newSkus }, "")
      } catch (error) {
        process.stdout.write("\n")
        failed++
        const message = errorText(error)
        console.error(`master SKUs: failed, ${message}`)
        await closeRun(db, skuRun, false, { pages: 0, rows: 0, newRows: 0 }, message)
      }
    }

    // Master bridge: mapped listings become product_master rows, blank master images are
    // filled from listing images, and matching unmapped SKUs flip to mapped. On by default;
    // --skip-master-bridge opts out. A failed bridge is reported and never throws past this step.
    if (!process.argv.includes("--skip-master-bridge")) {
      const bridgeRun = await openRun(db, "master-bridge")
      try {
        const bridgeChannels = targets.map((row) => ({
          id: channelId(row),
          name: String(row.name ?? ""),
          channel_name: String(row.channel_name ?? ""),
        }))
        const bridge = await bridgeMasterMappings(db, bridgeChannels)
        for (const skipped of bridge.skippedChannels) {
          console.log(`master bridge: skipped channel ${skipped.id} ${skipped.label} (no account mapping)`)
        }
        console.log(
          `master bridge: ${bridge.inserted} new mapping(s), ${bridge.imageFilled} blank image(s) filled`,
        )
        await closeRun(
          db,
          bridgeRun,
          true,
          { pages: 0, rows: bridge.inserted + bridge.imageFilled, newRows: bridge.inserted },
          "",
        )
      } catch (error) {
        failed++
        const message = errorText(error)
        console.error(`master bridge: failed, ${message}`)
        await closeRun(db, bridgeRun, false, { pages: 0, rows: 0, newRows: 0 }, message)
      }
    }

    const counts = await db.query<{ listings: number; mapped: number; catalog: number; skus: number }>(
      `SELECT
         (SELECT count(*)::int FROM oms_listings) AS listings,
         (SELECT count(*)::int FROM oms_listings WHERE oms_sku_id IS NOT NULL) AS mapped,
         (SELECT count(*)::int FROM sku_catalog) AS catalog,
         (SELECT count(*)::int FROM oms_skus) AS skus`,
    )
    const c = counts.rows[0]
    console.log(
      `Stored now: ${c.listings} listing rows (${c.mapped} mapped), ${c.catalog} catalog SKUs, ${c.skus} master SKUs.`,
    )
    if (failed) {
      console.error(`${failed} step(s) failed. Run again to retry. Data already written is kept.`)
      process.exitCode = 1
    }
  } finally {
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(errorText(error))
  process.exit(1)
})
