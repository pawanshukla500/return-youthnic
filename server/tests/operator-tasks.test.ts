// SQL-shape and rule tests for the operator task center. No database: a fake
// pool records queries and returns canned rows. Scope enforcement is asserted
// on the SQL sent (account conditions on marketplace_id) and on the 404s.

import test from "node:test"
import assert from "node:assert/strict"
import type pg from "pg"
import type { AccountScope } from "../access.js"
import { createTask, listTasks, resolveTask } from "../operator-tasks.js"

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

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9,
    claim_id: 42,
    marketplace_id: 7,
    marketplace: "Meesho",
    kind: "tracking_failure",
    title: "SYN-Task",
    note: "SYN-Note",
    status: "open",
    owner: "",
    source: "worker",
    history: [{ at: "2026-01-01T00:00:00.000Z", by: "worker", note: "SYN-Note" }],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    ...overrides,
  }
}

const allAccounts: AccountScope = { all: true }
const oneAccount: AccountScope = { all: false, marketplaceIds: [7] }

function claimLookup(hasClaim: boolean, marketplaceId = 7, name = "Meesho") {
  return (sql: string) => {
    if (/FROM claims c LEFT JOIN marketplaces/.test(sql)) {
      return hasClaim ? [{ id: marketplaceId, name }] : []
    }
    if (/FROM marketplaces m WHERE m.id = \$1/.test(sql)) {
      return hasClaim ? [{ "?column?": 1 }] : []
    }
    return [taskRow()]
  }
}

test("creation validates kind and title before any write", async () => {
  const db = fakeDb(claimLookup(true))
  await assert.rejects(
    () => createTask(db.pool, allAccounts, { claimId: 42, kind: "invent_evidence", title: "SYN-T" }),
    /Unknown task kind/,
  )
  await assert.rejects(
    () => createTask(db.pool, allAccounts, { claimId: 42, kind: "tracking_failure", title: "   " }),
    /title is required/i,
  )
  assert.equal(db.queries.length, 0)
})

test("creation verifies the claim is in scope and writes history", async () => {
  const db = fakeDb(claimLookup(true))
  const task = await createTask(db.pool, oneAccount, {
    claimId: 42,
    kind: "tracking_failure",
    title: "SYN-Tracking failed",
    note: "SYN-Panel gave no state",
  })
  assert.equal(task.id, 9)
  assert.equal(task.status, "open")
  assert.equal(task.source, "worker")
  assert.match(db.queries[0].sql, /c\.marketplace_id = ANY\(\$2::integer\[\]\)/)
  const insert = db.queries.find((q) => /^INSERT INTO operator_tasks/.test(q.sql))
  assert.ok(insert)
  assert.match(String(insert?.sql), /'open'/)
  const history = JSON.parse(String(insert?.params[8]))
  assert.equal(history[0].by, "worker")
  assert.match(history[0].note, /SYN-Panel gave no state/)
})

test("creation refuses claims outside the scope", async () => {
  const db = fakeDb(claimLookup(false))
  await assert.rejects(
    () => createTask(db.pool, oneAccount, { claimId: 4242, kind: "tracking_failure", title: "SYN-T" }),
    /not found in scope/i,
  )
  assert.equal(db.queries.filter((q) => /^INSERT INTO operator_tasks/.test(q.sql)).length, 0)
})

test("listing scopes by marketplace and filters status", async () => {
  const db = fakeDb(() => [taskRow()])
  const tasks = await listTasks(db.pool, oneAccount, { status: "open" })
  assert.equal(tasks.length, 1)
  assert.match(db.queries[0].sql, /t\.marketplace_id = ANY\(\$1::integer\[\]\)/)
  assert.match(db.queries[0].sql, /t\.status = \$2/)
  assert.deepEqual(db.queries[0].params, [[7], "open"])
  const all = fakeDb(() => [])
  await listTasks(all.pool, allAccounts, {})
  assert.match(all.queries[0].sql, /TRUE/)
})

test("resolving needs a note, an open task, and scope", async () => {
  const db = fakeDb(() => [taskRow()])
  await assert.rejects(() => resolveTask(db.pool, allAccounts, 9, "SYN-Op", "   "), /resolution note/i)
  const done = fakeDb(() => [taskRow({ status: "resolved" })])
  await assert.rejects(() => resolveTask(done.pool, allAccounts, 9, "SYN-Op", "SYN-Done"), /already resolved/i)
  assert.equal(done.queries.filter((q) => /^UPDATE/i.test(q.sql)).length, 0)
  const missing = fakeDb(() => [])
  await assert.rejects(() => resolveTask(missing.pool, allAccounts, 99, "SYN-Op", "SYN-Done"), /not found in scope/i)
})

test("resolving appends history and stamps the resolution", async () => {
  const db = fakeDb((sql) => (/^UPDATE/i.test(sql) ? [taskRow({ status: "resolved" })] : [taskRow()]))
  const task = await resolveTask(db.pool, allAccounts, 9, "SYN-Op (#2)", "SYN-Verified on panel")
  assert.equal(task.status, "resolved")
  const update = db.queries.find((q) => /^UPDATE/i.test(q.sql))
  assert.match(String(update?.sql), /resolved_at = now\(\)/)
  const history = JSON.parse(String(update?.params[1]))
  assert.equal(history.length, 2)
  assert.equal(history[1].by, "SYN-Op (#2)")
  assert.equal(history[1].note, "SYN-Verified on panel")
})
