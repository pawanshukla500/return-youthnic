// SQL-shape and rule tests for the AI memory store. No database: a fake pool
// records queries and returns canned rows, so every assertion is about the
// SQL sent and the pure transitions applied — never about live data.

import test from "node:test"
import assert from "node:assert/strict"
import type pg from "pg"
import type { AccountScope } from "../access.js"
import {
  correctProcedure,
  createProcedure,
  listProcedures,
  listSyncedProceduresForAgent,
  toMemoryProcedure,
  transitionProcedure,
} from "../ai-memory-store.js"

type Captured = { sql: string; params: unknown[] }

function fakeDb(handler: (sql: string, params: unknown[]) => Record<string, unknown>[]): { pool: pg.Pool; queries: Captured[] } {
  const queries: Captured[] = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      const rows = handler(sql, params)
      return { rows, rowCount: rows.length }
    },
  } as unknown as pg.Pool
  return { pool, queries }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    marketplace: "Meesho",
    error_signature: "claim button not found",
    title: "SYN-Procedure",
    steps: ["SYN-Step one"],
    status: "pending",
    source: "operator",
    success_count: 0,
    failure_count: 0,
    approved_by: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  }
}

const allAccounts: AccountScope = { all: true }
const oneAccount: AccountScope = { all: false, marketplaceIds: [7] }

test("listing filters by status and marketplace", async () => {
  const db = fakeDb(() => [row()])
  const procedures = await listProcedures(db.pool, { status: "approved", marketplace: "Meesho" })
  assert.equal(procedures.length, 1)
  assert.match(db.queries[0].sql, /FROM ai_memory_procedures/)
  assert.match(db.queries[0].sql, /status = \$1/)
  assert.match(db.queries[0].sql, /lower\(marketplace\) = \$2/)
  assert.deepEqual(db.queries[0].params, ["approved", "meesho"])
  const unfiltered = fakeDb(() => [row()])
  await listProcedures(unfiltered.pool, {})
  assert.doesNotMatch(unfiltered.queries[0].sql, /WHERE/)
})

test("sync returns approved and disabled rows limited to the agent scope", async () => {
  const db = fakeDb(() => [row({ status: "approved" })])
  await listSyncedProceduresForAgent(db.pool, allAccounts)
  assert.match(db.queries[0].sql, /status IN \('approved', 'disabled'\)/)
  assert.match(db.queries[0].sql, /JOIN marketplaces m/)
  assert.match(db.queries[0].sql, /TRUE/)
  assert.deepEqual(db.queries[0].params, [])
  const scoped = fakeDb(() => [])
  await listSyncedProceduresForAgent(scoped.pool, oneAccount)
  assert.match(scoped.queries[0].sql, /m\.id = ANY\(\$1::integer\[\]\)/)
  assert.deepEqual(scoped.queries[0].params, [[7]])
})

test("creation always lands pending with a normalized signature", async () => {
  const db = fakeDb(() => [row()])
  const created = await createProcedure(db.pool, {
    marketplace: "Meesho",
    errorSignature: "Claim button missing on PORT 9222",
    title: "SYN-Title",
    steps: ["SYN-Step"],
    source: "ai-suggestion",
  })
  assert.equal(created.status, "pending")
  assert.match(db.queries[0].sql, /ON CONFLICT \(marketplace, error_signature\) DO UPDATE/)
  assert.match(db.queries[0].sql, /status = 'pending'/)
  assert.equal(db.queries[0].params[1], "claim button missing on port <port>")
  assert.equal(db.queries[0].params[4], "ai-suggestion")
})

test("creation rejects empty content without touching the database", async () => {
  const db = fakeDb(() => [row()])
  await assert.rejects(() => createProcedure(db.pool, { marketplace: "", errorSignature: "x", title: "SYN-T", steps: ["SYN-S"] }), /marketplace/i)
  await assert.rejects(() => createProcedure(db.pool, { marketplace: "M", errorSignature: "x", title: "  ", steps: ["SYN-S"] }), /title/i)
  await assert.rejects(() => createProcedure(db.pool, { marketplace: "M", errorSignature: "x", title: "SYN-T", steps: ["  "] }), /recovery step/i)
  assert.equal(db.queries.length, 0)
})

test("approve and disable follow the transition table and stamp the actor", async () => {
  const pending = fakeDb((sql) => (/WHERE id = \$1/.test(sql) && !/^UPDATE/i.test(sql) ? [row({ status: "pending" })] : [row({ status: "approved" })]))
  const approved = await transitionProcedure(pending.pool, 1, "approve", "SYN-Admin (#1)")
  assert.equal(approved.status, "approved")
  const update = pending.queries.find((q) => /^UPDATE/i.test(q.sql))
  assert.match(String(update?.sql), /approved_by/)
  assert.deepEqual(update?.params.slice(0, 3), [1, "approved", "SYN-Admin (#1)"])
  const bad = fakeDb(() => [row({ status: "approved" })])
  await assert.rejects(() => transitionProcedure(bad.pool, 1, "approve", "SYN-Admin (#1)"), /Cannot approve a approved/)
  assert.equal(bad.queries.filter((q) => /^UPDATE/i.test(q.sql)).length, 0)
  const missing = fakeDb(() => [])
  await assert.rejects(() => transitionProcedure(missing.pool, 99, "disable", "SYN-Admin (#1)"), /not found/i)
})

test("correcting an approved procedure re-queues it to pending", async () => {
  const db = fakeDb((sql) => (/^UPDATE/i.test(sql) ? [row({ status: "pending", title: "SYN-New" })] : [row({ status: "approved" })]))
  const corrected = await correctProcedure(db.pool, 1, { title: "SYN-New" })
  assert.equal(corrected.status, "pending")
  assert.equal(corrected.title, "SYN-New")
  const update = db.queries.find((q) => /^UPDATE/i.test(q.sql))
  assert.match(String(update?.sql), /status = \$6/)
  const same = fakeDb((sql) => (/^UPDATE/i.test(sql) ? [row({ status: "approved" })] : [row({ status: "approved", title: "SYN-Procedure", steps: ["SYN-Step one"] })]))
  const untouched = await correctProcedure(same.pool, 1, { title: "SYN-Procedure" })
  assert.equal(untouched.status, "approved")
})

test("rows map to memory procedures the worker can match", async () => {
  const db = fakeDb(() => [row({ id: 5, status: "approved", source: "worker" })])
  const [listed] = await listProcedures(db.pool, {})
  const procedure = toMemoryProcedure(listed)
  assert.equal(procedure.id, 5)
  assert.equal(procedure.status, "approved")
  assert.equal(procedure.source, "worker")
  assert.deepEqual(procedure.steps, ["SYN-Step one"])
})
