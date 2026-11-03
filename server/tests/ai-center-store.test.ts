// SQL-shape tests for the AI Center Postgres store. No database: a fake pool
// records queries and returns canned rows, like ai-memory-store.test.ts.
// Verifies additive tables, scoped writes, and the pending → approved guard
// (outcomes never flip status).

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type pg from "pg"
import {
  listAgentRuns,
  listProviderUsage,
  recordAgentRun,
  recordProcedureOutcome,
  recordProviderUsage,
} from "../ai-center-store.js"

type Captured = { sql: string; params: unknown[] }

function fakeDb(): { pool: pg.Pool; queries: Captured[] } {
  const queries: Captured[] = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      return { rows: [], rowCount: 0 }
    },
  } as unknown as pg.Pool
  return { pool, queries }
}

test("usage + agent-run writes target the new additive tables only", async () => {
  const { pool, queries } = fakeDb()
  await recordProviderUsage(pool, {
    provider: "openai", model: "gpt-4o-mini", task: "worker_diagnosis", ok: true,
    errorCategory: "", inputTokens: 10, outputTokens: 4, cachedTokens: 0, reasoningTokens: 0,
    latencyMs: 900, estimatedUsd: 0.0001, pricingProvenance: "SYN-provenance",
  })
  await recordAgentRun(pool, {
    claimId: 42, marketplace: "SYN-Meesho", agentFunction: "follow-up-check", provider: "openai",
    model: "gpt-4o-mini", stage: "model-invocation", memoryHit: false, result: "SYN-Draft",
    errorCategory: "", fallback: false, approval: "pending",
  })
  assert.equal(queries.length, 2)
  assert.match(queries[0].sql, /ai_provider_usage/)
  assert.match(queries[1].sql, /ai_agent_runs/)
  assert.ok(!queries.some((q) => /ai_memory_procedures|operator_tasks|DROP|DELETE/i.test(q.sql)), "no touching of authoritative tables")
})

test("procedure outcomes adjust confidence on approved rows only", async () => {
  const { pool, queries } = fakeDb()
  await recordProcedureOutcome(pool, 7, true)
  assert.equal(queries.length, 1)
  assert.match(queries[0].sql, /WHERE id = \$1 AND status = 'approved'/)
  assert.ok(!/pending/.test(queries[0].sql.split("WHERE")[1].split("AND status")[0]), "no pending flip")
})

test("list queries cap limits and never interpolate values", async () => {
  const { pool, queries } = fakeDb()
  await listProviderUsage(pool, { provider: "openai", limit: 99999 })
  assert.ok(queries[0].sql.includes("LIMIT 500"), "limit capped")
  assert.deepEqual(queries[0].params, ["openai"])
  await listAgentRuns(pool, 99999)
  assert.ok(queries[1].sql.includes("LIMIT 200"), "runs capped")
})

test("migration is additive: no drops, no version bump, idempotent guards", () => {
  const sql = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema-ai-center.sql"),
    "utf8",
  )
  assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(sql), "no drops")
  assert.ok(!/SCHEMA_VERSION/i.test(sql), "no version bump")
  assert.ok((sql.match(/IF NOT EXISTS/g) || []).length >= 5, "idempotent guards")
  assert.ok(sql.includes("ai_provider_usage") && sql.includes("ai_agent_runs"), "new tables present")
  assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS"), "additive columns only")
})
