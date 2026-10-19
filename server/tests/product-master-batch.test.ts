import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MASTER_BATCH_LIMIT,
  MASTER_STAGING_TTL_MS,
  clampMasterBatchLimit,
  inheritBlankMasterImages,
  inheritedImageCount,
  masterBatchProgress,
  masterSkuKey,
  requireStagedMasterImport,
  takeMasterBatch,
  type StagedMasterImport,
} from "../product-master.js"
import type { MasterRow } from "../sheets.js"

// Invariant 9: test data is synthetic, and every value starts with SYN-.
function synRow(n: number): MasterRow {
  return {
    listingSku: `SYN-LISTING-${n}`,
    marketplace: "SYN-marketplace",
    masterSku: `SYN-MASTER-${n}`,
    category: "SYN-category",
    cogs: null,
    weightSlab: null,
    imageUrl: "",
  }
}

const NOW = 2_000_000

function synEntry(overrides: Partial<StagedMasterImport> = {}): StagedMasterImport {
  return {
    rows: [synRow(1), synRow(2)],
    filename: "SYN-master.csv",
    scope: "",
    mode: "merge",
    ownerId: 7,
    createdAt: NOW - 60_000,
    processed: 0,
    inserted: 0,
    removed: 0,
    replaced: false,
    imagesFilled: 0,
    ...overrides,
  }
}

function statusOf(fn: () => void): { status: number; message: string } {
  try {
    fn()
  } catch (error) {
    const err = error as { status?: number; message?: string }
    return { status: Number(err.status), message: String(err.message) }
  }
  throw new Error("SYN-expected-throw: function did not throw")
}

test("MASTER_BATCH_LIMIT is 500 and the staging TTL is 15 minutes", () => {
  assert.equal(MASTER_BATCH_LIMIT, 500)
  assert.equal(MASTER_STAGING_TTL_MS, 15 * 60 * 1000)
})

test("clampMasterBatchLimit caps at 500 and defaults bad input to 500", () => {
  assert.equal(clampMasterBatchLimit(undefined), 500)
  assert.equal(clampMasterBatchLimit(0), 500)
  assert.equal(clampMasterBatchLimit(-5), 500)
  assert.equal(clampMasterBatchLimit(Number.NaN), 500)
  assert.equal(clampMasterBatchLimit("SYN-abc"), 500)
  assert.equal(clampMasterBatchLimit(1), 1)
  assert.equal(clampMasterBatchLimit(100), 100)
  assert.equal(clampMasterBatchLimit(499.9), 499)
  assert.equal(clampMasterBatchLimit("200"), 200)
  assert.equal(clampMasterBatchLimit(500), 500)
  assert.equal(clampMasterBatchLimit(501), 500)
  assert.equal(clampMasterBatchLimit(126000), 500)
  assert.equal(clampMasterBatchLimit("9999"), 500)
})

test("takeMasterBatch slices 1200 rows into 500/500/200 with progress", () => {
  const rows = Array.from({ length: 1200 }, (_, i) => synRow(i + 1))
  const first = takeMasterBatch(rows, 0, 500)
  assert.equal(first.chunk.length, 500)
  assert.equal(first.nextProcessed, 500)
  assert.equal(first.done, false)
  assert.equal(first.effectiveLimit, 500)

  const second = takeMasterBatch(rows, first.nextProcessed, 500)
  assert.equal(second.chunk.length, 500)
  assert.equal(second.nextProcessed, 1000)
  assert.equal(second.done, false)

  const third = takeMasterBatch(rows, second.nextProcessed, 500)
  assert.equal(third.chunk.length, 200)
  assert.equal(third.nextProcessed, 1200)
  assert.equal(third.done, true)
})

test("takeMasterBatch caps the client limit and defaults to 500", () => {
  const rows = Array.from({ length: 600 }, (_, i) => synRow(i + 1))
  const capped = takeMasterBatch(rows, 0, 100000)
  assert.equal(capped.effectiveLimit, 500)
  assert.equal(capped.chunk.length, 500)
  const fallback = takeMasterBatch(rows, 0, undefined)
  assert.equal(fallback.effectiveLimit, 500)
  assert.equal(fallback.chunk.length, 500)
})

test("masterBatchProgress reports processed/total/done/remaining", () => {
  assert.deepEqual(masterBatchProgress(0, 1200), { processed: 0, total: 1200, done: false, remaining: 1200 })
  assert.deepEqual(masterBatchProgress(500, 1200), { processed: 500, total: 1200, done: false, remaining: 700 })
  assert.deepEqual(masterBatchProgress(1200, 1200), { processed: 1200, total: 1200, done: true, remaining: 0 })
  assert.deepEqual(masterBatchProgress(9999, 1200), { processed: 1200, total: 1200, done: true, remaining: 0 })
})

test("requireStagedMasterImport returns the entry for the owner", () => {
  const staged = new Map<string, StagedMasterImport>()
  staged.set("SYN-upload-1", synEntry())
  const entry = requireStagedMasterImport(staged, "SYN-upload-1", 7, NOW)
  assert.equal(entry.filename, "SYN-master.csv")
  assert.equal(staged.has("SYN-upload-1"), true)
})

test("requireStagedMasterImport rejects an unknown upload id (400)", () => {
  const staged = new Map<string, StagedMasterImport>()
  const result = statusOf(() => requireStagedMasterImport(staged, "SYN-missing", 7, NOW))
  assert.equal(result.status, 400)
  assert.equal(result.message, "Upload the file again before importing.")
})

test("requireStagedMasterImport rejects another owner (403) and keeps the entry", () => {
  const staged = new Map<string, StagedMasterImport>()
  staged.set("SYN-upload-2", synEntry({ ownerId: 7 }))
  const result = statusOf(() => requireStagedMasterImport(staged, "SYN-upload-2", 11, NOW))
  assert.equal(result.status, 403)
  assert.equal(result.message, "Upload the file again before importing.")
  assert.equal(staged.has("SYN-upload-2"), true)
})

test("requireStagedMasterImport rejects an expired staging (400) and forgets it", () => {
  const staged = new Map<string, StagedMasterImport>()
  staged.set("SYN-upload-3", synEntry({ createdAt: NOW - MASTER_STAGING_TTL_MS - 1 }))
  const result = statusOf(() => requireStagedMasterImport(staged, "SYN-upload-3", 7, NOW))
  assert.equal(result.status, 400)
  assert.equal(result.message, "That file preview expired. Upload it again.")
  assert.equal(staged.has("SYN-upload-3"), false)
})

test("a blank listing takes the image already known for that product SKU", () => {
  const rows = [
    synRow(1),
    { ...synRow(2), masterSku: "SYN-MASTER-1", imageUrl: "" },
    { ...synRow(3), masterSku: "SYN-MASTER-1", imageUrl: "https://img.example.invalid/SYN-1.jpg" },
    { ...synRow(4), masterSku: "SYN-MASTER-9", imageUrl: "" },
  ]
  rows[0].imageUrl = ""
  const stored = new Map<string, string>([
    [masterSkuKey("SYN-MASTER-9"), "https://img.example.invalid/SYN-stored.jpg"],
    [masterSkuKey("SYN-MASTER-1"), "https://img.example.invalid/SYN-old.jpg"],
  ])
  const filled = inheritBlankMasterImages(rows, stored)
  assert.equal(filled[0].imageUrl, "https://img.example.invalid/SYN-1.jpg")
  assert.equal(filled[1].imageUrl, "https://img.example.invalid/SYN-1.jpg")
  assert.equal(filled[2].imageUrl, "https://img.example.invalid/SYN-1.jpg")
  assert.equal(filled[3].imageUrl, "https://img.example.invalid/SYN-stored.jpg")
  assert.equal(inheritedImageCount(rows, filled), 3)
})

test("an image already on a listing is not replaced by another product SKU image", () => {
  const rows = [
    { ...synRow(1), imageUrl: "https://img.example.invalid/SYN-keep.jpg" },
    { ...synRow(2), masterSku: "SYN-MASTER-1", imageUrl: "https://img.example.invalid/SYN-other.jpg" },
  ]
  const filled = inheritBlankMasterImages(rows, new Map([["syn-master-1", "https://img.example.invalid/SYN-stored.jpg"]]))
  assert.equal(filled[0].imageUrl, "https://img.example.invalid/SYN-keep.jpg")
  assert.equal(filled[1].imageUrl, "https://img.example.invalid/SYN-other.jpg")
  assert.equal(inheritedImageCount(rows, filled), 0)
})

test("product SKU image matching ignores case", () => {
  const rows = [
    { ...synRow(1), masterSku: "SYN-Master-1", imageUrl: "" },
    { ...synRow(2), masterSku: "syn-master-1", imageUrl: "https://img.example.invalid/SYN-case.jpg" },
  ]
  const filled = inheritBlankMasterImages(rows)
  assert.equal(filled[0].imageUrl, "https://img.example.invalid/SYN-case.jpg")
  assert.equal(masterSkuKey("  SYN-Master-1  "), "syn-master-1")
})

test("requireStagedMasterImport accepts a staging exactly at the TTL boundary", () => {
  const staged = new Map<string, StagedMasterImport>()
  staged.set("SYN-upload-4", synEntry({ createdAt: NOW - MASTER_STAGING_TTL_MS }))
  const entry = requireStagedMasterImport(staged, "SYN-upload-4", 7, NOW)
  assert.equal(entry.filename, "SYN-master.csv")
  assert.equal(staged.has("SYN-upload-4"), true)
})
