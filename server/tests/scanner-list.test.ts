// SYNTHETIC FIXTURES ONLY. These workbooks contain invented tracking values and never touch a database.

import { test } from "node:test"
import assert from "node:assert/strict"
import * as XLSX from "xlsx"
import { parseScannerList } from "../scanner-list.js"

function workbookBuffer() {
  const workbook = XLSX.utils.book_new()
  const first = XLSX.utils.aoa_to_sheet([
    ["SYN-AWB-VALID", "1.23456789012345E+17", 1234567890123456],
    ["SYN-AWB-DUPLICATE", "SYN-AWB-DUPLICATE", "bad value!"],
  ])
  const second = XLSX.utils.aoa_to_sheet([
    ["SYN-AWB-DUPLICATE"],
    ["SYN-AWB-SECOND"],
  ])
  first["D3"] = { t: "s", v: "", w: "" }
  first["!ref"] = "A1:D3"
  XLSX.utils.book_append_sheet(workbook, first, "meesho")
  XLSX.utils.book_append_sheet(workbook, second, "coco")
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))
}

test("[synthetic] scanner parser preserves worksheets and source coordinates", () => {
  const parsed = parseScannerList(workbookBuffer())

  assert.equal(parsed.kind, "scanner_list")
  assert.deepEqual(parsed.sheets.map((sheet) => sheet.name), ["meesho", "coco"])
  assert.equal(parsed.counts.sheets, 2)
  assert.equal(parsed.counts.entries, 9)
  assert.equal(parsed.sheets[0]?.entries[0]?.sourceRow, 1)
  assert.equal(parsed.sheets[0]?.entries[0]?.sourceColumn, 1)
  assert.equal(parsed.sheets[1]?.entries[0]?.sourceValue, "SYN-AWB-DUPLICATE")
})

test("[synthetic] scanner parser never uses numeric or scientific identifiers as lookup keys", () => {
  const parsed = parseScannerList(workbookBuffer())
  const numeric = parsed.entries.filter((entry) => entry.status === "numeric_identifier")
  const scientific = parsed.entries.filter((entry) => entry.status === "scientific_notation")

  assert.equal(numeric.length, 1)
  assert.equal(scientific.length, 1)
  assert.equal(numeric[0]?.normalizedValue, "")
  assert.equal(scientific[0]?.normalizedValue, "")
  assert.equal(parsed.counts.numericEntries, 1)
})

test("[synthetic] scanner parser marks repeated valid AWBs across worksheets", () => {
  const parsed = parseScannerList(workbookBuffer())
  const duplicates = parsed.entries.filter((entry) => entry.duplicate)

  assert.equal(duplicates.length, 3)
  assert.ok(duplicates.every((entry) => entry.normalizedValue === "SYN-AWB-DUPLICATE"))
  assert.equal(parsed.counts.duplicateEntries, 3)
  assert.equal(parsed.entries.find((entry) => entry.sourceValue === "bad value!")?.status, "invalid_format")
  assert.equal(parsed.entries.find((entry) => entry.status === "blank")?.sourceRow, 3)
})
