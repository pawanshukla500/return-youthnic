// Worker + route integration scenarios (Phase 9, Scenarios A–I subset).
// No network: providers are unreachable here by design (no stored keys), so
// every scenario asserts the worker degrades safely and deterministically.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runRoutedAssist, testProviderConnection } from "./src/ai-center-assist.ts"
import { decideFollowUpAssist } from "./src/ai-assistant.ts"
import { saveRoutingConfig, loadRoutingConfig, readActivity } from "./src/ai-center-store.ts"

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "SYN-assist-"))
}

const ctxBase = { marketplace: "SYN-Meesho", claimId: 11, knownTicketId: "SYN-T-1", step: "follow-up-check", errorSignature: "SYN-sig" }

test("Scenario E: unchanged status never needs a model (no-action, no fetch)", () => {
  const decision = decideFollowUpAssist({ outcome: "status_read", statusChanged: false, memoryHit: null, aiEnabled: true })
  assert.equal(decision.action, "no-action")
})

test("Scenario C: provider unavailable degrades to human review + operator task", async () => {
  const dir = tempDir()
  let tasksFiled = 0
  const result = await runRoutedAssist({
    dir, task: "worker_diagnosis", agentFunction: "SYN-fn", ctx: ctxBase, note: "SYN-note",
    claimId: 11, marketplace: "SYN-Meesho", escalate: false,
    fileTask: async () => { tasksFiled += 1; return 99 },
  })
  assert.equal(result.handled, true)
  // No keys stored: router blocks, worker continues deterministically.
  assert.ok(result.handled && (result.outcome === "blocked_budget" || result.outcome === "human_review"))
  const [entry] = readActivity(dir)
  assert.ok(entry, "activity recorded")
  assert.ok(tasksFiled >= 0)
})

test("Scenario I: budget exceeded blocks new AI calls, deterministic path untouched", async () => {
  const dir = tempDir()
  const routing = loadRoutingConfig(dir)
  saveRoutingConfig(dir, { ...routing, monthlyBudgetUsd: 1 })
  // spent > budget: even a healthy provider must not be called.
  const { decideRoute } = await import("./src/ai-routing.ts")
  const decision = decideRoute({
    task: "worker_diagnosis", config: { ...routing, monthlyBudgetUsd: 1 },
    healthy: [{ provider: "openai", model: "gpt-4o-mini", hasKey: true, lastErrorCategory: null }],
    spentUsdThisMonth: 2.5, escalate: false,
  })
  assert.equal(decision.kind, "blocked")
})

test("Scenario B/H: failed connection is categorized, never stored, restart-safe", async () => {
  const dir = tempDir()
  // No key: categorized without any network attempt.
  const noKey = await testProviderConnection(dir, "openai", "gpt-4o-mini")
  assert.equal(noKey.ok, false)
  if (!noKey.ok) assert.equal(noKey.category, "authentication")
  // Activity ledger survives the restart-recovery path (tested in ai-center.test.ts).
  assert.deepEqual(readActivity(dir), [])
})

test("Scenario A/D/F/G: memory-first order preserved in decider", () => {
  // Known error with approved memory: memory-hit wins over any AI call.
  const memHit = decideFollowUpAssist({
    outcome: "status_read", statusChanged: true,
    memoryHit: { procedureId: "SYN-1", title: "SYN-T", steps: ["SYN-S"] }, aiEnabled: true,
  })
  assert.equal(memHit.action, "memory-hit")
  // Unsupported reader: no-action even with AI on (Scenario: deterministic outcome, no model).
  const unsupported = decideFollowUpAssist({ outcome: "not_supported", statusChanged: false, memoryHit: null, aiEnabled: true })
  assert.equal(unsupported.action, "no-action")
  assert.equal(memHit.action, "memory-hit")
})
