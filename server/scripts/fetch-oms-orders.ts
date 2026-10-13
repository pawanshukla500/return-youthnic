// Fetches OMSGuru order details for the return rows already stored in the app, and saves them to oms_order_snapshots.
//
// Usage (from the project folder):
//   npm run oms:orders -- --sample                       20 returns; prints only the FIELD NAMES of the first response
//   npm run oms:orders -- --limit 200 --marketplace Flipkart --csv
//   npm run oms:orders -- --refresh                      fetch again even when a snapshot already exists
//   options: --delay 1500   milliseconds between calls (default 1500)
//
// For each return the order line id is tried as sub_order_id first, then the order number as order_id.
// The first lookup that returns an order is kept. A throttled answer stops the run; run the command again later.
// Needs OMSGURU_API_TOKEN and OMSGURU_CLIENT_ID in .env. Values are never printed.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { getPool } from "../db.js"
import { OmsClient, OmsThrottled, omsConfigFromEnv, type OmsRow } from "../oms/client.js"
import {
  hasSnapshot,
  recordLookupOutcome,
  storeOrderRows,
  usableLookupKey,
  type OrderLookup,
} from "../oms/orders.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
dotenv.config({ path: path.join(root, ".env") })

type ReturnRow = {
  tracking_id: string
  marketplace: string
  order_number: string
  order_line_id: string | null
}

type Outcome = {
  tracking: string
  marketplace: string
  lookupType: string
  lookupKey: string
  result: string
}

function argValue(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Order line first (unique, full digits), then the order number. Damaged values are skipped.
function candidateLookups(row: ReturnRow): OrderLookup[] {
  const lookups: OrderLookup[] = []
  const line = usableLookupKey((row.order_line_id || "").split(",")[0])
  if (line) lookups.push({ type: "sub_order_id", key: line })
  const order = usableLookupKey(row.order_number || "")
  if (order) lookups.push({ type: "order_id", key: order })
  return lookups
}

// Prints field NAMES only, so the real schema can be checked without showing any values.
function printFieldNames(rows: OmsRow[]) {
  const first = rows[0]
  const rawItems: unknown = first.order_items
  const items: unknown[] = Array.isArray(rawItems)
    ? rawItems
    : rawItems && typeof rawItems === "object"
      ? Object.values(rawItems)
      : []
  const itemKeys = new Set<string>()
  for (const item of items) {
    if (item && typeof item === "object") {
      for (const key of Object.keys(item)) itemKeys.add(key)
    }
  }
  console.log("First OMSGuru order response. Field names only (values are not printed):")
  console.log(`  top level: ${Object.keys(first).sort().join(", ") || "(none)"}`)
  console.log(`  order_items[]: ${[...itemKeys].sort().join(", ") || "(none)"}`)
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

async function main() {
  const limit = Number(argValue("--limit") ?? "20")
  const delayMs = Number(argValue("--delay") ?? "1500")
  const marketplace = argValue("--marketplace") || null
  const refresh = process.argv.includes("--refresh")
  const wantSample = process.argv.includes("--sample")
  const wantCsv = process.argv.includes("--csv")
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a whole number above 0.")
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay must be a number of milliseconds.")

  const client = new OmsClient(omsConfigFromEnv())
  const db = getPool()
  try {
    const ready = await db.query("SELECT to_regclass('public.oms_order_snapshots') IS NOT NULL AS ready")
    if (!ready.rows[0].ready) {
      throw new Error("The app schema does not exist yet. Start the app once (npm run dev), then run this again.")
    }

    const selected = await db.query<ReturnRow>(
      `SELECT er.tracking_id, m.name AS marketplace, er.order_number, li.order_line_id
       FROM expected_returns er
       JOIN marketplaces m ON m.id = er.marketplace_id
       LEFT JOIN LATERAL (
         SELECT eri.order_line_id
         FROM expected_return_items eri
         WHERE eri.expected_return_id = er.id AND eri.order_line_id IS NOT NULL
         ORDER BY eri.sort_order, eri.id
         LIMIT 1
       ) li ON true
       WHERE ($1::text IS NULL OR m.name = $1)
       ORDER BY er.id DESC
       LIMIT $2`,
      [marketplace, limit],
    )
    console.log(`${selected.rows.length} return row(s) selected${marketplace ? ` for ${marketplace}` : ""}.`)

    const outcomes: Outcome[] = []
    let sampleShown = false
    let stopped = false

    for (const row of selected.rows) {
      if (stopped) break
      const lookups = candidateLookups(row)
      if (!lookups.length) {
        outcomes.push({
          tracking: row.tracking_id,
          marketplace: row.marketplace,
          lookupType: "",
          lookupKey: "",
          result: "no usable order id",
        })
        continue
      }

      let outcome: Outcome | null = null
      for (const lookup of lookups) {
        const base = { tracking: row.tracking_id, marketplace: row.marketplace, lookupType: lookup.type, lookupKey: lookup.key }
        if (!refresh && (await hasSnapshot(db, lookup))) {
          outcome = { ...base, result: "already stored" }
          break
        }

        let rows: OmsRow[]
        try {
          rows = await client.orderDetails(
            lookup.type === "sub_order_id" ? { subOrderId: lookup.key } : { orderId: lookup.key },
          )
        } catch (error) {
          if (error instanceof OmsThrottled) {
            stopped = true
            break
          }
          const message = error instanceof Error ? error.message : String(error)
          await recordLookupOutcome(db, lookup, row.marketplace, `ERROR: ${message}`)
          outcome = { ...base, result: `error: ${message}` }
          await sleep(delayMs)
          continue
        }
        await sleep(delayMs)

        if (!rows.length) {
          await recordLookupOutcome(db, lookup, row.marketplace, "NOT_FOUND")
          outcome = { ...base, result: "not found" }
          continue
        }
        const stored = await storeOrderRows(db, lookup, row.marketplace, rows)
        outcome = { ...base, result: `found, ${stored} order row(s) stored` }
        if (wantSample && !sampleShown) {
          printFieldNames(rows)
          sampleShown = true
        }
        break
      }
      if (outcome) outcomes.push(outcome)
    }

    if (stopped) {
      console.log("OMSGuru answered 'throttled'. Stopped early. Run the command again later to continue.")
    }
    const found = outcomes.filter((o) => o.result.startsWith("found")).length
    const stored = outcomes.filter((o) => o.result === "already stored").length
    const missing = outcomes.filter((o) => o.result === "not found").length
    const failed = outcomes.filter((o) => o.result.startsWith("error")).length
    console.log(`Summary: ${found} found, ${stored} already stored, ${missing} not found, ${failed} errors.`)
    if (outcomes.length) console.table(outcomes)

    if (wantCsv && outcomes.length) {
      const keys = [...new Set(outcomes.filter((o) => o.lookupKey).map((o) => o.lookupKey))]
      const snapshots = await db.query(
        `SELECT lookup_type, lookup_key, marketplace, channel_order_id, sub_order_ids, item_statuses,
                shipment_tracker, invoice_id, invoice_date, warehouse, channel_label, skus, last_error, fetched_at
         FROM oms_order_snapshots
         WHERE lookup_key = ANY($1::text[])
         ORDER BY lookup_key, id`,
        [keys],
      )
      const trackingByKey = new Map<string, string>()
      for (const o of outcomes) if (o.lookupKey) trackingByKey.set(o.lookupKey, o.tracking)
      const header = [
        "tracking_id", "marketplace", "lookup_type", "lookup_key", "channel_order_id", "sub_order_ids",
        "item_statuses", "shipment_tracker", "invoice_id", "invoice_date", "warehouse", "channel_label",
        "skus", "last_error", "fetched_at",
      ]
      const lines = [header.join(",")]
      for (const r of snapshots.rows) {
        lines.push(
          [
            trackingByKey.get(r.lookup_key) ?? "", r.marketplace, r.lookup_type, r.lookup_key, r.channel_order_id,
            r.sub_order_ids, r.item_statuses, r.shipment_tracker, r.invoice_id, r.invoice_date, r.warehouse,
            r.channel_label, r.skus, r.last_error, r.fetched_at,
          ]
            .map(csvCell)
            .join(","),
        )
      }
      const dir = path.join(root, "exports")
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `oms-orders-${new Date().toISOString().slice(0, 10)}.csv`)
      fs.writeFileSync(file, lines.join("\n") + "\n")
      console.log(`CSV written: ${file} (${snapshots.rows.length} row(s))`)
    }
  } finally {
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
