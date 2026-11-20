// Evidence uploads on one claim must run one after another. The Android client now uploads each evidence file as
// its own background job, so the last two required files can reach addClaimMedia at the same moment. Under READ
// COMMITTED each transaction saw only its own new claim_media row, both found the evidence incomplete, and a claim
// with every required file stayed in pending_evidence with nothing to move it on. addClaimMedia and
// deactivateClaimMedia now lock the scoped claim row (SELECT ... FOR UPDATE) before they write.
//
// The fake-pool checks always run. The database check runs only when TEST_DATABASE_URL points to a dedicated
// database whose name contains "test"; otherwise it is skipped. Every value starts with SYN.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import pg from "pg"
import { applySchema, connectionSettingsFor } from "../db.js"
import { ensureReferenceData } from "../reference-data.js"
import { addClaimMedia, deactivateClaimMedia } from "../claims-service.js"
import { ServiceError, type Actor } from "../register-service.js"
import type { AccountScope } from "../access.js"

type Captured = { sql: string; params: unknown[] }

function fakePool(claimVisible: boolean): { pool: pg.Pool; queries: Captured[] } {
  const queries: Captured[] = []
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      if (sql.includes("FROM claims c WHERE c.id = $1")) {
        return { rows: claimVisible ? [{ id: 5, marketplace_id: 3 }] : [], rowCount: claimVisible ? 1 : 0 }
      }
      if (sql.includes("INSERT INTO claim_media")) return { rows: [{ id: 11 }], rowCount: 1 }
      if (sql.includes("UPDATE claim_media")) return { rows: [{ id: 11, marketplace_id: 3 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
    release: () => undefined,
  }
  return { pool: { connect: async () => client } as unknown as pg.Pool, queries }
}

const FAKE_ACTOR = { id: 1, name: "SYN actor" } as Actor
const FAKE_SCOPE: AccountScope = { all: false, marketplaceIds: [3] }
const FAKE_MEDIA = {
  fieldKey: "product_images",
  storageObjectPath: "SYN/claims/5/a.jpg",
  contentHash: "SYN-HASH-A",
  sizeBytes: 10,
  mimeType: "image/jpeg",
  originalFilename: "SYN-a.jpg",
  capturedAt: null,
}

function indexOf(queries: Captured[], fragment: string): number {
  return queries.findIndex((q) => q.sql.includes(fragment))
}

test("addClaimMedia locks the scoped claim row before it inserts the media", async () => {
  const { pool, queries } = fakePool(true)
  const result = await addClaimMedia(pool, FAKE_ACTOR, FAKE_SCOPE, 5, FAKE_MEDIA)
  assert.deepEqual(result, { id: 11, marketplaceId: 3 })
  const lock = indexOf(queries, "FROM claims c WHERE c.id = $1")
  assert.ok(lock > 0, "expected a claim read inside the transaction")
  assert.match(queries[lock].sql, /FOR UPDATE$/)
  assert.match(queries[lock].sql, /c\.marketplace_id = ANY\(\$2::integer\[\]\)/)
  assert.deepEqual(queries[lock].params, [5, [3]])
  assert.ok(lock < indexOf(queries, "INSERT INTO claim_media"), "the lock must come before the insert")
})

test("addClaimMedia on a claim outside the scope is 404 and writes nothing", async () => {
  const { pool, queries } = fakePool(false)
  await assert.rejects(addClaimMedia(pool, FAKE_ACTOR, FAKE_SCOPE, 5, FAKE_MEDIA), (err) => err instanceof ServiceError && err.status === 404)
  assert.equal(indexOf(queries, "INSERT INTO claim_media"), -1)
  assert.ok(queries.some((q) => q.sql === "ROLLBACK"))
})

test("deactivateClaimMedia locks the scoped claim row before it switches the media off", async () => {
  const { pool, queries } = fakePool(true)
  await deactivateClaimMedia(pool, FAKE_ACTOR, FAKE_SCOPE, 5, 11)
  const lock = indexOf(queries, "FROM claims c WHERE c.id = $1")
  assert.ok(lock > 0, "expected a claim lock inside the transaction")
  assert.match(queries[lock].sql, /FOR UPDATE$/)
  assert.deepEqual(queries[lock].params, [5, [3]])
  assert.ok(lock < indexOf(queries, "UPDATE claim_media"), "the lock must come before the update")
})

test("deactivateClaimMedia on a claim outside the scope is 404 and writes nothing", async () => {
  const { pool, queries } = fakePool(false)
  await assert.rejects(deactivateClaimMedia(pool, FAKE_ACTOR, FAKE_SCOPE, 5, 11), (err) => err instanceof ServiceError && err.status === 404)
  assert.equal(indexOf(queries, "UPDATE claim_media"), -1)
})

// ---- Real PostgreSQL ----

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
const raceApp = `SYN-media-race-${run}`
const scope: AccountScope = { all: true }

let pool: pg.Pool
let racePool: pg.Pool
let actor: Actor
let meeshoId = 0

before(async () => {
  if (skip) return
  const settings = connectionSettingsFor(rawUrl)
  pool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000 })
  // The uploads run on their own pool, named so the test can see exactly when both of them are waiting on a lock.
  racePool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000, application_name: raceApp })
  await applySchema(pool)
  await ensureReferenceData(pool)
  meeshoId = Number((await pool.query(`SELECT id FROM marketplaces WHERE name = 'Meesho'`)).rows[0].id)
  const user = await pool.query(
    `INSERT INTO users (initials, name, email, password_hash, role, sidebar_label, has_all_marketplaces)
     VALUES ('SM', $1, $2, 'SYN-HASH', 'Supervisor', 'Supervisor', true) RETURNING id`,
    [`SYN media race ${run}`, `syn-media-race-${run}@example.test`],
  )
  actor = { id: Number(user.rows[0].id), name: `SYN media race ${run}` } as Actor
})

after(async () => {
  if (racePool) await racePool.end()
  if (pool) await pool.end()
})

// A pending_evidence claim on its own inactive template (so no other claim picks it up) that requires one product
// image and one unboxing video.
async function makePendingClaim(label: string): Promise<number> {
  const template = await pool.query(
    `INSERT INTO claim_templates (marketplace_id, name, is_active) VALUES (NULL, $1, false) RETURNING id`,
    [`SYN-${run}-${label} template`],
  )
  const templateId = Number(template.rows[0].id)
  await pool.query(
    `INSERT INTO claim_template_fields (template_id, field_key, field_label, field_type, required, min_count, max_count, sort_order)
     VALUES ($1, 'product_images', 'SYN product images', 'image', true, 1, 10, 1),
            ($1, 'unboxing_video', 'SYN unboxing video', 'video', true, 1, 1, 2)`,
    [templateId],
  )
  const courier = await pool.query(`INSERT INTO couriers (name) VALUES ($1) RETURNING id`, [`SYN-${run}-${label}-C`])
  const er = await pool.query(
    `INSERT INTO expected_returns (tracking_id, marketplace_id, order_number, courier_id, return_type, matched_from)
     VALUES ($1, $2, $3, $4, 'Customer Return', 'SYN') RETURNING id`,
    [`SYN-${run}-${label}-AWB`, meeshoId, `SYN-${run}-${label}-ORD`, Number(courier.rows[0].id)],
  )
  const scan = await pool.query(
    `INSERT INTO receipt_scans (expected_return_id, scanned_by, scanned_time_label, outcome, issue_label, status)
     VALUES ($1, $2, 'SYN', 'clear', '', 'Clear') RETURNING id`,
    [Number(er.rows[0].id), actor.id],
  )
  const claim = await pool.query(
    `INSERT INTO claims (receipt_scan_id, marketplace_id, claim_template_id, claim_reason, created_by, status)
     VALUES ($1, $2, $3, 'SYN damaged return', $4, 'pending_evidence') RETURNING id`,
    [Number(scan.rows[0].id), meeshoId, templateId, actor.id],
  )
  return Number(claim.rows[0].id)
}

function media(fieldKey: string, label: string) {
  return {
    fieldKey,
    storageObjectPath: `SYN/claims/${run}/${label}`,
    contentHash: `SYN-${run}-${label}`,
    sizeBytes: 1,
    mimeType: fieldKey === "unboxing_video" ? "video/mp4" : "image/jpeg",
    originalFilename: `SYN-${label}`,
    capturedAt: null,
  }
}

async function waitForLockWaiters(count: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const res = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`,
      [raceApp],
    )
    if (Number(res.rows[0].n) >= count) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`expected ${count} uploads waiting on a lock`)
}

test("db: the last two uploads finishing together still move the claim to ready_for_claim", { skip: skip || false }, async () => {
  const claimId = await makePendingClaim("RACE")
  // Hold the evidence-readiness query back so both uploads are in flight at once. Without the claim lock both would
  // insert their row and then wait here, and each would see only its own row once released.
  const blocker = await pool.connect()
  let holding = false
  let uploads: Promise<PromiseSettledResult<unknown>[]> | null = null
  try {
    await blocker.query("BEGIN")
    await blocker.query("LOCK TABLE claim_template_fields IN ACCESS EXCLUSIVE MODE")
    holding = true
    uploads = Promise.allSettled([
      addClaimMedia(racePool, actor, scope, claimId, media("product_images", "IMG")),
      addClaimMedia(racePool, actor, scope, claimId, media("unboxing_video", "VID")),
    ])
    await waitForLockWaiters(2)
    await blocker.query("COMMIT")
    holding = false
  } finally {
    if (holding) await blocker.query("ROLLBACK")
    blocker.release()
  }

  assert.ok(uploads)
  const results = await uploads
  for (const result of results) assert.equal(result.status, "fulfilled", String((result as PromiseRejectedResult).reason))
  const claim = await pool.query(`SELECT status FROM claims WHERE id = $1`, [claimId])
  assert.equal(claim.rows[0].status, "ready_for_claim")
  const history = await pool.query(
    `SELECT count(*)::int AS n FROM claim_status_history
     WHERE claim_id = $1 AND from_status = 'pending_evidence' AND to_status = 'ready_for_claim'`,
    [claimId],
  )
  assert.equal(Number(history.rows[0].n), 1)
})
