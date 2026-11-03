// M7 §6: an explicit but unmapped issue code must fail loudly — never silently
// substitute a different issue. An empty code keeps the scan-derived fallback
// for the generic claims flow. SYN data only, no database.
import { test } from "node:test"
import assert from "node:assert/strict"
import type pg from "pg"
import { prepareMeeshoClaim } from "../meesho-claims.js"
import type { AccountScope } from "../access.js"

const SCOPE: AccountScope = { all: true }

function fakeDb(): pg.Pool {
  const query = async (sql: string) => {
    if (sql.includes("FROM receipt_scans")) {
      return {
        rows: [
          {
            id: 11,
            marketplace_id: 5,
            marketplace: "Meesho",
            order_id: "SYN-ORDER-7",
            awb: "SYN-AWB-7",
            flyer_id: "",
            flyer_state: "not_required",
            scanned_at: "2026-10-01T06:30:00.000Z",
          },
        ],
      }
    }
    return { rows: [] }
  }
  return { query } as unknown as pg.Pool
}

test("unknown Meesho issue codes are rejected, not substituted", async () => {
  await assert.rejects(
    () => prepareMeeshoClaim(fakeDb(), SCOPE, 11, "bogus_issue"),
    /Unknown Meesho issue code "bogus_issue"/,
  )
})

test("empty issue code keeps the scan-derived fallback for the generic flow", async () => {
  const prepared = await prepareMeeshoClaim(fakeDb(), SCOPE, 11, "")
  assert.equal(prepared.issueCode, "wrong_return")
})

test("mapped codes resolve with an explicit packet state or Unknown by default", async () => {
  const withState = await prepareMeeshoClaim(fakeDb(), SCOPE, 11, "damaged_return", {
    packetState: "tampered",
  })
  assert.equal(withState.issueCode, "damaged_return")
  assert.equal(withState.packetState, "Tampered")
  const withoutState = await prepareMeeshoClaim(fakeDb(), SCOPE, 11, "damaged_return")
  assert.equal(withoutState.packetState, "Unknown")
})
