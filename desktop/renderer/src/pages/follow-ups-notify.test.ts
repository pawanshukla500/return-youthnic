// Pure-diff tests for follow-up notifications: state transitions produce one
// notification each with a stable key; unchanged rows and unmatched wording
// stay silent. All values are synthetic (SYN- prefix per project rules).

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectFollowUpNotifications } from "./follow-ups-notify"
import type { FollowUpRow } from "../types/engine"

function row(overrides: Partial<FollowUpRow> & { id?: number } = {}): FollowUpRow {
  return {
    marketplace: "Meesho",
    accountName: "SYN-Account",
    orderNumber: "SYN-ORDER-1",
    marketplaceClaimId: "SYN-TICKET-1",
    claimStatus: "submitted",
    statusAtLastCheck: "Ticket created",
    lastCheckedAt: "2026-11-14T06:00:00.000Z",
    nextCheckAt: "2026-11-16T06:00:00.000Z",
    checkCount: 1,
    isActive: true,
    checkIntervalHours: 48,
    errorStreak: 0,
    stopReason: null,
    lastError: null,
    ...overrides,
  }
}

describe("detectFollowUpNotifications — first batch", () => {
  it("fires 'Ticket tracking started' for rows with a marketplace ticket id", () => {
    const notes = detectFollowUpNotifications(null, [row(), row({ id: 2, marketplaceClaimId: "SYN-TICKET-2", orderNumber: "SYN-ORDER-2" })])
    assert.equal(notes.length, 2)
    assert.ok(notes.every((n) => n.title === "Ticket tracking started"))
    assert.ok(notes[0].body.includes("SYN-TICKET-1"))
  })

  it("treats an empty prev array like null and skips rows without a ticket id", () => {
    assert.equal(detectFollowUpNotifications([], [row({ marketplaceClaimId: "", id: 7 })]).length, 0)
    assert.equal(detectFollowUpNotifications(null, []).length, 0)
    assert.equal(detectFollowUpNotifications(null, [row({ marketplaceClaimId: "" })]).length, 0)
  })
})

describe("detectFollowUpNotifications — steady state", () => {
  it("stays silent when nothing changed", () => {
    const before = [row()]
    const after = [row({ checkCount: 2, lastCheckedAt: "2026-11-14T07:00:00.000Z" })]
    assert.deepEqual(detectFollowUpNotifications(before, after), [])
  })

  it("matches rows by backend id when the ticket id is absent", () => {
    const before = [row({ marketplaceClaimId: "", id: 42, claimStatus: "submitted" })]
    const after = [row({ marketplaceClaimId: "", id: 42, claimStatus: "approved" })]
    const notes = detectFollowUpNotifications(before, after)
    assert.equal(notes.length, 1)
    assert.equal(notes[0].title, "Claim approved")
    assert.ok(notes[0].body.includes("ticket 42"))
  })
})

describe("detectFollowUpNotifications — status transitions", () => {
  it("fires 'Claim approved' when claimStatus becomes approved, case-insensitively", () => {
    const notes = detectFollowUpNotifications([row()], [row({ claimStatus: "APPROVED" })])
    assert.equal(notes.length, 1)
    assert.equal(notes[0].title, "Claim approved")
    assert.equal(notes[0].body, "SYN-TICKET-1 — APPROVED.")
    assert.equal(notes[0].key, "SYN-TICKET-1:APPROVED:Ticket created")
  })

  it("treats paid like approved", () => {
    const notes = detectFollowUpNotifications([row()], [row({ claimStatus: "Paid" })])
    assert.deepEqual(notes.map((n) => n.title), ["Claim approved"])
  })

  it("stays silent while approved stays approved", () => {
    const before = [row({ claimStatus: "approved" })]
    const after = [row({ claimStatus: "approved", statusAtLastCheck: "Claim approved" })]
    // statusAtLastCheck changed, but the new status is neither a transition nor response wording.
    assert.deepEqual(detectFollowUpNotifications(before, after), [])
  })

  it("fires 'Claim rejected' when claimStatus becomes rejected", () => {
    const notes = detectFollowUpNotifications([row()], [row({ claimStatus: "rejected" })])
    assert.equal(notes.length, 1)
    assert.equal(notes[0].title, "Claim rejected")
    assert.ok(notes[0].body.includes("SYN-TICKET-1"))
  })
})

describe("detectFollowUpNotifications — Meesho response wording", () => {
  const cases = [
    "Please provide the unboxing video",
    "Please upload proof of the tampered parcel",
    "Reply required: claim clarification",
    "Action required from supplier",
  ]
  for (const statusAtLastCheck of cases) {
    it(`fires 'Meesho needs a response' for wording: ${statusAtLastCheck}`, () => {
      const notes = detectFollowUpNotifications([row()], [row({ statusAtLastCheck })])
      assert.equal(notes.length, 1)
      assert.equal(notes[0].title, "Meesho needs a response")
      assert.equal(notes[0].body, `SYN-TICKET-1: ${statusAtLastCheck}`)
    })
  }

  it("matches response wording case-insensitively", () => {
    const notes = detectFollowUpNotifications([row()], [row({ statusAtLastCheck: "PROVIDE invoice copy" })])
    assert.equal(notes.length, 1)
    assert.equal(notes[0].title, "Meesho needs a response")
  })

  it("ignores unrelated status text", () => {
    const notes = detectFollowUpNotifications([row()], [row({ statusAtLastCheck: "Under review by Meesho" })])
    assert.deepEqual(notes, [])
  })

  it("ignores a lastError-only change with no response wording", () => {
    const before = [row()]
    const after = [row({ lastError: "SYN transient panel timeout" })]
    assert.deepEqual(detectFollowUpNotifications(before, after), [])
  })
})

describe("detectFollowUpNotifications — keys", () => {
  it("keys are stable per state so a Set dedupes repeats", () => {
    const after = [row({ claimStatus: "approved" })]
    const first = detectFollowUpNotifications([row()], after)
    const second = detectFollowUpNotifications(after, after.map((r) => ({ ...r, checkCount: 3 })))
    assert.equal(first[0].key, "SYN-TICKET-1:approved:Ticket created")
    assert.deepEqual(second, []) // unchanged rows never re-fire
  })
})
