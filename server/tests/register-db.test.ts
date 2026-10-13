// Database checks for the return scan register. They run only against a dedicated test database:
//   TEST_DATABASE_URL must be set, and its database name must contain "test". Otherwise every check is skipped.
// Nothing here uses real data. Every value starts with SYN.
//
// The checks run in order, because later checks build on the uploads of earlier ones.

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import pg from "pg"
import { applySchema, connectionSettingsFor } from "../db.js"
import { commitLookupUpload, type ProductSource } from "../lookup-import.js"
import { ensureReferenceData } from "../reference-data.js"
import {
  ServiceError,
  exportRegister,
  listRegister,
  lookupShipment,
  recordScan,
  ticketHistory,
  updateTicketStatus,
  type Actor,
} from "../register-service.js"
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
const run = Date.now().toString(36)
const KEY_PREFIX = `SYN-${run}`

let pool: pg.Pool
let actor: Actor

function row(overrides: Partial<ParsedRow>): ParsedRow {
  return {
    trackingId: "",
    altTrackingId: "",
    orderId: "SYN-ORDER",
    orderLineId: "SYN-LINE",
    channelListingId: "SYN-LISTING",
    channelSku: "SYN-LISTING",
    sku: "SYN-LISTING",
    productName: "SYN product",
    qty: 1,
    courier: "SYN-COURIER",
    returnType: "Customer Return",
    returnReason: "SYN reason",
    colorName: "—",
    keyDetail: "",
    brandLabel: "",
    setContents: "",
    marketplace: "",
    cancelled: false,
    valid: true,
    error: "",
    warnings: [],
    pendingReasons: [],
    raw: {},
    ...overrides,
  }
}

async function upload(marketplace: string, rows: ParsedRow[], label: string, sources?: Map<string, ProductSource>) {
  return commitLookupUpload(pool, {
    marketplaceName: marketplace,
    filename: `SYN-${label}.csv`,
    uploadedBy: actor.id,
    uploadedLabel: label,
    rows,
    images: new Map(),
    sources: sources ?? new Map(),
  })
}

async function expectError(work: Promise<unknown>, status: number, pattern: RegExp): Promise<ServiceError> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${String(error)}`)
    assert.equal(error.status, status, error.message)
    assert.match(error.message, pattern)
    return error
  }
  assert.fail(`expected a ${status} error`)
}

type FoundShipment = Extract<Awaited<ReturnType<typeof lookupShipment>>, { status: "found" }>["shipment"]

async function found(tracking: string, marketplace: string): Promise<FoundShipment> {
  const result = await lookupShipment(pool, { tracking, marketplace, shipmentId: null })
  assert.equal(result.status, "found", `lookup of ${tracking} in ${marketplace} returned ${result.status}`)
  if (result.status !== "found") throw new Error("unreachable")
  return result.shipment
}

function submission(shipmentId: number, key: string, items: ScanSubmission["items"]): ScanSubmission {
  return { shipmentId, clientScanKey: key, notes: "", items }
}

async function countScans(expectedReturnId: number): Promise<number> {
  const result = await pool.query("SELECT COUNT(*)::int AS n FROM receipt_scans WHERE expected_return_id = $1", [expectedReturnId])
  return Number(result.rows[0].n)
}

const TRACK = {
  shared: `SYN-${run}-SHARED`,
  multi: `SYN-${run}-MULTI`,
  scan: `SYN-${run}-SCAN`,
  gone: `SYN-${run}-GONE`,
  concurrent: `SYN-${run}-CONC`,
  fresh: `SYN-${run}-NEW`,
}

before(async () => {
  if (skip) return
  const settings = connectionSettingsFor(rawUrl)
  pool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000 })
  await applySchema(pool)
  await ensureReferenceData(pool)
  const user = await pool.query(
    `INSERT INTO users (initials, name, email, password_hash, role, sidebar_label, has_all_marketplaces)
     VALUES ('SS', 'SYN Scanner', $1, 'SYN-HASH', 'Scanner', 'Scanner', true)
     RETURNING id`,
    [`syn-scanner-${run}@example.test`],
  )
  actor = { id: Number(user.rows[0].id), name: "SYN Scanner" }
})

after(async () => {
  if (pool) await pool.end()
})

test("the same AWB can exist in Myntra EJ and Myntra VB without touching each other", { skip }, async () => {
  await upload(
    "Myntra EJ",
    [row({ trackingId: TRACK.shared, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-A", sku: "SYN-EJ-A", orderLineId: "SYN-EJ-L1" })],
    "EJ-1",
  )
  await upload(
    "Myntra VB",
    [row({ trackingId: TRACK.shared, marketplace: "Myntra VB", channelListingId: "SYN-VB-A", sku: "SYN-VB-A", orderLineId: "SYN-VB-L1" })],
    "VB-1",
  )
  const both = await lookupShipment(pool, { tracking: TRACK.shared, marketplace: "Auto detect", shipmentId: null })
  assert.equal(both.status, "choose", "one AWB in two accounts must not be picked silently")
  if (both.status !== "choose") throw new Error("unreachable")
  assert.deepEqual(both.candidates.map((candidate) => candidate.accountName).sort(), ["Myntra EJ", "Myntra VB"])

  const ej = await found(TRACK.shared, "Myntra EJ")
  assert.equal(ej.marketplace, "Myntra EJ")
  const vb = await found(TRACK.shared, "Myntra VB")
  assert.equal(vb.marketplace, "Myntra VB")
  assert.notEqual(ej.shipmentId, vb.shipmentId)
})

test("a return with two lines lists every line with its own order item and quantity", { skip }, async () => {
  await upload(
    "Myntra EJ",
    [
      row({ trackingId: TRACK.multi, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-B", sku: "SYN-EJ-B", orderLineId: "SYN-EJ-L2", qty: 1 }),
      row({ trackingId: TRACK.multi, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-C", sku: "SYN-EJ-C", orderLineId: "SYN-EJ-L3", qty: 2 }),
      row({ trackingId: TRACK.scan, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-D", sku: "SYN-EJ-D", orderLineId: "SYN-EJ-L4", qty: 2 }),
      row({ trackingId: TRACK.gone, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-E", sku: "SYN-EJ-E", orderLineId: "SYN-EJ-L5", qty: 1 }),
      row({ trackingId: TRACK.concurrent, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-F", sku: "SYN-EJ-F", orderLineId: "SYN-EJ-L6", qty: 1 }),
    ],
    "EJ-2",
  )
  const multi = await found(TRACK.multi, "Myntra EJ")
  assert.equal(multi.items.length, 2)
  assert.deepEqual(multi.items.map((item) => item.expectedQty), [1, 2])
  assert.deepEqual(multi.items.map((item) => item.orderItemId), ["SYN-EJ-L2", "SYN-EJ-L3"])
  assert.equal(multi.isMulti, true)
})

test("a clean scan is saved once, a retry with the same key is idempotent, and a second scan is refused", { skip }, async () => {
  const shipment = await found(TRACK.scan, "Myntra EJ")
  const key = `${KEY_PREFIX}-CLEAN`
  const items = shipment.items.map((item) => ({
    itemId: item.itemId,
    receivedQty: item.expectedQty,
    verified: true,
    issues: [],
  }))
  const first = await recordScan(pool, actor, { submission: submission(shipment.shipmentId, key, items), photoCount: 2, hasVideo: false })
  assert.equal(first.replayed, false)
  assert.equal(first.itemCount, 1)
  assert.equal(first.issueCount, 0)
  assert.equal(first.scan.status, "Clear")

  const retry = await recordScan(pool, actor, { submission: submission(shipment.shipmentId, key, items), photoCount: 2, hasVideo: false })
  assert.equal(retry.replayed, true)
  assert.equal(retry.scan.id, first.scan.id)
  assert.equal(await countScans(shipment.shipmentId), 1, "a retry must not create a second scan")

  const second = await expectError(
    recordScan(pool, actor, { submission: submission(shipment.shipmentId, `${KEY_PREFIX}-OTHER`, items), photoCount: 0, hasVideo: false }),
    409,
    /already been received/,
  )
  assert.equal(second.extra.scannedBy, "SYN Scanner")

  const looked = await lookupShipment(pool, { tracking: TRACK.scan, marketplace: "Myntra EJ", shipmentId: null })
  assert.equal(looked.status, "duplicate")
})

test("concurrent saves of one return: exactly one scan is kept, and the other save is refused", { skip }, async () => {
  const shipment = await found(TRACK.concurrent, "Myntra EJ")
  const items = shipment.items.map((item) => ({ itemId: item.itemId, receivedQty: item.expectedQty, verified: true, issues: [] }))
  const results = await Promise.allSettled([
    recordScan(pool, actor, { submission: submission(shipment.shipmentId, `${KEY_PREFIX}-RACE-A`, items), photoCount: 0, hasVideo: false }),
    recordScan(pool, actor, { submission: submission(shipment.shipmentId, `${KEY_PREFIX}-RACE-B`, items), photoCount: 0, hasVideo: false }),
  ])
  const saved = results.filter((result) => result.status === "fulfilled")
  const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  assert.equal(saved.length, 1, "exactly one concurrent save may succeed")
  assert.equal(refused.length, 1)
  const reason: unknown = refused[0].reason
  assert.ok(reason instanceof ServiceError && reason.status === 409, "the other save must be a 409")
  assert.equal(await countScans(shipment.shipmentId), 1)
})

test("a partly received return needs a sub-issue for the missing unit, and then saves with a ticket", { skip }, async () => {
  const shipment = await found(TRACK.multi, "Myntra EJ")
  const [lineOne, lineTwo] = shipment.items
  const refused: unknown = await recordScan(pool, actor, {
    submission: submission(shipment.shipmentId, `${KEY_PREFIX}-PARTIAL-1`, [
      { itemId: lineOne.itemId, receivedQty: 1, verified: true, issues: [] },
      {
        itemId: lineTwo.itemId,
        receivedQty: 1,
        verified: true,
        issues: [{ categoryCode: "missing_component", subIssueId: null, qty: 1, ticketCode: "", notes: "" }],
      },
    ]),
    photoCount: 1,
    hasVideo: true,
  }).catch((error: unknown) => error)
  assert.ok(refused instanceof ServiceError)
  assert.equal(refused.status, 400)
  assert.ok(refused.details.some((detail) => detail.includes("choose what is missing")))
  assert.equal(await countScans(shipment.shipmentId), 0, "a refused save must leave nothing behind")

  const sub = await pool.query(
    `INSERT INTO missing_component_options (label, active, sort_order, category_code)
     VALUES ($1, true, 900, 'missing_component') RETURNING id`,
    [`SYN-SUB-${run}`],
  )
  const subId = Number(sub.rows[0].id)
  const saved = await recordScan(pool, actor, {
    submission: submission(shipment.shipmentId, `${KEY_PREFIX}-PARTIAL-2`, [
      { itemId: lineOne.itemId, receivedQty: 1, verified: true, issues: [] },
      {
        itemId: lineTwo.itemId,
        receivedQty: 1,
        verified: true,
        issues: [{ categoryCode: "missing_component", subIssueId: subId, qty: 1, ticketCode: `SYN-${run}-TKT-P`, notes: "SYN note" }],
      },
    ]),
    photoCount: 1,
    hasVideo: true,
  })
  assert.equal(saved.scan.status, "Raised")
  assert.equal(saved.issueCount, 1)

  const register = await listRegister(pool, { tracking: TRACK.multi }, 1, 50)
  assert.equal(register.total, 2)
  const missingLine = register.rows.find((line) => line.expectedQty === 2)
  assert.ok(missingLine, "the register must show the line with the missing unit")
  assert.equal(missingLine.receivedQty, 1)
  assert.equal(missingLine.issues[0].subIssueLabel, `SYN-SUB-${run}`)
  assert.equal(missingLine.issues[0].ticket?.code, `SYN-${run}-TKT-P`)
  assert.equal(missingLine.issues[0].ticket?.status, "Raised")
})

test("a ticket is created with its first history row, a rejection needs a reason, and a used ticket cannot be reused", { skip }, async () => {
  const shipment = await found(TRACK.shared, "Myntra VB")
  const ticketCode = `SYN-${run}-TKT-V`
  // One unit, received, with a damaged issue that needs a ticket. Every unit is accounted for, so this must save.
  const saved = await recordScan(pool, actor, {
    submission: submission(shipment.shipmentId, `${KEY_PREFIX}-VB-DAMAGED`, [
      {
        itemId: shipment.items[0].itemId,
        receivedQty: 1,
        verified: true,
        issues: [{ categoryCode: "damaged_product", subIssueId: null, qty: 1, ticketCode, notes: "" }],
      },
    ]),
    photoCount: 0,
    hasVideo: false,
  })
  assert.equal(saved.scan.status, "Raised")
  const ticket = await pool.query("SELECT id, status FROM claim_tickets WHERE ticket_code = $1", [ticketCode])
  assert.equal(ticket.rows[0].status, "Raised")
  const ticketId = Number(ticket.rows[0].id)

  // The same ticket on another return in the same account is refused: the ticket is already in the register.
  const ejShipment = await found(TRACK.shared, "Myntra EJ")
  const reuse = await expectError(
    recordScan(pool, actor, {
      submission: submission(ejShipment.shipmentId, `${KEY_PREFIX}-EJ-REUSE`, [
        {
          itemId: ejShipment.items[0].itemId,
          receivedQty: 1,
          verified: true,
          issues: [{ categoryCode: "damaged_product", subIssueId: null, qty: 1, ticketCode, notes: "" }],
        },
      ]),
      photoCount: 0,
      hasVideo: false,
    }),
    409,
    /already recorded/,
  )
  assert.ok(reuse.message.includes(ticketCode))

  await expectError(updateTicketStatus(pool, actor, ticketId, "Rejected", "   "), 400, /rejection reason is required/)
  const rejected = await updateTicketStatus(pool, actor, ticketId, "Rejected", "SYN photo does not match the order")
  assert.equal(rejected.status, "Rejected")
  assert.equal(rejected.rejectionReason, "SYN photo does not match the order")

  const history = await ticketHistory(pool, ticketId)
  assert.deepEqual(history.map((entry) => entry.toStatus), ["Raised", "Rejected"])
  assert.equal(history[1].reason, "SYN photo does not match the order")
})

test("invalid lookup references are refused and nothing is written", { skip }, async () => {
  // Myntra EJ TRACK.shared has not been scanned, so it is the right return to test the references against.
  const shipment = await found(TRACK.shared, "Myntra EJ")
  const before = await pool.query("SELECT COUNT(*)::int AS n FROM receipt_scans")
  const unknownItem = await expectError(
    recordScan(pool, actor, {
      submission: submission(shipment.shipmentId, `${KEY_PREFIX}-BAD-ITEM`, [{ itemId: 999999999, receivedQty: 1, verified: true, issues: [] }]),
      photoCount: 0,
      hasVideo: false,
    }),
    400,
    /Fix the items/,
  )
  assert.ok(unknownItem.details.some((detail) => detail.includes("does not belong to this return")))

  await expectError(
    recordScan(pool, actor, {
      submission: submission(999999999, `${KEY_PREFIX}-NO-SHIPMENT`, [{ itemId: 1, receivedQty: 1, verified: true, issues: [] }]),
      photoCount: 0,
      hasVideo: false,
    }),
    409,
    /no longer in the active lookup data/,
  )
  const after = await pool.query("SELECT COUNT(*)::int AS n FROM receipt_scans")
  assert.equal(after.rows[0].n, before.rows[0].n, "refused saves must not change the scan history")
})

test("a new upload replaces only its own account's active lookup data, and the scan history stays", { skip }, async () => {
  const scanned = await pool.query("SELECT er.id AS shipment_id FROM expected_returns er WHERE er.tracking_id = $1 ORDER BY er.id", [TRACK.scan])
  const scannedShipment = Number(scanned.rows[0].shipment_id)

  // Second Myntra EJ file. It leaves out TRACK.gone, adds a fresh AWB that carries an FSN, and keeps the rest.
  const second = await upload(
    "Myntra EJ",
    [
      row({ trackingId: TRACK.scan, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-D", sku: "SYN-EJ-D", orderLineId: "SYN-EJ-L4", qty: 2 }),
      row({ trackingId: TRACK.multi, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-B", sku: "SYN-EJ-B", orderLineId: "SYN-EJ-L2" }),
      row({ trackingId: TRACK.multi, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-C", sku: "SYN-EJ-C", orderLineId: "SYN-EJ-L3", qty: 2 }),
      row({
        trackingId: TRACK.fresh,
        marketplace: "Myntra EJ",
        channelListingId: "SYN-EJ-G",
        sku: "SYN-EJ-G",
        orderLineId: "SYN-EJ-L7",
        raw: { fsn: "SYN-FSN-1" },
      }),
      row({ trackingId: TRACK.concurrent, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-F", sku: "SYN-EJ-F", orderLineId: "SYN-EJ-L6" }),
    ],
    "EJ-3",
  )
  assert.ok(second.supersededRows >= 4, "the earlier active rows are superseded, not deleted")

  const gone = await lookupShipment(pool, { tracking: TRACK.gone, marketplace: "Myntra EJ", shipmentId: null })
  assert.equal(gone.status, "not_found", "an AWB left out of the new file is no longer available")

  const fresh = await found(TRACK.fresh, "Myntra EJ")
  assert.equal(fresh.items[0].marketplaceSkuIdentifier, "SYN-FSN-1")

  const supersededGone = await pool.query(
    "SELECT id FROM expected_returns WHERE tracking_id = $1 AND lookup_status = 'superseded' ORDER BY id DESC LIMIT 1",
    [TRACK.gone],
  )
  await expectError(
    recordScan(pool, actor, {
      submission: submission(Number(supersededGone.rows[0].id), `${KEY_PREFIX}-SUPERSEDED`, [{ itemId: 1, receivedQty: 1, verified: true, issues: [] }]),
      photoCount: 0,
      hasVideo: false,
    }),
    409,
    /no longer in the active lookup data/,
  )

  // The scan made before the replacement is still in the register, with its own snapshot.
  const history = await listRegister(pool, { tracking: TRACK.scan }, 1, 50)
  assert.ok(history.total >= 1)
  assert.ok(history.rows.every((line) => line.trackingId === TRACK.scan))
  const snapshot = await pool.query("SELECT tracking_id_snapshot FROM receipt_scans WHERE expected_return_id = $1", [scannedShipment])
  assert.equal(snapshot.rows[0].tracking_id_snapshot, TRACK.scan)
})

test("a failed upload rolls back, and the previous active lookup data stays in place", { skip }, async () => {
  const before = await found(TRACK.fresh, "Myntra EJ")
  await assert.rejects(
    upload(
      "Myntra EJ",
      [row({ trackingId: `SYN-${run}-BROKEN`, marketplace: "Myntra EJ", channelListingId: "SYN-EJ-X", sku: "SYN-EJ-X", orderLineId: "SYN-EJ-LX", qty: 0 })],
      "EJ-BROKEN",
    ),
  )
  const after = await found(TRACK.fresh, "Myntra EJ")
  assert.equal(after.shipmentId, before.shipmentId, "the active row must be the same one as before the failed upload")
  const broken = await pool.query("SELECT COUNT(*)::int AS n FROM expected_returns WHERE tracking_id = $1", [`SYN-${run}-BROKEN`])
  assert.equal(broken.rows[0].n, 0, "nothing from the failed upload may remain")
  const staged = await pool.query("SELECT COUNT(*)::int AS n FROM expected_returns WHERE lookup_status = 'staging'")
  assert.equal(staged.rows[0].n, 0, "no staging rows may be left behind")
})

test("the register lists item rows with their issues, and the export matches the filters", { skip }, async () => {
  const marketplace = await pool.query("SELECT id FROM marketplaces WHERE name = 'Myntra EJ'")
  const list = await listRegister(pool, { marketplaceId: Number(marketplace.rows[0].id), scannerId: actor.id }, 1, 200)
  assert.ok(list.total >= 3)
  assert.ok(list.rows.every((line) => line.scannedBy === "SYN Scanner"))
  assert.ok(list.rows.some((line) => line.issues.length > 0), "the partly received return must show its issue")

  const csv = await exportRegister(pool, { tracking: TRACK.multi })
  const lines = csv.trimEnd().split("\n")
  assert.equal(lines.length, 3, "one header and two item rows for the multi-line return")
  assert.match(lines[0], /"Return Received Sub Issue"/)
  assert.ok(csv.includes(`"SYN-${run}-TKT-P"`))
})

test("persistence: a new connection and a second schema run keep every scan", { skip }, async () => {
  const before = await listRegister(pool, { tracking: TRACK.multi }, 1, 50)
  await pool.end()
  const settings = connectionSettingsFor(rawUrl)
  pool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000 })
  await applySchema(pool)
  const after = await listRegister(pool, { tracking: TRACK.multi }, 1, 50)
  assert.equal(after.total, before.total)
  assert.deepEqual(after.rows.map((line) => line.scanId), before.rows.map((line) => line.scanId))
})
