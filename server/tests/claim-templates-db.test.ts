// One claim template per marketplace (Phase 2 item 2.7, owner decision 2026-11-20).
// The schema-order check runs everywhere. The database checks run only when TEST_DATABASE_URL is set to a dedicated
// test database whose name contains "test"; otherwise they are skipped. Every value this file creates starts with SYN.
//
// What the database checks cover, against a real PostgreSQL:
//  - Myntra VB, Myntra EJ, Ajio and Flipkart resolve to the one 'Standard Claim Template' with the same five slots
//    (Flipkart's Unpacking Video is added last, after Attachments). The older 'Default claim template' is switched off
//    and kept with its fields.
//  - Amazon resolves to no template, and creating an Amazon claim is refused with 422 "not supported yet".
//  - A requested switched-off template falls back to the marketplace's one template.
//  - The claim return-lookup offers only that one template (active fields only), and none for Amazon.
//  - Meesho is unchanged: its 'Default claim template' with the five portal slots, and no Meesho template switched off.
//  - The switch-off only touches seeded rows: an Admin-edited template stays on and field rows are never changed.
//  - Re-applying the schema changes nothing, and a template an Admin turns back on stays on.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { SCHEMA_FILES, applySchema, connectionSettingsFor } from "../db.js"
import { ensureReferenceData } from "../reference-data.js"
import { createClaim, resolveClaimTemplateId, updateClaimTemplate } from "../claims-service.js"
import { lookupReturnForClaim } from "../claim-automation-service.js"
import { ServiceError, type Actor } from "../register-service.js"
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
const SWITCH_OFF = "claim_template.seed_switch_off"
const FIVE_SLOTS = ["product_images", "barcode_image", "reverse_waybill", "unboxing_video", "attachments"]
// The same five slots; Flipkart's seed had Attachments at sort 4, so its added Unpacking Video sorts last.
const FLIPKART_SLOTS = ["product_images", "barcode_image", "reverse_waybill", "attachments", "unboxing_video"]
const MEESHO_SLOTS = ["barcode_image", "product_images", "reverse_waybill", "unboxing_video", "attachments"]

let pool: pg.Pool
let admin: Actor

async function marketplaceId(name: string): Promise<number> {
  return Number((await pool.query(`SELECT id FROM marketplaces WHERE name = $1`, [name])).rows[0].id)
}

async function templateId(db: pg.Pool | pg.PoolClient, marketplace: number, name: string): Promise<number> {
  const res = await db.query(`SELECT id FROM claim_templates WHERE marketplace_id = $1 AND name = $2`, [marketplace, name])
  assert.equal(res.rows.length, 1, `one '${name}' row for marketplace ${marketplace}`)
  return Number(res.rows[0].id)
}

async function isActive(db: pg.Pool | pg.PoolClient, id: number): Promise<boolean> {
  return Boolean((await db.query(`SELECT is_active FROM claim_templates WHERE id = $1`, [id])).rows[0].is_active)
}

async function activeFieldKeys(id: number): Promise<string[]> {
  const res = await pool.query(
    `SELECT field_key FROM claim_template_fields WHERE template_id = $1 AND is_active = true ORDER BY sort_order, id`,
    [id],
  )
  return res.rows.map((r) => String(r.field_key))
}

async function switchOffAudits(db: pg.Pool | pg.PoolClient, id: number): Promise<number> {
  const res = await db.query(
    `SELECT count(*)::int AS n FROM register_audit_log
     WHERE action = $1 AND entity_type = 'claim_template' AND entity_id = $2`,
    [SWITCH_OFF, String(id)],
  )
  return Number(res.rows[0].n)
}

async function makeScan(label: string, marketplace: number): Promise<number> {
  const courier = await pool.query(`INSERT INTO couriers (name) VALUES ($1) RETURNING id`, [`SYN-${run}-${label}-C`])
  const er = await pool.query(
    `INSERT INTO expected_returns (tracking_id, marketplace_id, order_number, courier_id, return_type, matched_from)
     VALUES ($1, $2, $3, $4, 'Customer Return', 'SYN') RETURNING id`,
    [`SYN-${run}-${label}-AWB`, marketplace, `SYN-${run}-${label}-ORD`, Number(courier.rows[0].id)],
  )
  const scan = await pool.query(
    `INSERT INTO receipt_scans (expected_return_id, scanned_by, scanned_time_label, outcome, issue_label, status)
     VALUES ($1, $2, 'SYN', 'clear', '', 'Clear') RETURNING id`,
    [Number(er.rows[0].id), admin.id],
  )
  return Number(scan.rows[0].id)
}

function claimInput(receiptScanId: number, claimTemplateId?: number) {
  return {
    receiptScanId,
    claimReason: "SYN damaged return",
    claimTitle: `SYN-${run} claim`,
    claimDescription: "SYN description",
    remarks: "",
    claimTemplateId,
  }
}

test("schema order: Meesho claim fields apply after the claim-automation templates", () => {
  const order: string[] = [...SCHEMA_FILES]
  assert.ok(order.indexOf("schema-claims.sql") < order.indexOf("schema-claim-automation.sql"))
  assert.ok(order.indexOf("schema-claim-automation.sql") < order.indexOf("schema-meesho-claims.sql"))
})

before(async () => {
  if (skip) return
  const settings = connectionSettingsFor(rawUrl)
  pool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000 })
  // Marketplaces are added after the schema, so a fresh database needs a second apply for the template seeds.
  await applySchema(pool)
  await ensureReferenceData(pool)
  await applySchema(pool)
  const user = await pool.query(
    `INSERT INTO users (initials, name, email, password_hash, role, sidebar_label, has_all_marketplaces)
     VALUES ('SA', $1, $2, 'SYN-HASH', 'Admin', 'Admin', true) RETURNING id`,
    [`SYN admin ${run}`, `syn-admin-${run}@example.test`],
  )
  admin = { id: Number(user.rows[0].id), name: `SYN admin ${run}` } as Actor
})

after(async () => {
  if (pool) await pool.end()
})

test("db: Myntra VB, Myntra EJ, Ajio and Flipkart each resolve to one template with the agreed slots", { skip: skip || false }, async () => {
  for (const [name, slots] of [
    ["Myntra VB", FIVE_SLOTS],
    ["Myntra EJ", FIVE_SLOTS],
    ["Ajio", FIVE_SLOTS],
    ["Flipkart", FLIPKART_SLOTS],
  ] as const) {
    const mkt = await marketplaceId(name)
    const resolved = await resolveClaimTemplateId(pool, mkt)
    assert.equal(resolved, await templateId(pool, mkt, "Standard Claim Template"), `${name} uses its Standard template`)
    assert.deepEqual(await activeFieldKeys(resolved!), slots, `${name} slots`)

    const usable = await pool.query(
      `SELECT count(*)::int AS n FROM claim_templates t
       WHERE t.marketplace_id = $1 AND t.is_active = true
         AND EXISTS (SELECT 1 FROM claim_template_fields f WHERE f.template_id = t.id AND f.is_active AND f.required)`,
      [mkt],
    )
    assert.equal(usable.rows[0].n, 1, `${name} has exactly one usable template`)

    // The older template is switched off, audited once, and kept with its fields.
    const old = await templateId(pool, mkt, "Default claim template")
    assert.equal(await isActive(pool, old), false, `${name} Default is switched off`)
    assert.equal(await switchOffAudits(pool, old), 1, `${name} switch-off is audited once`)
    const fields = await pool.query(`SELECT count(*)::int AS n FROM claim_template_fields WHERE template_id = $1`, [old])
    assert.ok(fields.rows[0].n > 0, `${name} Default keeps its fields`)
  }
})

test("db: Amazon resolves to no template and an Amazon claim is refused as not supported yet", { skip: skip || false }, async () => {
  const amazon = await marketplaceId("Amazon")
  assert.equal(await resolveClaimTemplateId(pool, amazon), null)
  const empty = await templateId(pool, amazon, "Standard Claim Template")
  assert.equal(await isActive(pool, empty), false, "the empty Amazon template is switched off, not deleted")

  const scanId = await makeScan("AMZ", amazon)
  await assert.rejects(createClaim(pool, admin, scope, claimInput(scanId)), (err: unknown) => {
    assert.ok(err instanceof ServiceError)
    assert.equal(err.status, 422)
    assert.match(err.message, /Amazon are not supported yet/)
    return true
  })
  const claims = await pool.query(`SELECT 1 FROM claims WHERE receipt_scan_id = $1`, [scanId])
  assert.equal(claims.rows.length, 0, "no claim is left waiting for evidence that cannot be uploaded")
})

test("db: a requested switched-off template falls back to the marketplace's one template", { skip: skip || false }, async () => {
  const myntra = await marketplaceId("Myntra VB")
  const oldDefault = await templateId(pool, myntra, "Default claim template")
  const claim = await createClaim(pool, admin, scope, claimInput(await makeScan("MYVB", myntra), oldDefault))
  assert.equal(claim.claimTemplateId, await templateId(pool, myntra, "Standard Claim Template"))
  assert.equal(claim.status, "pending_evidence")
})

test("db: the claim return-lookup offers exactly the one template a claim will use", { skip: skip || false }, async () => {
  const ajio = await marketplaceId("Ajio")
  await makeScan("AJIO", ajio)
  const found = await lookupReturnForClaim(pool, scope, `SYN-${run}-AJIO-AWB`, ajio)
  assert.ok(found)
  assert.deepEqual(found.templates.map((t) => t.id), [await templateId(pool, ajio, "Standard Claim Template")])
  assert.deepEqual(found.templates[0].fields.map((f) => f.fieldKey), FIVE_SLOTS)

  const amazon = await marketplaceId("Amazon")
  await makeScan("AMZ-LOOKUP", amazon)
  const amazonFound = await lookupReturnForClaim(pool, scope, `SYN-${run}-AMZ-LOOKUP-AWB`, amazon)
  assert.ok(amazonFound)
  assert.deepEqual(amazonFound.templates, [], "no slots are offered for Amazon")
})

test("db: Meesho is unchanged", { skip: skip || false }, async () => {
  const meesho = await marketplaceId("Meesho")
  const resolved = await resolveClaimTemplateId(pool, meesho)
  assert.equal(resolved, await templateId(pool, meesho, "Default claim template"))
  assert.deepEqual(await activeFieldKeys(resolved!), MEESHO_SLOTS)
  const off = await pool.query(`SELECT count(*)::int AS n FROM claim_templates WHERE marketplace_id = $1 AND is_active = false`, [meesho])
  assert.equal(off.rows[0].n, 0, "no Meesho template is switched off")
})

test("db: the switch-off touches only seeded, unedited templates and never changes fields", { skip: skip || false }, async () => {
  // Fresh seeded-looking rows are made inside a transaction that is rolled back, so the shared state is untouched.
  const sql = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema-claim-automation.sql"),
    "utf8",
  )
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const fresh = async (marketplace: string, name: string, fieldKeys: string[]): Promise<number> => {
      const mkt = await marketplaceId(marketplace)
      await client.query(`UPDATE claim_templates SET name = $3 WHERE marketplace_id = $1 AND name = $2`, [
        mkt,
        name,
        `SYN-${run} moved ${name}`,
      ])
      const t = await client.query(
        `INSERT INTO claim_templates (marketplace_id, name, description, is_active, sort_order)
         VALUES ($1, $2, 'SYN seeded-looking template', true, 1) RETURNING id`,
        [mkt, name],
      )
      const id = Number(t.rows[0].id)
      for (const key of fieldKeys) {
        await client.query(
          `INSERT INTO claim_template_fields (template_id, field_key, field_label) VALUES ($1, $2, $3)`,
          [id, key, `SYN ${key}`],
        )
      }
      return id
    }
    const seeded = await fresh("Flipkart", "Default claim template", ["product_images"])
    const adminAddedField = await fresh("Ajio", "Default claim template", ["product_images", "unboxing_video"])
    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'claim_template_field.add', 'claim_template', $2, '{"fieldKey":"syn_admin_slot"}'::jsonb)`,
      [admin.id, String(adminAddedField)],
    )
    const adminDeactivatedField = await fresh("Myntra EJ", "Default claim template", ["product_images", "unboxing_video"])
    const fieldId = (await client.query(`SELECT id FROM claim_template_fields WHERE template_id = $1 LIMIT 1`, [adminDeactivatedField]))
      .rows[0].id
    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'claim_template_field.deactivate', 'claim_template_field', $2, '{}'::jsonb)`,
      [admin.id, String(fieldId)],
    )
    const emptyAmazon = await fresh("Amazon", "Standard Claim Template", [])
    const fieldsBefore = await client.query(`SELECT * FROM claim_template_fields WHERE template_id = $1 ORDER BY id`, [seeded])

    await client.query(sql)
    await client.query(sql)

    assert.equal(await isActive(client, seeded), false, "a seeded Default is switched off")
    assert.equal(await switchOffAudits(client, seeded), 1, "once, with one audit row")
    assert.equal(await isActive(client, emptyAmazon), false, "the empty Amazon template is switched off")
    assert.equal(await isActive(client, adminAddedField), true, "a template whose fields an Admin changed stays on")
    assert.equal(await isActive(client, adminDeactivatedField), true, "a template with an Admin field change stays on")
    // The seeds may add missing slots to any template; the rows that were there are never changed.
    const fieldsAfter = await client.query(`SELECT * FROM claim_template_fields WHERE id = ANY($1::int[]) ORDER BY id`, [
      fieldsBefore.rows.map((r) => r.id),
    ])
    assert.deepEqual(fieldsAfter.rows, fieldsBefore.rows, "existing field rows are never changed")
  } finally {
    await client.query("ROLLBACK")
    client.release()
  }
})

test("db: re-applying the schema changes nothing, and an Admin can turn a switched-off template back on", { skip: skip || false }, async () => {
  const ej = await marketplaceId("Myntra EJ")
  const oldDefault = await templateId(pool, ej, "Default claim template")
  await applySchema(pool)
  assert.equal(await isActive(pool, oldDefault), false)
  assert.equal(await switchOffAudits(pool, oldDefault), 1)

  await updateClaimTemplate(pool, admin, oldDefault, { isActive: true })
  try {
    await applySchema(pool)
    assert.equal(await isActive(pool, oldDefault), true, "the schema never switches it off again")
    assert.equal(await switchOffAudits(pool, oldDefault), 1)
  } finally {
    await updateClaimTemplate(pool, admin, oldDefault, { isActive: false })
  }
})
