// Checks for the engine-local AI memory cache: approved-only lookup, event
// caps, 24h pruning, and crash-safe load of missing or corrupt files.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  emptyLocalMemory,
  findApprovedProcedure,
  isCacheStale,
  loadLocalMemory,
  markSynced,
  pruneLocalEvents,
  recordLocalEvent,
  saveLocalMemory,
  upsertCachedProcedure,
  LOCAL_EVENT_CAP,
  MEMORY_SYNC_TTL_MS,
  type CachedProcedure,
} from "./src/ai-memory-cache.ts"

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "syn-aimem-"))
}

function approved(overrides: Partial<CachedProcedure> = {}): CachedProcedure {
  return {
    id: "SYN-P1",
    marketplace: "meesho",
    errorSignature: "claim button not found",
    title: "SYN-Procedure",
    steps: ["SYN-Step one"],
    status: "approved",
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

test("missing or corrupt cache loads empty instead of throwing", () => {
  const dir = tempDir()
  assert.deepEqual(loadLocalMemory(dir), emptyLocalMemory())
  fs.writeFileSync(path.join(dir, "ai-memory.json"), "{not json")
  assert.deepEqual(loadLocalMemory(dir), emptyLocalMemory())
})

test("save and load round-trip approved procedures", () => {
  const dir = tempDir()
  const memory = upsertCachedProcedure(emptyLocalMemory(), approved())
  saveLocalMemory(dir, memory)
  const loaded = loadLocalMemory(dir)
  assert.equal(loaded.procedures.length, 1)
  assert.equal(findApprovedProcedure(loaded, "Meesho", "CLAIM BUTTON NOT FOUND")?.id, "SYN-P1")
})

test("pending and disabled mirrors never match", () => {
  let memory = emptyLocalMemory()
  memory = upsertCachedProcedure(memory, approved({ id: "SYN-P2", status: "pending" }))
  memory = upsertCachedProcedure(memory, approved({ id: "SYN-P3", status: "disabled" }))
  assert.equal(findApprovedProcedure(memory, "meesho", "claim button not found"), null)
})

test("upsert replaces the same id and matches per marketplace", () => {
  let memory = upsertCachedProcedure(emptyLocalMemory(), approved())
  memory = upsertCachedProcedure(memory, approved({ steps: ["SYN-Step two"] }))
  assert.equal(memory.procedures.length, 1)
  assert.deepEqual(memory.procedures[0].steps, ["SYN-Step two"])
  assert.equal(findApprovedProcedure(memory, "flipkart", "claim button not found"), null)
})

test("events are capped and pruned after 24h", () => {
  let memory = emptyLocalMemory()
  for (let i = 0; i < LOCAL_EVENT_CAP + 10; i += 1) {
    memory = recordLocalEvent(memory, {
      at: new Date().toISOString(),
      claimId: i,
      marketplace: "meesho",
      step: "SYN-Step",
      outcome: "success",
      note: "",
    })
  }
  assert.equal(memory.events.length, LOCAL_EVENT_CAP)
  const old = recordLocalEvent(emptyLocalMemory(), {
    at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    claimId: 1,
    marketplace: "meesho",
    step: "SYN-Step",
    outcome: "failure",
    note: "",
  })
  assert.equal(pruneLocalEvents(old, Date.now()).events.length, 0)
})

test("a cache that never synced is stale", () => {
  assert.equal(isCacheStale(emptyLocalMemory(), Date.now()), true)
  assert.equal(isCacheStale(loadLocalMemory("/definitely/not/a/dir"), Date.now()), true)
})

test("sync marks the cache fresh until the TTL passes", () => {
  const now = Date.now()
  const synced = markSynced(emptyLocalMemory(), now)
  assert.equal(isCacheStale(synced, now), false)
  assert.equal(isCacheStale(synced, now + MEMORY_SYNC_TTL_MS), false)
  assert.equal(isCacheStale(synced, now + MEMORY_SYNC_TTL_MS + 1), true)
})

test("syncedAt survives a save and load round-trip", () => {
  const dir = tempDir()
  const memory = markSynced(upsertCachedProcedure(emptyLocalMemory(), approved()), Date.now())
  saveLocalMemory(dir, memory)
  const loaded = loadLocalMemory(dir)
  assert.equal(typeof loaded.syncedAt, "string")
  assert.equal(isCacheStale(loaded, Date.now()), false)
})
