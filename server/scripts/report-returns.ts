// Daily return report from the database only. No OMSGuru call.
//
// Usage (from the project folder):
//   npm run report:returns                       every date; latest upload per marketplace
//   npm run report:returns -- --date 2026-10-07  one IST day
//   npm run report:returns -- --csv              also write CSV files to exports\
//
// Sections:
//  1. Marketplace: the latest upload's rows, with requested / approved / picked up / completed counts
//  2. Scans: receipt scans per marketplace and IST day, from the return app's own scanning
//  3. OMSGuru invoices: dispatched shipments per channel and IST day (from npm run oms:daily)
//  4. Cross-check: uploaded AWBs that also appear in the OMSGuru invoices

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { getPool } from "../db.js"
import { summarizeLifecycle } from "../lifecycle.js"
import { profileForMarketplace } from "../import-profiles.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
dotenv.config({ path: path.join(root, ".env") })

function argValue(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function writeCsv(file: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  const lines = [headers.join(",")]
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join("\n") + "\n")
  console.log(`CSV written: ${file} (${rows.length} row(s))`)
}

async function main() {
  const date = argValue("--date") || ""
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must look like 2026-10-07.")
  const wantCsv = process.argv.includes("--csv")
  const label = date || "all-dates"
  const db = getPool()
  try {
    // 1. Marketplace: latest upload per marketplace, lifecycle counts from its stored rows.
    const latest = await db.query<{ batch_id: number; marketplace: string; uploaded_label: string }>(
      `SELECT DISTINCT ON (b.marketplace_id) b.id AS batch_id, m.name AS marketplace, b.uploaded_label
       FROM upload_batches b
       JOIN marketplaces m ON m.id = b.marketplace_id
       ORDER BY b.marketplace_id, b.created_at DESC`,
    )
    const marketplaceRows: Record<string, unknown>[] = []
    for (const batch of latest.rows) {
      const stored = await db.query<{ row_data: Record<string, string>; valid: boolean }>(
        "SELECT row_data, valid FROM upload_rows WHERE upload_batch_id = $1",
        [batch.batch_id],
      )
      const valid = stored.rows.filter((row) => row.valid).map((row) => row.row_data)
      const counts = summarizeLifecycle(valid, profileForMarketplace(batch.marketplace)?.lifecycle, date)
      marketplaceRows.push({
        marketplace: batch.marketplace,
        upload_batch: batch.batch_id,
        uploaded: batch.uploaded_label,
        rows_stored: stored.rows.length,
        valid_rows: valid.length,
        invalid_rows: stored.rows.length - valid.length,
        requested: counts.requested,
        approved: counts.approved,
        picked_up: counts.pickedUp,
        completed: counts.completed,
        status_delivered: counts.deliveredStatus,
      })
      if (!stored.rows.length) {
        console.log(`${batch.marketplace}: the latest upload (batch ${batch.batch_id}) has no stored rows. Upload the file again to store every column.`)
      }
    }
    console.log(`\n1. Marketplace returns (latest upload per marketplace${date ? `, day ${date}` : ""}):`)
    console.table(marketplaceRows)

    // 2. Scans: receipt scans per marketplace and IST day.
    const scans = await db.query(
      `SELECT m.name AS marketplace,
              to_char(rs.scanned_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
              count(*)::int AS scanned,
              count(*) FILTER (WHERE rs.outcome = 'issue')::int AS issues
       FROM receipt_scans rs
       JOIN expected_returns er ON er.id = rs.expected_return_id
       JOIN marketplaces m ON m.id = er.marketplace_id
       WHERE ($1::text IS NULL OR to_char(rs.scanned_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') = $1::text)
       GROUP BY 1, 2
       ORDER BY 2 DESC, 1`,
      [date || null],
    )
    console.log("\n2. Scans in the return app, per marketplace and day (IST):")
    console.table(scans.rows)

    // 3. OMSGuru invoices per channel and day.
    const invoices = await db.query(
      `SELECT invoice_day::text AS day,
              channel_label,
              count(*)::int AS invoices,
              count(DISTINCT shipment_tracker)::int AS awbs
       FROM oms_invoices
       WHERE ($1::date IS NULL OR invoice_day = $1::date)
       GROUP BY 1, 2
       ORDER BY 1 DESC, 2`,
      [date || null],
    )
    console.log("\n3. OMSGuru invoices per channel and day (run npm run oms:daily first):")
    console.table(invoices.rows)

    // 4. Cross-check: uploaded AWBs also present in the OMSGuru invoices.
    const crossRows: Record<string, unknown>[] = []
    for (const batch of latest.rows) {
      const check = await db.query<{ tracked: number; seen_in_oms: number }>(
        `SELECT count(DISTINCT ur.tracking_id)::int AS tracked,
                count(DISTINCT ur.tracking_id) FILTER (
                  WHERE EXISTS (SELECT 1 FROM oms_invoices oi WHERE oi.shipment_tracker = ur.tracking_id)
                )::int AS seen_in_oms
         FROM upload_rows ur
         WHERE ur.upload_batch_id = $1 AND ur.valid AND ur.tracking_id <> ''`,
        [batch.batch_id],
      )
      crossRows.push({
        marketplace: batch.marketplace,
        tracked_awbs: check.rows[0].tracked,
        seen_in_oms_invoices: check.rows[0].seen_in_oms,
      })
    }
    console.log("\n4. Uploaded AWBs also found in OMSGuru invoices (forward or return AWB, by exact match):")
    console.table(crossRows)

    if (wantCsv) {
      const dir = path.join(root, "exports")
      writeCsv(path.join(dir, `returns-marketplace-${label}.csv`), marketplaceRows)
      writeCsv(path.join(dir, `returns-scans-${label}.csv`), scans.rows)
      writeCsv(path.join(dir, `returns-oms-invoices-${label}.csv`), invoices.rows)
    }
  } finally {
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
