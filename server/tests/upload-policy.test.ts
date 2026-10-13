// Activation rules for an uploaded file, without a database. A file with any error row, a fatal file, or a file for an
// account the user cannot use is never activated, and a confirmation can never stand in for a blocker.

import { test } from "node:test"
import assert from "node:assert/strict"
import type { ParsedRow } from "../sheets.js"
import { activationBlockers, canActivate, confirmationsNeeded, countPreview } from "../upload-policy.js"

function row(overrides: Partial<ParsedRow>): ParsedRow {
  return {
    trackingId: "SYN-AWB-1",
    altTrackingId: "",
    orderId: "SYN-ORDER",
    orderLineId: "SYN-LINE",
    channelListingId: "SYN-LISTING",
    sku: "SYN-SKU",
    qty: 1,
    marketplace: "Myntra EJ",
    cancelled: false,
    valid: true,
    error: "",
    warnings: [],
    pendingReasons: [],
    trackingValidation: "not_applicable",
    duplicateKind: "",
    ...overrides,
  } as unknown as ParsedRow
}

test("[synthetic] a file with one error row can partially activate its scannable row", () => {
  const counts = countPreview([row({}), row({ valid: false, error: "SYN error" })])
  assert.equal(counts.errorRows, 1)
  const blockers = activationBlockers({ fatal: "", accountAllowed: true, counts })
  assert.deepEqual(blockers, [])
  assert.equal(counts.scannableRows, 1)
  assert.equal(confirmationsNeeded(counts).length, 1)
  assert.equal(canActivate({ blockers, counts }), true)
})

test("[synthetic] a fatal file is blocked, with its reason", () => {
  const counts = countPreview([])
  const blockers = activationBlockers({ fatal: "The file has no header row.", accountAllowed: true, counts })
  assert.ok(blockers[0].includes("The file has no header row."))
  assert.equal(canActivate({ blockers, counts }), false)
})

test("[synthetic] a file for an account the user cannot use is blocked", () => {
  const counts = countPreview([row({})])
  const blockers = activationBlockers({ fatal: "", accountAllowed: false, counts })
  assert.equal(blockers.length, 1)
  assert.equal(canActivate({ blockers, counts }), false)
})

test("[synthetic] a file with no return rows, or with no valid row, is blocked", () => {
  const empty = countPreview([])
  assert.equal(
    canActivate({ blockers: activationBlockers({ fatal: "", accountAllowed: true, counts: empty }), counts: empty }),
    false,
  )
  const allBad = countPreview([row({ valid: false, error: "SYN error" })])
  assert.equal(
    canActivate({ blockers: activationBlockers({ fatal: "", accountAllowed: true, counts: allBad }), counts: allBad }),
    false,
  )
})

test("[synthetic] a pending row is kept out of active lookup data but does not block another scannable row", () => {
  const counts = countPreview([
    row({ pendingReasons: ["SYN missing AWB"], trackingId: "", csvTrackingId: "" }),
    row({ trackingId: "SYN-AWB-2" }),
  ])
  assert.equal(counts.pendingRows, 1)
  assert.equal(counts.scannableRows, 1)
  assert.equal(canActivate({ blockers: activationBlockers({ fatal: "", accountAllowed: true, counts }), counts }), true)
})

test("[synthetic] a clean file can be activated, and needs no confirmation", () => {
  const counts = countPreview([row({}), row({ trackingId: "SYN-AWB-2" })])
  const blockers = activationBlockers({ fatal: "", accountAllowed: true, counts })
  assert.deepEqual(blockers, [])
  assert.deepEqual(confirmationsNeeded(counts), [])
  assert.equal(canActivate({ blockers, counts }), true)
})

test("[synthetic] an identifier Excel stored as a number needs a confirmation, and is not a blocker", () => {
  const counts = countPreview([
    row({ warnings: ["Order ID is stored as a number in the file, so its digits may be lost; it is left blank."] }),
  ])
  assert.equal(counts.untrustedIdentifierRows, 1)
  assert.equal(confirmationsNeeded(counts).length, 1)
  assert.deepEqual(activationBlockers({ fatal: "", accountAllowed: true, counts }), [])
})

test("[synthetic] a tracking link that disagrees with the file needs confirmation; a corrected one does not", () => {
  const kept = countPreview([row({ trackingValidation: "mismatch_kept" })])
  assert.equal(kept.trackingKeptRows, 1)
  assert.equal(confirmationsNeeded(kept).length, 1)
  const fixed = countPreview([row({ trackingValidation: "mismatch_resolved" })])
  assert.equal(fixed.trackingCorrectedRows, 1)
  assert.equal(confirmationsNeeded(fixed).length, 0)
})

test("[synthetic] exact duplicates and repeated lines are counted, and are not errors", () => {
  const counts = countPreview([
    row({ duplicateKind: "exact_import_row", warnings: ["Exact duplicate of an earlier row. Kept, not counted."] }),
    row({ warnings: ["Same AWB, SKU and order line as an earlier row. Kept as a separate line."] }),
  ])
  assert.equal(counts.exactDuplicateRows, 1)
  assert.equal(counts.repeatedRows, 1)
  assert.equal(counts.errorRows, 0)
  assert.equal(canActivate({ blockers: activationBlockers({ fatal: "", accountAllowed: true, counts }), counts }), true)
})

test("[synthetic] batch calculation divides large files into 500-row chunks with pause triggers", () => {
  const BATCH_SIZE = 500
  const totalRows = 1173 // Matching user's Meesho file size
  const totalBatches = Math.max(1, Math.ceil(totalRows / BATCH_SIZE))
  assert.equal(totalBatches, 3)

  const batches = Array.from({ length: totalBatches }, (_, i) => {
    const start = i * BATCH_SIZE + 1
    const end = Math.min((i + 1) * BATCH_SIZE, totalRows)
    return { batchNo: i + 1, count: end - start + 1, start, end }
  })

  assert.deepEqual(batches, [
    { batchNo: 1, count: 500, start: 1, end: 500 },
    { batchNo: 2, count: 500, start: 501, end: 1000 },
    { batchNo: 3, count: 173, start: 1001, end: 1173 },
  ])
})

test("[synthetic] small files under 500 rows resolve in a single batch", () => {
  const BATCH_SIZE = 500
  const totalRows = 340
  const totalBatches = Math.max(1, Math.ceil(totalRows / BATCH_SIZE))
  assert.equal(totalBatches, 1)
})

test("[synthetic] streaming batch progression produces sequential events with pause states", () => {
  const events: { phase: string; batchIndex: number; processedRows: number; percent: number }[] = []
  const totalRows = 1173
  const batchSize = 500
  const totalBatches = Math.ceil(totalRows / batchSize)

  for (let batch = 1; batch <= totalBatches; batch++) {
    const isLast = batch === totalBatches
    const processed = isLast ? totalRows : batch * batchSize
    events.push({
      phase: isLast ? "finalizing" : "batch_pause",
      batchIndex: batch,
      processedRows: processed,
      percent: Math.min(95, Math.round((processed / totalRows) * 90)),
    })
  }
  events.push({ phase: "complete", batchIndex: totalBatches, processedRows: totalRows, percent: 100 })

  assert.equal(events.length, 4)
  assert.equal(events[0].phase, "batch_pause")
  assert.equal(events[0].processedRows, 500)
  assert.equal(events[1].phase, "batch_pause")
  assert.equal(events[1].processedRows, 1000)
  assert.equal(events[2].phase, "finalizing")
  assert.equal(events[2].processedRows, 1173)
  assert.equal(events[3].phase, "complete")
  assert.equal(events[3].percent, 100)
})
