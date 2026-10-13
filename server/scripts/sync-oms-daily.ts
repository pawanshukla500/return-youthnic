// Daily OMSGuru pull: invoices (dispatched shipments with AWBs) for every channel, one IST day at a time.
//
// Usage (from the project folder):
//   npm run oms:daily                                  yesterday (IST)
//   npm run oms:daily -- --date 2026-10-07             one day
//   npm run oms:daily -- --from 2026-10-01 --to 2026-10-07   a range, inclusive
//
// Every run is logged in oms_sync_runs. A throttled answer stops the run; run it again later.
// Days already pulled are pulled again and updated in place, so re-running is safe.
// Needs OMSGURU_API_TOKEN and OMSGURU_CLIENT_ID in .env. Values are never printed.

import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { istYesterday } from "../dates.js"
import { getPool } from "../db.js"
import { OmsClient, OmsError, OmsThrottled, omsConfigFromEnv } from "../oms/client.js"
import { finishRun, startRun, syncInvoicesForDay } from "../oms/invoices.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
dotenv.config({ path: path.join(root, ".env") })

function argValue(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("--from must be on or before --to, both as YYYY-MM-DD.")
  }
  for (let t = start; t <= end; t += 24 * 3600_000) days.push(new Date(t).toISOString().slice(0, 10))
  return days
}

async function main() {
  const date = argValue("--date")
  const from = argValue("--from")
  const to = argValue("--to")
  const days = date
    ? [date]
    : from && to
      ? daysBetween(from, to)
      : [istYesterday()]
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Day must look like 2026-10-07: ${day}`)
  }

  const client = new OmsClient(omsConfigFromEnv())
  const db = getPool()
  try {
    const ready = await db.query("SELECT to_regclass('public.oms_invoices') IS NOT NULL AS ready")
    if (!ready.rows[0].ready) {
      throw new Error("The app schema does not exist yet. Start the app once (npm run dev), then run this again.")
    }

    let totalStored = 0
    for (const day of days) {
      const runId = await startRun(db, "invoices", day)
      try {
        const result = await syncInvoicesForDay(db, client, day)
        await finishRun(db, runId, "done", result.pages, result.stored)
        totalStored += result.stored
        console.log(`${day}: ${result.stored} invoice row(s) stored over ${result.pages} page(s).`)
      } catch (error) {
        if (error instanceof OmsThrottled) {
          await finishRun(db, runId, "throttled", 0, 0, "throttled")
          console.log(`${day}: OMSGuru answered 'throttled'. Stopped. Run again later for this day and the rest.`)
          break
        }
        const message = error instanceof OmsError || error instanceof Error ? error.message : String(error)
        await finishRun(db, runId, "error", 0, 0, message)
        console.log(`${day}: error: ${message}`)
      }
    }
    console.log(`Done. ${totalStored} invoice row(s) stored in this run.`)
  } finally {
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
