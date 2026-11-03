// Checks for the engine-dashboard memory surface: payload shaping with HTML
// escaping (procedure text is operator-visible but must never break markup),
// the 20-event cap, and the local disable kill-switch.

import test from "node:test"
import assert from "node:assert/strict"
import {
  buildAiMemoryPayload,
  disableLocalProcedure,
  PAYLOAD_EVENT_CAP,
} from "./src/ai-memory-panel.ts"
import { emptyLocalMemory, upsertCachedProcedure, recordLocalEvent } from "./src/ai-memory-cache.ts"

function memoryWithEvilProcedure() {
  let memory = emptyLocalMemory()
  memory = upsertCachedProcedure(memory, {
    id: "SYN-EVIL",
    marketplace: 'meesho"><img src=x onerror=alert(1)>',
    errorSignature: "claim button not found",
    title: 'Fix <script>alert("x")</script>',
    steps: ["SYN-Step <b>one</b>"],
    status: "approved",
    updatedAt: new Date().toISOString(),
  })
  return memory
}

test("payload escapes markup in procedure fields", () => {
  const payload = buildAiMemoryPayload(memoryWithEvilProcedure(), { calls: 0, failures: 0, lastLatencyMs: null, lastModel: "", lastUsage: null }, false)
  assert.equal(payload.procedures.length, 1)
  assert.doesNotMatch(payload.procedures[0].title, /<script>/)
  assert.match(payload.procedures[0].title, /&lt;script&gt;/)
  assert.doesNotMatch(payload.procedures[0].marketplace, /<img/)
  assert.doesNotMatch(payload.procedures[0].steps[0], /<b>/)
  assert.equal(payload.assistEnabled, false)
})

test("payload caps recent events at 20", () => {
  let memory = emptyLocalMemory()
  for (let i = 0; i < PAYLOAD_EVENT_CAP + 5; i += 1) {
    memory = recordLocalEvent(memory, {
      at: new Date().toISOString(),
      claimId: i,
      marketplace: "meesho",
      step: "SYN-Step",
      outcome: "success",
      note: "",
    })
  }
  const payload = buildAiMemoryPayload(memory, { calls: 3, failures: 1, lastLatencyMs: 12, lastModel: "syn", lastUsage: null }, true)
  assert.equal(payload.events.length, PAYLOAD_EVENT_CAP)
  assert.equal(payload.usage.calls, 3)
  assert.equal(payload.assistEnabled, true)
})

test("disable flips an approved procedure and reports the change", () => {
  const memory = memoryWithEvilProcedure()
  const result = disableLocalProcedure(memory, "SYN-EVIL")
  assert.equal(result.found, true)
  assert.equal(result.changed, true)
  assert.equal(result.memory.procedures[0].status, "disabled")
  // The input is untouched (pure).
  assert.equal(memory.procedures[0].status, "approved")
})

test("disable is a no-op for unknown or already-disabled ids", () => {
  const memory = memoryWithEvilProcedure()
  const missing = disableLocalProcedure(memory, "SYN-NOPE")
  assert.equal(missing.found, false)
  assert.equal(missing.changed, false)
  const disabled = disableLocalProcedure(disableLocalProcedure(memory, "SYN-EVIL").memory, "SYN-EVIL")
  assert.equal(disabled.found, true)
  assert.equal(disabled.changed, false)
  assert.equal(disableLocalProcedure(memory, "  ").found, false)
})
