// Database checks for account access and scan history. They run only when TEST_DATABASE_URL is set to a dedicated test
// database whose name contains "test". Otherwise every check is skipped. Nothing here uses real data: every value starts
// with SYN, and every run uses its own uppercase suffix, so a rerun does not collide with an earlier one.
//
// What these checks cover, in order (later checks build on the data of earlier ones):
//  - applySchema runs twice without error, so it is safe on every start.
//  - A user sees only the accounts assigned to them. An Admin sees every account. A user with no assignment sees nothing.
//  - A named account the user cannot see is refused with 403. A return the user cannot see is reported as not found.
//  - The register, its export and the dashboard figures never include another account's rows.
//  - Several items on one AWB are saved as one scan with one verified line per item.
//  - A repeated save with the same key returns the first scan. A second scan of the same AWB is refused.
//  - A scan keeps its snapshot after its lookup data is replaced, and it is still there after a reconnect.

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import pg from "pg"
import { NO_ACCOUNTS, scopeFor, type AccountScope } from "../access.js"
import { loadHeadline } from "../dashboard.js"
import { applySchema, connectionSettingsFor, openPool } from "../db.js"
import { commitLookupUpload, type ProductSource } from "../lookup-import.js"
import { ensureReferenceData } from "../reference-data.js"
import {
  ServiceError,
  accessibleAccounts,
  exportRegisterRows,
  listRegister,
  lookupShipment,
  recordScan,
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
// Uppercase, because the import and the lookup both upper-case a tracking ID. A lowercase suffix would never match.
const run = Date.now().toString(36).toUpperCase()

const AWB = {
  ej: `SYN-${run}-EJ`,
  ejNext: `SYN-${run}-EJ2`,
  vb: `SYN-${run}-VB`,
  shared: `SYN-${run}-SHARED`,
}

let pool: pg.Pool
let admin: Actor
let ejUser: Actor
let noneUser: Actor
let adminScope: AccountScope
let ejScope: AccountScope
let noneScope: AccountScope
let ejId = 0

function row(overrides: Partial<ParsedRow>): ParsedRow {
  return {
    trackingId: "",
    altTrackingId: "",
    orderId: `SYN-${run}-ORDER`,
    orderLineId: `SYN-${run}-LINE`,
    channelListingId: `SYN-${run}-LISTING`,
    channelSku: `SYN-${run}-LISTING`,
    sku: `SYN-${run}-LISTING`,
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

async function upload(marketplace: string, rows: ParsedRow[], label: string) {
  return commitLookupUpload(pool, {
    marketplaceName: marketplace,
    filename: `SYN-${label}-${run}.csv`,
    uploadedBy: admin.id,
    uploadedLabel: label,
    rows,
    images: new Map(),
    sources: new Map<string, ProductSource>(),
  })
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

// The scope a user gets at sign-in: the same rule as requireUser in server/index.ts, read from the database.
async function scopeOf(userId: number): Promise<AccountScope> {
  const result = await pool.query(
    `SELECT u.role, u.has_all_marketplaces,
            ARRAY(SELECT um.marketplace_id FROM user_marketplaces um WHERE um.user_id = u.id) AS ids
     FROM users u
     WHERE u.id = $1`,
    [userId],
  )
  const found = result.rows[0]
  return scopeFor({
    role: String(found.role),
    hasAllMarketplaces: Boolean(found.has_all_marketplaces),
    marketplaceIds: (found.ids ?? []) as number[],
  })
}

async function makeUser(label: string, role: string, hasAll: boolean, marketplaceNames: string[]): Promise<Actor> {
  const inserted = await pool.query(
    `INSERT INTO users (initials, name, email, password_hash, role, sidebar_label, has_all_marketplaces)
     VALUES ('SY', $1, $2, 'SYN-HASH', $3, $3, $4)
     RETURNING id`,
    [`SYN ${label} ${run}`, `syn-${label}-${run}@example.test`, role, hasAll],
  )
  const id = Number(inserted.rows[0].id)
  for (const name of marketplaceNames) {
    await pool.query(
      "INSERT INTO user_marketplaces (user_id, marketplace_id) SELECT $1, id FROM marketplaces WHERE name = $2",
      [id, name],
    )
  }
  return { id, name: `SYN ${label} ${run}` }
}

// The item lines of a lookup row, in the order the register shows them.
async function itemIdsOf(expectedReturnId: number): Promise<number[]> {
  const result = await pool.query(
    "SELECT id FROM expected_return_items WHERE expected_return_id = $1 ORDER BY sort_order, id",
    [expectedReturnId],
  )
  return result.rows.map((item) => Number(item.id))
}

// The active lookup row of an AWB in the Myntra EJ account. Used where a save needs the lookup row's id.
async function activeEjShipmentId(tracking: string): Promise<number> {
  const result = await pool.query(
    `SELECT er.id
     FROM expected_returns er
     JOIN marketplaces m ON m.id = er.marketplace_id
     WHERE er.tracking_id = $1 AND er.lookup_status = 'active' AND m.name = 'Myntra EJ'`,
    [tracking],
  )
  assert.ok(result.rows[0], `no active Myntra EJ lookup row for ${tracking}`)
  return Number(result.rows[0].id)
}

async function countScansFor(marketplaceId: number | null): Promise<number> {
  const result =
    marketplaceId === null
      ? await pool.query("SELECT COUNT(*)::int AS n FROM receipt_scans")
      : await pool.query(
          `SELECT COUNT(*)::int AS n
           FROM receipt_scans rs
           JOIN expected_returns er ON er.id = rs.expected_return_id
           WHERE er.marketplace_id = $1`,
          [marketplaceId],
        )
  return Number(result.rows[0].n)
}

// These checks exercise the ticket rules. Production switches the ticket requirement off at the bench on every start
// (schema-import.sql), so a ticket check turns it back on in the test database first. A later schema run turns it off.
async function ticketRulesOn(): Promise<void> {
  await pool.query(
    "UPDATE receipt_issue_categories SET requires_ticket = true WHERE code IN ('missing_component', 'wrong_product', 'damaged_product')",
  )
}

before(async () => {
  if (skip) return
  const settings = connectionSettingsFor(rawUrl)
  pool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000 })
  await applySchema(pool)
  await ensureReferenceData(pool)
  admin = await makeUser("admin", "Admin", false, [])
  ejUser = await makeUser("ej", "Scanner", false, ["Myntra EJ"])
  noneUser = await makeUser("none", "Scanner", false, [])
  adminScope = await scopeOf(admin.id)
  ejScope = await scopeOf(ejUser.id)
  noneScope = await scopeOf(noneUser.id)
  const accounts = await pool.query("SELECT id, name FROM marketplaces WHERE name = 'Myntra EJ'")
  ejId = Number(accounts.rows[0].id)
  // Myntra EJ: two lines for one AWB (several products on one AWB) and one AWB that is also in Myntra VB.
  await upload(
    "Myntra EJ",
    [
      row({ trackingId: AWB.ej, marketplace: "Myntra EJ", channelListingId: `SYN-${run}-EJ-A`, orderLineId: `SYN-${run}-EJ-L1` }),
      row({ trackingId: AWB.ej, marketplace: "Myntra EJ", channelListingId: `SYN-${run}-EJ-B`, orderLineId: `SYN-${run}-EJ-L2` }),
      row({ trackingId: AWB.shared, marketplace: "Myntra EJ", channelListingId: `SYN-${run}-EJ-C`, orderLineId: `SYN-${run}-EJ-L3` }),
    ],
    "EJ-1",
  )
  // Myntra VB: one line, and the shared AWB.
  await upload(
    "Myntra VB",
    [
      row({ trackingId: AWB.vb, marketplace: "Myntra VB", channelListingId: `SYN-${run}-VB-A`, orderLineId: `SYN-${run}-VB-L1` }),
      row({ trackingId: AWB.shared, marketplace: "Myntra VB", channelListingId: `SYN-${run}-VB-B`, orderLineId: `SYN-${run}-VB-L2` }),
    ],
    "VB-1",
  )
})

after(async () => {
  if (pool) await pool.end()
})

test("applySchema runs twice without error, so it is safe on every start", { skip: skip || false }, async () => {
  await applySchema(pool)
  await applySchema(pool)
})

test("a user sees only the accounts assigned to them; an Admin sees all; no assignment means none", { skip: skip || false }, async () => {
  const everything = (await accessibleAccounts(pool, adminScope)).map((account) => account.name)
  assert.ok(everything.includes("Myntra EJ") && everything.includes("Myntra VB"))
  assert.deepEqual((await accessibleAccounts(pool, ejScope)).map((account) => account.name), ["Myntra EJ"])
  assert.deepEqual(await accessibleAccounts(pool, noneScope), [])
  assert.deepEqual(await accessibleAccounts(pool, NO_ACCOUNTS), [])
})

test("a named account outside the user's scope is refused with 403", { skip: skip || false }, async () => {
  await expectError(
    lookupShipment(pool, { tracking: AWB.vb, marketplace: "Myntra VB", shipmentId: null }, ejScope),
    403,
    /access/,
  )
})

test("an AWB outside the user's scope is not found, and no other account is named", { skip: skip || false }, async () => {
  const result = await lookupShipment(pool, { tracking: AWB.vb, marketplace: "Auto detect", shipmentId: null }, ejScope)
  assert.equal(result.status, "not_found")
})

test("the Admin finds the same AWB in its own account", { skip: skip || false }, async () => {
  const result = await lookupShipment(pool, { tracking: AWB.vb, marketplace: "Auto detect", shipmentId: null }, adminScope)
  assert.equal(result.status, "found")
  if (result.status !== "found") return
  assert.equal(result.shipment.marketplace, "Myntra VB")
})

test("a shared AWB in two accounts is a choice for an Admin, and a single match for a restricted user", { skip: skip || false }, async () => {
  const forAdmin = await lookupShipment(pool, { tracking: AWB.shared, marketplace: "Auto detect", shipmentId: null }, adminScope)
  assert.equal(forAdmin.status, "choose")
  const forEj = await lookupShipment(pool, { tracking: AWB.shared, marketplace: "Auto detect", shipmentId: null }, ejScope)
  assert.equal(forEj.status, "found")
  if (forEj.status !== "found") return
  assert.equal(forEj.shipment.marketplace, "Myntra EJ")
})

test("a restricted user cannot save a scan for another account's return (404, nothing saved)", { skip: skip || false }, async () => {
  const vb = await lookupShipment(pool, { tracking: AWB.vb, marketplace: "Auto detect", shipmentId: null }, adminScope)
  assert.equal(vb.status, "found")
  if (vb.status !== "found") return
  const key = `SYN-${run}-DENIED`
  const submission: ScanSubmission = { shipmentId: vb.shipment.shipmentId, clientScanKey: key, notes: "", items: [] }
  await expectError(recordScan(pool, ejUser, { submission, photoCount: 0, hasVideo: false }, ejScope), 404, /not found/i)
  const saved = await pool.query("SELECT COUNT(*)::int AS n FROM receipt_scans WHERE client_scan_key = $1", [key])
  assert.equal(Number(saved.rows[0].n), 0)
})

test("several items on one AWB are one scan with one verified line per item, and the scanned AWB is kept", { skip: skip || false }, async () => {
  const shipment = await lookupShipment(pool, { tracking: AWB.ej, marketplace: "Myntra EJ", shipmentId: null }, ejScope)
  assert.equal(shipment.status, "found")
  if (shipment.status !== "found") return
  const items = await itemIdsOf(shipment.shipment.shipmentId)
  assert.equal(items.length, 2, "the synthetic AWB has two lines")
  const receipt = await recordScan(
    pool,
    ejUser,
    {
      submission: {
        shipmentId: shipment.shipment.shipmentId,
        clientScanKey: `SYN-${run}-SCAN-1`,
        notes: "",
        scannedTracking: AWB.ej,
        items: items.map((itemId) => ({ itemId, receivedQty: 1, verified: true, issues: [] })),
      },
      photoCount: 0,
      hasVideo: false,
    },
    ejScope,
  )
  assert.equal(receipt.replayed, false)
  assert.equal(receipt.itemCount, 2)
  assert.equal(receipt.scan.scannedTracking, AWB.ej)
  assert.equal(receipt.scan.matchedTrackingField, "tracking_id")
  assert.equal(receipt.scan.sourceFile, `SYN-EJ-1-${run}.csv`)
  assert.notEqual(receipt.scan.sourceBatchId, null)
  const lines = await pool.query("SELECT COUNT(*)::int AS n FROM receipt_scan_items WHERE receipt_scan_id = $1", [receipt.scan.id])
  assert.equal(Number(lines.rows[0].n), 2)
})

test("a repeated save with the same key returns the first scan, and a second scan of the AWB is refused", { skip: skip || false }, async () => {
  const lookup = await lookupShipment(pool, { tracking: AWB.ej, marketplace: "Myntra EJ", shipmentId: null }, ejScope)
  assert.equal(lookup.status, "duplicate", "a received AWB is reported as a duplicate, never as found")
  const shipmentId = await activeEjShipmentId(AWB.ej)
  const earlier = await pool.query("SELECT id FROM receipt_scans WHERE client_scan_key = $1", [`SYN-${run}-SCAN-1`])
  assert.equal(earlier.rows.length, 1)
  const again = await recordScan(
    pool,
    ejUser,
    { submission: { shipmentId, clientScanKey: `SYN-${run}-SCAN-1`, notes: "", items: [] }, photoCount: 0, hasVideo: false },
    ejScope,
  )
  assert.equal(again.replayed, true)
  assert.equal(again.scan.id, Number(earlier.rows[0].id))
  await expectError(
    recordScan(
      pool,
      ejUser,
      { submission: { shipmentId, clientScanKey: `SYN-${run}-SCAN-2`, notes: "", items: [] }, photoCount: 0, hasVideo: false },
      ejScope,
    ),
    409,
    /already been received/,
  )
})

test("a wrong-product issue opens a ticket; a restricted user cannot change it, the Admin can", { skip: skip || false }, async () => {
  await ticketRulesOn()
  const vb = await lookupShipment(pool, { tracking: AWB.vb, marketplace: "Auto detect", shipmentId: null }, adminScope)
  assert.equal(vb.status, "found")
  if (vb.status !== "found") return
  const items = await itemIdsOf(vb.shipment.shipmentId)
  const ticketCode = `SYN-${run}-TKT`
  await recordScan(
    pool,
    admin,
    {
      submission: {
        shipmentId: vb.shipment.shipmentId,
        clientScanKey: `SYN-${run}-VB-SCAN`,
        notes: "",
        scannedTracking: AWB.vb,
        items: items.map((itemId) => ({
          itemId,
          receivedQty: 1,
          verified: true,
          issues: [{ categoryCode: "wrong_product", subIssueId: null, qty: 1, ticketCode, notes: "" }],
        })),
      },
      photoCount: 0,
      hasVideo: false,
    },
    adminScope,
  )
  const ticket = await pool.query("SELECT id FROM claim_tickets WHERE ticket_code = $1", [ticketCode])
  assert.equal(ticket.rows.length, 1)
  const ticketId = Number(ticket.rows[0].id)
  await expectError(updateTicketStatus(pool, ejUser, ticketId, "Review", "", ejScope), 404, /does not exist/)
  const changed = await updateTicketStatus(pool, admin, ticketId, "Review", "", adminScope)
  assert.equal(changed.status, "Review")
})

test("the register and its export show only the accounts the user can see", { skip: skip || false }, async () => {
  const forEj = await listRegister(pool, {}, 1, 200, {}, ejScope)
  assert.ok(forEj.rows.length > 0)
  assert.ok(forEj.rows.every((line) => line.marketplace === "Myntra EJ"), "no other account in the register")
  const exported = await exportRegisterRows(pool, {}, ejScope)
  assert.ok(exported.every((line) => line.marketplace === "Myntra EJ"), "no other account in the export")
  const forAdmin = await listRegister(pool, {}, 1, 200, {}, adminScope)
  assert.ok(forAdmin.rows.some((line) => line.marketplace === "Myntra VB"), "the Admin sees Myntra VB")
  assert.equal((await exportRegisterRows(pool, {}, NO_ACCOUNTS)).length, 0)
})

test("the dashboard figures count only the accounts the user can see", { skip: skip || false }, async () => {
  assert.equal((await loadHeadline(pool, ejScope)).received, await countScansFor(ejId))
  assert.equal((await loadHeadline(pool, adminScope)).received, await countScansFor(null))
  assert.equal((await loadHeadline(pool, noneScope)).received, 0)
})

test("a saved scan keeps its snapshot after its lookup data is replaced, and survives a reconnect", { skip: skip || false }, async () => {
  const beforeReplace = await listRegister(pool, { tracking: AWB.ej }, 1, 50, {}, ejScope)
  assert.equal(beforeReplace.rows.length, 2, "both lines of the scan are listed")
  // Myntra EJ is uploaded again without the AWB. The old lookup row becomes superseded, and the scan stays.
  await upload(
    "Myntra EJ",
    [row({ trackingId: AWB.ejNext, marketplace: "Myntra EJ", channelListingId: `SYN-${run}-EJ-N`, orderLineId: `SYN-${run}-EJ-L9` })],
    "EJ-2",
  )
  const afterReplace = await listRegister(pool, { tracking: AWB.ej }, 1, 50, {}, ejScope)
  assert.equal(afterReplace.rows.length, beforeReplace.rows.length, "the register keeps the scan")
  assert.equal(afterReplace.rows[0].sourceFile, `SYN-EJ-1-${run}.csv`, "the source file is the one that supplied the scan")
  assert.equal(afterReplace.rows[0].scannedTracking, AWB.ej)
  const lookup = await lookupShipment(pool, { tracking: AWB.ej, marketplace: "Myntra EJ", shipmentId: null }, ejScope)
  assert.equal(lookup.status, "duplicate", "a received AWB stays a duplicate after its lookup row is replaced")

  const fresh = openPool(rawUrl)
  try {
    const reconnected = await listRegister(fresh, { tracking: AWB.ej }, 1, 50, {}, ejScope)
    assert.equal(reconnected.rows.length, beforeReplace.rows.length, "the scan is still there after a reconnect")
    assert.equal(reconnected.rows[0].scannedTracking, AWB.ej)
  } finally {
    await fresh.end()
  }
})
