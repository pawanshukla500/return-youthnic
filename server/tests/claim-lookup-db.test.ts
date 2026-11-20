// Database checks for item 2.3: the claim lookup and the claim's link to a saved bench scan. They run only when
// TEST_DATABASE_URL is set to a dedicated test database whose name contains "test". Otherwise every check is skipped.
// Nothing here uses real data: every value starts with SYN and every run uses its own suffix. Lookup rows are written
// directly (not through an upload), so no other test's active rows are superseded.
//
// What these checks cover, against a real PostgreSQL:
//  - A staging row, and a superseded row with no saved scan, is never returned. A re-uploaded AWB returns the active
//    row; a saved scan on a superseded row is still found through its scan (the scan is the permanent record).
//  - An exact match that is not scanned beats a scanned partial match. A partial match is flagged as partial.
//  - % and _ in the search text are matched as text, not as LIKE wildcards.
//  - A claim with no saved bench scan is rejected and writes nothing; the bench scan of the same AWB is not blocked;
//    the claim then attaches to that bench scan, and its lines keep the operator's counts.
//  - A scan with no lines gets its ticket but no invented received or verified line.
//  - A restricted user's lookup works for their own account; another account's return and scan are never found or
//    attached (account scope bound in SQL).
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import pg from "pg"
import { applySchema, connectionSettingsFor } from "../db.js"
import { ensureReferenceData } from "../reference-data.js"
import { lookupReturnForClaim, resolveClaimScanId, syncClaimTicketToRegister } from "../claim-automation-service.js"
import { createClaim } from "../claims-service.js"
import { ServiceError, recordScan, type Actor } from "../register-service.js"
import type { AccountScope } from "../access.js"

const rawUrl = process.env.TEST_DATABASE_URL?.trim() || ""

function skipReason(): string {
  if (!rawUrl) return "Set TEST_DATABASE_URL to a dedicated test database to run these checks."
  try {
    const name = decodeURIComponent(new URL(rawUrl).pathname.replace(/^\//, ""))
    if (!/test/i.test(name)) return "TEST_DATABASE_URL must point to a database whose name contains 'test'."
  } catch {
    return "TEST_DATABASE_URL is not a valid postgresql:// URL."
  }
  return ""
}

const skip = skipReason()
const run = Date.now().toString(36).toUpperCase()
const scope: AccountScope = { all: true }

let pool: pg.Pool
let actor: Actor
let meeshoId = 0
let flipkartId = 0
let courierId = 0
let skuId = 0

type LookupRow = { id: number; itemId: number; tracking: string }

async function makeReturn(
  label: string,
  options: { tracking?: string; status?: "active" | "staging" | "superseded"; marketplaceId?: number; qty?: number } = {},
): Promise<LookupRow> {
  const tracking = options.tracking ?? `SYN-${run}-${label}-AWB`
  const er = await pool.query(
    `INSERT INTO expected_returns (tracking_id, marketplace_id, order_number, courier_id, return_type, matched_from, lookup_status)
     VALUES ($1, $2, $3, $4, 'Customer Return', 'SYN', $5) RETURNING id`,
    [tracking, options.marketplaceId ?? flipkartId, `SYN-${run}-${label}-ORD`, courierId, options.status ?? "active"],
  )
  const id = Number(er.rows[0].id)
  const item = await pool.query(
    `INSERT INTO expected_return_items (expected_return_id, sku_id, qty, sort_order, label)
     VALUES ($1, $2, $3, 1, 'SYN product') RETURNING id`,
    [id, skuId, options.qty ?? 1],
  )
  return { id, itemId: Number(item.rows[0].id), tracking }
}

// A saved scan row with no lines, for the ranking checks. The bench path (recordScan) is used where lines matter.
async function scanRow(expectedReturnId: number): Promise<number> {
  const scan = await pool.query(
    `INSERT INTO receipt_scans (expected_return_id, scanned_by, scanned_time_label, outcome, issue_label, status)
     VALUES ($1, $2, 'SYN', 'clear', '', 'Clear') RETURNING id`,
    [expectedReturnId, actor.id],
  )
  return Number(scan.rows[0].id)
}

async function count(sql: string, id: number): Promise<number> {
  return Number((await pool.query(sql, [id])).rows[0].n)
}

const SCANS_FOR_RETURN = "SELECT COUNT(*)::int AS n FROM receipt_scans WHERE expected_return_id = $1"
const LINES_FOR_RETURN = `SELECT COUNT(*)::int AS n FROM receipt_scan_items rsi
  JOIN receipt_scans rs ON rs.id = rsi.receipt_scan_id WHERE rs.expected_return_id = $1`

async function benchScanRequired(work: Promise<unknown>): Promise<void> {
  await assert.rejects(work, (err) => {
    assert.ok(err instanceof ServiceError, `expected a ServiceError, got ${String(err)}`)
    assert.equal(err.status, 409)
    assert.equal(err.extra.code, "bench_scan_required")
    return true
  })
}

before(async () => {
  if (skip) return
  const settings = connectionSettingsFor(rawUrl)
  pool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000 })
  await applySchema(pool)
  await ensureReferenceData(pool)
  meeshoId = Number((await pool.query(`SELECT id FROM marketplaces WHERE name = 'Meesho'`)).rows[0].id)
  flipkartId = Number((await pool.query(`SELECT id FROM marketplaces WHERE name = 'Flipkart'`)).rows[0].id)
  const user = await pool.query(
    `INSERT INTO users (initials, name, email, password_hash, role, sidebar_label, has_all_marketplaces)
     VALUES ('SC', $1, $2, 'SYN-HASH', 'Supervisor', 'Supervisor', true) RETURNING id`,
    [`SYN claims ${run}`, `syn-claims-${run}@example.test`],
  )
  actor = { id: Number(user.rows[0].id), name: `SYN claims ${run}` }
  courierId = Number((await pool.query(`INSERT INTO couriers (name) VALUES ($1) RETURNING id`, [`SYN-${run}-COURIER`])).rows[0].id)
  const sku = await pool.query(
    `INSERT INTO skus (code, name, color_name, color_hex, key_detail, brand_label, set_contents, image_url)
     VALUES ($1, 'SYN product', 'SYN', '#000000', '', '', '', '') RETURNING id`,
    [`SYN-${run}-SKU`],
  )
  skuId = Number(sku.rows[0].id)
})

after(async () => {
  if (pool) await pool.end()
})

test("db: staging rows and superseded rows with no scan are never returned", { skip: skip || false }, async () => {
  const staging = await makeReturn("STAGE", { status: "staging" })
  const stale = await makeReturn("STALE", { status: "superseded" })
  assert.equal(await lookupReturnForClaim(pool, scope, staging.tracking), null, "exact AWB of a staging row")
  assert.equal(await lookupReturnForClaim(pool, scope, `${run}-STAGE`), null, "partial AWB of a staging row")
  assert.equal(await lookupReturnForClaim(pool, scope, stale.tracking), null, "exact AWB of a superseded row")
  assert.equal(await lookupReturnForClaim(pool, scope, `SYN-${run}-STALE-ORD`), null, "order of a superseded row")

  // A re-upload: the same AWB is superseded once and active now. The active row is the answer.
  await makeReturn("REUP", { status: "superseded" })
  const current = await makeReturn("REUP")
  const reup = await lookupReturnForClaim(pool, scope, current.tracking)
  assert.equal(reup?.expectedReturnId, current.id)

  // A return scanned before the next upload superseded its row is still found through the saved scan.
  const kept = await makeReturn("KEPT", { status: "superseded" })
  const keptScan = await scanRow(kept.id)
  const found = await lookupReturnForClaim(pool, scope, kept.tracking)
  assert.equal(found?.scanId, keptScan)
  assert.equal(found?.expectedReturnId, kept.id)
})

test("db: an exact match that is not scanned beats a scanned partial match", { skip: skip || false }, async () => {
  const exact = await makeReturn("EXACT", { tracking: `SYN-${run}-EX1` })
  const partial = await makeReturn("PARTIAL", { tracking: `SYN-${run}-EX1-LONGER` })
  const partialScan = await scanRow(partial.id)

  const hit = await lookupReturnForClaim(pool, scope, `SYN-${run}-EX1`)
  assert.equal(hit?.expectedReturnId, exact.id, "the exact AWB wins over a scanned row that only contains it")
  assert.equal(hit?.scanId, null)
  assert.equal(hit?.exactMatch, true)

  const contains = await lookupReturnForClaim(pool, scope, `${run}-EX1-LONG`)
  assert.equal(contains?.expectedReturnId, partial.id)
  assert.equal(contains?.scanId, partialScan)
  assert.equal(contains?.exactMatch, false, "a partial match is flagged so nothing binds to it alone")
})

test("db: % and _ in the search text are matched literally", { skip: skip || false }, async () => {
  await makeReturn("WILD", { tracking: `SYN-${run}-WXYZ-1` })
  const literal = await makeReturn("LIT", { tracking: `SYN-${run}-L_1%X` })
  assert.equal(await lookupReturnForClaim(pool, scope, `${run}-W_YZ`), null, "_ is not a one-character wildcard")
  assert.equal(await lookupReturnForClaim(pool, scope, `${run}-W%Z`), null, "% is not an any-text wildcard")
  const hit = await lookupReturnForClaim(pool, scope, `${run}-L_1%`)
  assert.equal(hit?.expectedReturnId, literal.id, "a real _ and % still match themselves")
  assert.equal(hit?.exactMatch, false)
})

test("db: a claim needs the saved bench scan; the bench scan is not blocked and keeps its counts", { skip: skip || false }, async () => {
  const ret = await makeReturn("FLOW", { qty: 2 })

  // Claim first: rejected, and nothing is written to the register.
  await benchScanRequired(resolveClaimScanId(pool, scope, { scanId: null, keys: [ret.tracking, "", `SYN-${run}-FLOW-ORD`] }))
  assert.equal(await count(SCANS_FOR_RETURN, ret.id), 0, "a rejected claim creates no receipt scan")
  assert.equal(await count(LINES_FOR_RETURN, ret.id), 0, "a rejected claim records no line")

  // The bench scan of the same AWB saves normally.
  const receipt = await recordScan(
    pool,
    actor,
    {
      submission: {
        shipmentId: ret.id,
        clientScanKey: `SYN-${run}-FLOW`,
        notes: "",
        scannedTracking: ret.tracking,
        items: [{ itemId: ret.itemId, receivedQty: 2, verified: true, issues: [] }],
      },
      photoCount: 0,
      hasVideo: false,
    },
    scope,
  )
  assert.equal(receipt.replayed, false)
  const scanId = receipt.scan.id

  // The claim then attaches to that scan: by the app's scan id, and by AWB for an older APK that sends none.
  assert.equal(await resolveClaimScanId(pool, scope, { scanId, keys: [] }), scanId)
  assert.equal(await resolveClaimScanId(pool, scope, { scanId: null, keys: [ret.tracking.toLowerCase(), "", ""] }), scanId)
  const claim = await createClaim(pool, actor, scope, {
    receiptScanId: scanId,
    claimReason: "SYN damaged return",
    claimTitle: `SYN claim ${run}`,
    claimDescription: "SYN description",
    remarks: "",
  })
  assert.equal(claim.receiptScanId, scanId)
  await syncClaimTicketToRegister(pool, { receiptScanId: scanId, ticketCode: `SYN-${run}-CLM`, status: "Draft", actorId: actor.id })

  assert.equal(await count(SCANS_FOR_RETURN, ret.id), 1, "the claim adds no second scan")
  const lines = await pool.query("SELECT received_qty FROM receipt_scan_items WHERE receipt_scan_id = $1", [scanId])
  assert.equal(lines.rows.length, 1, "only the operator's line")
  assert.equal(Number(lines.rows[0].received_qty), 2, "the operator's count is kept")
})

test("db: a scan with no lines gets its ticket and no invented line", { skip: skip || false }, async () => {
  const ret = await makeReturn("NOLINE")
  const scanId = await scanRow(ret.id)
  const ticketId = await syncClaimTicketToRegister(pool, { receiptScanId: scanId, ticketCode: `SYN-${run}-NOLINE`, actorId: actor.id })
  assert.ok(ticketId && ticketId > 0, "the ticket is recorded")
  assert.equal(await count(LINES_FOR_RETURN, ret.id), 0, "no line is recorded as received or verified without a count")
})

test("db: a restricted user finds only their own account's return and saved scan", { skip: skip || false }, async () => {
  const ret = await makeReturn("SCOPE")
  const scanId = await scanRow(ret.id)
  const flipkartOnly: AccountScope = { all: false, marketplaceIds: [flipkartId] }
  const own = await lookupReturnForClaim(pool, flipkartOnly, ret.tracking)
  assert.equal(own?.scanId, scanId, "the account list is bound after the search text, so a restricted lookup works")
  assert.equal(await resolveClaimScanId(pool, flipkartOnly, { scanId: null, keys: [ret.tracking] }), scanId)

  const meeshoOnly: AccountScope = { all: false, marketplaceIds: [meeshoId] }
  assert.equal(await lookupReturnForClaim(pool, meeshoOnly, ret.tracking), null)
  await benchScanRequired(resolveClaimScanId(pool, meeshoOnly, { scanId: null, keys: [ret.tracking] }))
  await assert.rejects(
    createClaim(pool, actor, meeshoOnly, {
      receiptScanId: scanId,
      claimReason: "SYN damaged return",
      claimTitle: `SYN claim ${run}`,
      claimDescription: "",
      remarks: "",
    }),
    (err) => err instanceof ServiceError && err.status === 404,
  )
  const claims = await pool.query("SELECT COUNT(*)::int AS n FROM claims WHERE receipt_scan_id = $1", [scanId])
  assert.equal(claims.rows[0].n, 0)
})
