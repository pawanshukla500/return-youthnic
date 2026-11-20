// The return tracking sync that runs inside a scan save, without a database. These checks run in every environment.
// The database checks (a forced sync failure inside a real save, one AWB in two Myntra accounts) are in
// register-db.test.ts.

import { test } from "node:test"
import assert from "node:assert/strict"
import { runSecondaryWrite } from "../register-service.js"
import { syncScanToReturnTracking } from "../return-tracking.js"

function recorder() {
  const statements: string[] = []
  return { statements, query: async (text: string) => void statements.push(text) }
}

test("[synthetic] a secondary write that succeeds is released, and the transaction carries on", async () => {
  const client = recorder()
  await runSecondaryWrite(client, "SYN label", async () => {
    client.statements.push("SYN work")
  })
  assert.deepEqual(client.statements, ["SAVEPOINT secondary_write", "SYN work", "RELEASE SAVEPOINT secondary_write"])
})

test("[synthetic] a secondary write that fails rolls back to its savepoint only, is logged, and does not throw", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined)
  const client = recorder()
  const failure = new Error("SYN tracking sync failure")
  await runSecondaryWrite(client, "SYN label", async () => {
    throw failure
  })
  assert.deepEqual(client.statements, ["SAVEPOINT secondary_write", "ROLLBACK TO SAVEPOINT secondary_write"])
  assert.equal(logged.mock.callCount(), 1)
  assert.deepEqual(logged.mock.calls[0].arguments, ["SYN label", failure])
})

test("[synthetic] the tracking sync is limited to the scan's own account, bound as a parameter", async () => {
  const calls: { text: string; values?: unknown[] }[] = []
  const db = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values })
      return { rows: [], rowCount: 1 }
    },
  }
  const updated = await syncScanToReturnTracking(db, 42, 7, " syn-awb-1 ", " SYN-ORDER-1 ", 3, "clear")
  assert.equal(updated, 1)
  assert.equal(calls.length, 1)
  const sql = calls[0].text.replace(/\s+/g, " ")
  assert.match(sql, /WHERE marketplace_id = \$6 AND \( tracking_id = \$4 .* OR \(order_id = \$5 AND \$5 <> ''\) \)/)
  assert.deepEqual(calls[0].values, [7, 3, "clear", "SYN-AWB-1", "SYN-ORDER-1", 42])
})
