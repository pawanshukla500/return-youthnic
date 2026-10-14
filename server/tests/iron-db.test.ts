// Database checks for Iron Send, the return analytics and the email report queries. They run only when TEST_DATABASE_URL
// is set to a dedicated test database whose name contains "test". Every value starts with SYN.
//
// What these checks cover, in order (later checks build on the data of earlier ones):
//  - A scan with only Iron Send is a clear return: not an issue, no claim, and one open Iron Send record.
//  - A scan with Iron Send and a real issue is an issue return, and its issue text names only the real issue.
//  - Iron Send units are never in the OMSGuru file, and missing units are not subtracted twice.
//  - Nothing marks an Iron Send as received. Only the Inward Team (or an Admin) records units that came back; the
//    Return Team is refused. A retried entry counts once. More than pending is refused.
//  - Pending, Received and Overdue quantities are tracked separately.
//  - A bench correction cannot change an Iron Send that the Inward Team has already received.
//  - A scan saved before this rule (issue outcome, Iron Send only) is corrected by the schema run, with an audit row.
//  - The analytics never count Iron Send as an issue. The daily and weekly email queries run against the real schema.

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import pg from "pg"
import { scopeFor, type AccountScope } from "../access.js"
import { loadAnalytics } from "../analytics.js"
import { applySchema, connectionSettingsFor } from "../db.js"
import { generateDailyReportData, generateWeeklyReportData, renderWeeklyEmail } from "../email-reports.js"
import { getIronRecord, ironSummary, listIronRecords, receiveIron } from "../iron.js"
import { currentCursor } from "../live.js"
import { commitLookupUpload } from "../lookup-import.js"
import { calculateGoodReturnsForDay } from "../omsguru-daily.js"
import { ensureReferenceData } from "../reference-data.js"
import { ServiceError, correctScanIssue, lookupShipment, recordScan, scanSession, type Actor } from "../register-service.js"
import type { ScanSubmission } from "../register-rules.js"
import type { ParsedRow } from "../sheets.js"

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
const ACCOUNT = "Ajio"
const AWB = {
  iron: `SYN-${run}-IRON`,
  mixed: `SYN-${run}-MIXED`,
  missing: `SYN-${run}-MISS`,
  clean: `SYN-${run}-CLEAN`,
  correct: `SYN-${run}-CORR`,
}

let pool: pg.Pool
let scanner: Actor & { role: string }
let inward: Actor & { role: string }
let admin: Actor & { role: string }
let allScope: AccountScope
let accountId = 0

function row(overrides: Partial<ParsedRow>): ParsedRow {
  return {
    trackingId: "",
    altTrackingId: "",
    orderId: `SYN-${run}-ORDER`,
    orderLineId: `SYN-${run}-LINE`,
    channelListingId: `SYN-${run}-KURTA-BLUE_M`,
    channelSku: `SYN-${run}-KURTA-BLUE_M`,
    sku: `SYN-${run}-KURTA-BLUE_M`,
    productName: "SYN kurta",
    qty: 1,
    courier: "SYN-COURIER",
    returnType: "Customer Return",
    returnReason: "SYN size too small",
    colorName: "—",
    keyDetail: "",
    brandLabel: "",
    setContents: "",
    marketplace: ACCOUNT,
    cancelled: false,
    valid: true,
    error: "",
    warnings: [],
    pendingReasons: [],
    raw: {},
    ...overrides,
  }
}

async function makeUser(label: string, role: string): Promise<Actor & { role: string }> {
  const inserted = await pool.query(
    `INSERT INTO users (initials, name, email, password_hash, role, sidebar_label, has_all_marketplaces)
     VALUES ('SY', $1, $2, 'SYN-HASH', $3, $3, true)
     RETURNING id`,
    [`SYN ${label} ${run}`, `syn-iron-${label}-${run}@example.test`, role],
  )
  return { id: Number(inserted.rows[0].id), name: `SYN ${label} ${run}`, role }
}

async function shipmentOf(tracking: string) {
  const result = await lookupShipment(pool, { tracking, marketplace: ACCOUNT, shipmentId: null })
  assert.equal(result.status, "found", `lookup of ${tracking} returned ${result.status}`)
  if (result.status !== "found") throw new Error("unreachable")
  return result.shipment
}

function submission(shipmentId: number, key: string, items: ScanSubmission["items"]): ScanSubmission {
  return { shipmentId, clientScanKey: key, notes: "", items }
}

async function expectError(work: Promise<unknown>, status: number, pattern: RegExp): Promise<void> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${String(error)}`)
    assert.equal(error.status, status, error.message)
    assert.match(error.message, pattern)
    return
  }
  assert.fail(`expected a ${status} error`)
}

async function recordOf(scanId: number) {
  const result = await pool.query("SELECT id FROM iron_send_records WHERE receipt_scan_id = $1 AND status = 'open'", [scanId])
  assert.equal(result.rows.length, 1, "one open Iron Send record")
  return getIronRecord(pool, allScope, Number(result.rows[0].id))
}

function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
}

before(async () => {
  if (skip) return
  const settings = connectionSettingsFor(rawUrl)
  pool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000 })
  await applySchema(pool)
  await ensureReferenceData(pool)
  scanner = await makeUser("scanner", "Scanner")
  inward = await makeUser("inward", "Inward")
  admin = await makeUser("admin", "Admin")
  allScope = scopeFor({ role: "Admin", hasAllMarketplaces: true, marketplaceIds: [] })
  accountId = Number((await pool.query("SELECT id FROM marketplaces WHERE name = $1", [ACCOUNT])).rows[0].id)
  await commitLookupUpload(pool, {
    marketplaceName: ACCOUNT,
    filename: `SYN-IRON-${run}.csv`,
    uploadedBy: admin.id,
    uploadedLabel: "SYN",
    rows: [
      row({ trackingId: AWB.iron, orderLineId: `SYN-${run}-L1`, qty: 2 }),
      row({ trackingId: AWB.mixed, orderLineId: `SYN-${run}-L2`, qty: 2, channelListingId: `SYN-${run}-TOP-RED_L`, sku: `SYN-${run}-TOP-RED_L` }),
      row({ trackingId: AWB.missing, orderLineId: `SYN-${run}-L3`, qty: 2 }),
      row({ trackingId: AWB.clean, orderLineId: `SYN-${run}-L4`, qty: 1 }),
      row({ trackingId: AWB.correct, orderLineId: `SYN-${run}-L5`, qty: 1 }),
    ],
    images: new Map(),
    sources: new Map(),
  })
})

after(async () => {
  if (pool) await pool.end()
})

let ironScanId = 0

test("a scan with only Iron Send is a clear return, opens one Iron Send record, and is not a claim", { skip: skip || false }, async () => {
  const before = await scanSession(pool, allScope)
  const shipment = await shipmentOf(AWB.iron)
  const receipt = await recordScan(pool, scanner, {
    submission: submission(shipment.shipmentId, `SYN-${run}-IRON-1`, [
      {
        itemId: shipment.items[0].itemId,
        receivedQty: 2,
        verified: true,
        issues: [{ categoryCode: "iron_send", subIssueId: null, qty: 2, ticketCode: "", notes: "SYN crushed" }],
      },
    ]),
    photoCount: 0,
    hasVideo: false,
  })
  ironScanId = receipt.scan.id
  assert.equal(receipt.scan.outcome, "clear", "Iron Send alone is not an issue return")
  assert.equal(receipt.scan.status, "Clear", "Iron Send alone never opens a claim (Draft/Raised)")
  assert.equal(receipt.issueCount, 0, "Iron Send is not counted as an issue")
  assert.equal(receipt.ironSendQty, 2)
  const after = await scanSession(pool, allScope)
  assert.equal(Number(after.shift.issues), Number(before.shift.issues), "today's issue count is unchanged")
  assert.equal(Number(after.shift.correct), Number(before.shift.correct) + 1, "the return counts as correct")
  const record = await recordOf(ironScanId)
  assert.equal(record.qtySent, 2)
  assert.equal(record.qtyReceived, 0, "nothing is received automatically")
  assert.equal(record.state, "pending")
  assert.equal(record.size, "M")
})

test("Iron Send with a real issue is an issue return, and the issue text names only the real issue", { skip: skip || false }, async () => {
  const shipment = await shipmentOf(AWB.mixed)
  const receipt = await recordScan(pool, scanner, {
    submission: submission(shipment.shipmentId, `SYN-${run}-MIXED-1`, [
      {
        itemId: shipment.items[0].itemId,
        receivedQty: 2,
        verified: true,
        issues: [
          { categoryCode: "damaged_product", subIssueId: null, qty: 1, ticketCode: "", notes: "" },
          { categoryCode: "iron_send", subIssueId: null, qty: 1, ticketCode: "", notes: "" },
        ],
      },
    ]),
    photoCount: 0,
    hasVideo: false,
  })
  assert.equal(receipt.scan.outcome, "issue")
  assert.equal(receipt.issueCount, 1, "only the damaged issue is a return issue")
  assert.equal(receipt.ironSendQty, 1)
  const label = await pool.query("SELECT issue_label FROM receipt_scans WHERE id = $1", [receipt.scan.id])
  assert.doesNotMatch(String(label.rows[0].issue_label), /Iron/)
})

test("OMSGuru: Iron Send and damaged units are left out, and a missing unit is not subtracted twice", { skip: skip || false }, async () => {
  const sub = await pool.query(
    "SELECT id FROM missing_component_options WHERE category_code = 'missing_component' AND active ORDER BY id LIMIT 1",
  )
  let subId: number
  if (sub.rows[0]) subId = Number(sub.rows[0].id)
  else {
    const created = await pool.query(
      "INSERT INTO missing_component_options (label, active, sort_order, category_code) VALUES ('SYN Bottom', true, 99, 'missing_component') RETURNING id",
    )
    subId = Number(created.rows[0].id)
  }
  const shipment = await shipmentOf(AWB.missing)
  await recordScan(pool, scanner, {
    submission: submission(shipment.shipmentId, `SYN-${run}-MISS-1`, [
      {
        itemId: shipment.items[0].itemId,
        receivedQty: 1,
        verified: true,
        issues: [{ categoryCode: "missing_component", subIssueId: subId, qty: 1, ticketCode: "", notes: "" }],
      },
    ]),
    photoCount: 0,
    hasVideo: false,
  })
  const clean = await shipmentOf(AWB.clean)
  await recordScan(pool, scanner, {
    submission: submission(clean.shipmentId, `SYN-${run}-CLEAN-1`, [
      { itemId: clean.items[0].itemId, receivedQty: 1, verified: true, issues: [] },
    ]),
    photoCount: 0,
    hasVideo: false,
  })

  const day = await calculateGoodReturnsForDay(pool, todayIst())
  const kurta = day.skus.find((entry) => entry.sku === `SYN-${run}-KURTA-BLUE_M`)
  // IRON: 2 received, 2 Iron Send -> 0. MISSING: 1 received, 1 missing -> 1 good. CLEAN: 1 good. Total 2.
  assert.equal(kurta?.qty, 2, "Iron Send units are excluded, and the received unit of a part-missing return is good stock")
  const top = day.skus.find((entry) => entry.sku === `SYN-${run}-TOP-RED_L`)
  // MIXED: 2 received, 1 damaged, 1 Iron Send -> 0.
  assert.equal(top, undefined, "damaged and Iron Send units are never sent")
})

test("only the Inward Team records ironed units; partial, replayed and excess entries are handled", { skip: skip || false }, async () => {
  const record = await recordOf(ironScanId)
  await expectError(
    receiveIron(pool, scanner, allScope, { recordId: record.id, qty: 1, notes: "", clientKey: null }),
    403,
    /Inward Team/,
  )
  const first = await receiveIron(pool, inward, allScope, { recordId: record.id, qty: 1, notes: "SYN first", clientKey: `SYN-${run}-RCV-1` })
  assert.equal(first.record.qtyReceived, 1)
  assert.equal(first.record.qtyPending, 1)
  assert.equal(first.record.state, "partial")
  const replay = await receiveIron(pool, inward, allScope, { recordId: record.id, qty: 1, notes: "SYN first", clientKey: `SYN-${run}-RCV-1` })
  assert.equal(replay.replayed, true)
  assert.equal(replay.record.qtyReceived, 1, "a retried entry counts once")
  await expectError(
    receiveIron(pool, inward, allScope, { recordId: record.id, qty: 2, notes: "", clientKey: null }),
    400,
    /Only 1 unit/,
  )
  const restricted: AccountScope = { all: false, marketplaceIds: [] }
  await expectError(
    receiveIron(pool, inward, restricted, { recordId: record.id, qty: 1, notes: "", clientKey: null }),
    404,
    /not found/,
  )
})

test("pending, received and overdue quantities are tracked separately", { skip: skip || false }, async () => {
  const mixed = await pool.query(
    `SELECT r.id FROM iron_send_records r JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
     WHERE rs.tracking_id_snapshot = $1 AND r.status = 'open'`,
    [AWB.mixed],
  )
  const mixedId = Number(mixed.rows[0].id)
  // The mixed return was sent 4 days ago: past the 3-day default, so it is overdue.
  await pool.query("UPDATE iron_send_records SET sent_at = now() - interval '4 days' WHERE id = $1", [mixedId])
  const overdue = await getIronRecord(pool, allScope, mixedId)
  assert.equal(overdue.state, "overdue")

  const list = await listIronRecords(pool, allScope, { state: "open", marketplaceId: accountId, search: `SYN-${run}` })
  const ids = list.rows.map((r) => r.id)
  assert.ok(ids.includes(mixedId))
  const summary = await ironSummary(pool, allScope, accountId)
  assert.ok(summary.units.overdue >= 1)
  assert.ok(summary.units.pending >= 2, "1 pending on the first record and 1 overdue on the mixed record")
  assert.ok(summary.units.received >= 1)
  assert.equal(summary.overdueAfterDays, 3)

  const record = await recordOf(ironScanId)
  const done = await receiveIron(pool, inward, allScope, { recordId: record.id, qty: 1, notes: "", clientKey: null })
  assert.equal(done.record.state, "received")
  const received = await listIronRecords(pool, allScope, { state: "received", search: AWB.iron })
  assert.equal(received.rows.length, 1)
  const stillOpen = await listIronRecords(pool, allScope, { state: "open", search: AWB.iron })
  assert.equal(stillOpen.rows.length, 0, "a fully received record leaves the open list")
})

test("a bench correction cannot change an Iron Send that the Inward Team already received", { skip: skip || false }, async () => {
  const shipment = await shipmentOf(AWB.correct)
  const key = `SYN-${run}-CORR-1`
  await recordScan(pool, scanner, {
    submission: submission(shipment.shipmentId, key, [
      { itemId: shipment.items[0].itemId, receivedQty: 1, verified: true, issues: [] },
    ]),
    photoCount: 0,
    hasVideo: false,
  })
  const withIron = await correctScanIssue(
    pool,
    scanner,
    submission(shipment.shipmentId, key, [
      {
        itemId: shipment.items[0].itemId,
        receivedQty: 1,
        verified: true,
        issues: [{ categoryCode: "iron_send", subIssueId: null, qty: 1, ticketCode: "", notes: "" }],
      },
    ]),
    allScope,
  )
  assert.equal(withIron.scan.outcome, "clear")
  const record = await recordOf(withIron.scan.id)
  await receiveIron(pool, inward, allScope, { recordId: record.id, qty: 1, notes: "", clientKey: null })
  await expectError(
    correctScanIssue(
      pool,
      scanner,
      submission(shipment.shipmentId, key, [{ itemId: shipment.items[0].itemId, receivedQty: 1, verified: true, issues: [] }]),
      allScope,
    ),
    409,
    /Inward Team has already received/,
  )
  const audit = await pool.query(
    "SELECT COUNT(*)::int AS n FROM register_audit_log WHERE action = 'scan.issues_replaced' AND entity_id = $1",
    [String(withIron.scan.id)],
  )
  assert.equal(audit.rows[0].n, 0, "the refused correction left no audit row (it rolled back)")
})

test("a scan saved before this rule (Iron Send only, issue outcome) is corrected by the schema run, with an audit row", { skip: skip || false }, async () => {
  await pool.query("UPDATE receipt_scans SET outcome = 'issue', status = 'Draft' WHERE id = $1", [ironScanId])
  await applySchema(pool)
  const fixed = await pool.query("SELECT outcome, status FROM receipt_scans WHERE id = $1", [ironScanId])
  assert.equal(fixed.rows[0].outcome, "clear")
  assert.equal(fixed.rows[0].status, "Clear")
  const audit = await pool.query(
    "SELECT details FROM register_audit_log WHERE action = 'scan.reclassify_operational' AND entity_id = $1",
    [String(ironScanId)],
  )
  assert.ok(audit.rows.length >= 1)
  assert.equal(audit.rows[audit.rows.length - 1].details.fromOutcome, "issue")
  const records = await pool.query("SELECT COUNT(*)::int AS n FROM iron_send_records WHERE receipt_scan_id = $1", [ironScanId])
  assert.equal(records.rows[0].n, 1, "the backfill does not add a second record")
})

test("analytics never count Iron Send as an issue, and size, SKU and reason figures add up", { skip: skip || false }, async () => {
  const report = await loadAnalytics(pool, allScope, { dateFrom: todayIst(), dateTo: todayIst(), marketplaceId: accountId })
  const kurta = report.bySku.find((s) => s.sku === `SYN-${run}-KURTA-BLUE_M`)
  assert.ok(kurta)
  assert.equal(kurta.ironUnits >= 2, true)
  const iron = report.byIssueCategory.find((c) => c.code === "iron_send")
  assert.equal(iron?.operational, true)
  const nonIronIssueUnits = report.byIssueCategory.filter((c) => !c.operational).reduce((sum, c) => sum + c.units, 0)
  assert.equal(report.totals.issueUnits, nonIronIssueUnits, "issue units exclude Iron Send")
  const sizeUnits = report.bySize.reduce((sum, s) => sum + s.units, 0)
  assert.equal(sizeUnits, report.totals.units, "every received unit has a size bucket")
  assert.ok(report.bySize.some((s) => s.size === "M"))
  assert.ok(report.byReason.some((r) => r.reason === "SYN size too small"))
  assert.ok(report.insights.length > 0)
})

test("the daily and weekly email queries run against the real schema", { skip: skip || false }, async () => {
  const daily = await generateDailyReportData(pool, todayIst())
  assert.ok(daily.totalShipments >= 5)
  assert.ok(daily.marketplaces.some((m) => m.marketplace === ACCOUNT && m.shipments >= 5))
  const sunday = new Date(Date.now() + 330 * 60_000)
  sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7))
  const weekly = await generateWeeklyReportData(pool, sunday.toISOString().slice(0, 10))
  assert.ok(weekly.totalShipments >= 5)
  assert.ok(!weekly.topIssues.some((issue) => /Iron/i.test(issue.category)), "Iron Send is not a top issue")
  assert.ok(weekly.iron, "the weekly email has the Iron Send figures")
  const { html, text } = renderWeeklyEmail(weekly)
  assert.match(html, /Iron Send/)
  assert.match(text, /Size-wise returns/)
})

test("every change moves the sync cursor", { skip: skip || false }, async () => {
  const before = await currentCursor(pool)
  const record = await pool.query(
    `SELECT r.id FROM iron_send_records r JOIN receipt_scans rs ON rs.id = r.receipt_scan_id
     WHERE rs.tracking_id_snapshot = $1 AND r.status = 'open'`,
    [AWB.mixed],
  )
  await receiveIron(pool, admin, allScope, { recordId: Number(record.rows[0].id), qty: 1, notes: "", clientKey: null })
  assert.ok((await currentCursor(pool)) > before)
})
