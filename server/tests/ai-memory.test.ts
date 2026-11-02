// Pure checks for the AI operational-memory rules: error-signature
// normalization, approved-only matching, and the approve/disable lifecycle.
// No database: the SQL tables are covered by the additive-schema guard.

import test from "node:test"
import assert from "node:assert/strict"
import {
  isUsableProcedure,
  matchApprovedProcedure,
  normalizeErrorSignature,
  procedureTransition,
  type MemoryProcedure,
} from "../ai-memory.js"

function procedure(overrides: Partial<MemoryProcedure> = {}): MemoryProcedure {
  return {
    id: 1,
    marketplace: "meesho",
    errorSignature: "claim button not found",
    title: "SYN-Test procedure",
    steps: ["SYN-Step one", "SYN-Step two"],
    status: "approved",
    source: "operator",
    ...overrides,
  }
}

test("signatures collapse volatile tokens but keep the root cause", () => {
  const first = normalizeErrorSignature("Error: claim button not found after 3 retries on port 9222 (pid 1234)")
  const second = normalizeErrorSignature("error:  CLAIM button NOT found after 7 retries on port 9333 (pid 9876)")
  assert.equal(first, second)
  assert.match(first, /claim button not found/)
  assert.match(first, /<port>/)
  assert.match(first, /<n>/)
})

test("uuids, long tickets, paths, and files collapse to placeholders", () => {
  const signature = normalizeErrorSignature(
    "Ticket 987654321098 failed for 550e8400-e29b-41d4-a716-446655440000 at C:\\Temp\\shot 12.png",
  )
  assert.match(signature, /<ticket>/)
  assert.match(signature, /<id>/)
  assert.match(signature, /<path>/)
})

test("blank input normalizes to unknown-error and is capped", () => {
  assert.equal(normalizeErrorSignature(""), "unknown-error")
  assert.equal(normalizeErrorSignature("   "), "unknown-error")
  assert.ok(normalizeErrorSignature("x".repeat(500)).length <= 300)
})

test("only approved procedures with matching marketplace and signature hit", () => {
  const approved = procedure()
  const pending = procedure({ id: 2, status: "pending" })
  const disabled = procedure({ id: 3, status: "disabled" })
  const otherMarket = procedure({ id: 4, marketplace: "flipkart" })
  const noSteps = procedure({ id: 5, steps: [] })
  const all = [pending, disabled, otherMarket, noSteps, approved]
  assert.equal(matchApprovedProcedure(all, "Meesho", "CLAIM BUTTON NOT FOUND"), approved)
  assert.equal(matchApprovedProcedure([pending], "meesho", "claim button not found"), null)
  assert.equal(matchApprovedProcedure([disabled], "meesho", "claim button not found"), null)
  assert.equal(matchApprovedProcedure([otherMarket], "meesho", "claim button not found"), null)
  assert.equal(matchApprovedProcedure([noSteps], "meesho", "claim button not found"), null)
  assert.equal(matchApprovedProcedure([approved], "", "claim button not found"), null)
  assert.equal(matchApprovedProcedure([approved], "meesho", ""), null)
})

test("procedures move pending -> approved -> disabled -> pending, nothing else", () => {
  assert.equal(procedureTransition("pending", "approve"), "approved")
  assert.equal(procedureTransition("pending", "disable"), "disabled")
  assert.equal(procedureTransition("approved", "disable"), "disabled")
  assert.equal(procedureTransition("disabled", "requeue"), "pending")
  assert.equal(procedureTransition("approved", "approve"), null)
  assert.equal(procedureTransition("disabled", "approve"), null)
  assert.equal(procedureTransition("pending", "requeue"), null)
  assert.equal(procedureTransition("approved", "requeue"), null)
})

test("usability needs approved status and non-empty string steps", () => {
  assert.equal(isUsableProcedure(procedure()), true)
  assert.equal(isUsableProcedure(procedure({ status: "pending" })), false)
  assert.equal(isUsableProcedure(procedure({ steps: [] })), false)
  assert.equal(isUsableProcedure(procedure({ steps: ["  "] })), false)
})
