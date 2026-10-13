import * as XLSX from "xlsx"
import { normalizeTracking } from "./register-rules.js"

export type ScannerEntryStatus =
  | "valid"
  | "blank"
  | "numeric_identifier"
  | "scientific_notation"
  | "invalid_format"

export type ScannerListEntry = {
  sheet: string
  sourceRow: number
  sourceColumn: number
  sourceValue: string
  normalizedValue: string
  status: ScannerEntryStatus
  duplicate: boolean
}

export type ScannerListSheet = {
  name: string
  sourceRows: number
  nonEmptyCells: number
  columns: number[]
  entries: ScannerListEntry[]
}

export type ScannerListParse = {
  kind: "scanner_list"
  sheets: ScannerListSheet[]
  entries: ScannerListEntry[]
  counts: {
    sheets: number
    entries: number
    validEntries: number
    malformedEntries: number
    numericEntries: number
    duplicateEntries: number
  }
}

function displayValue(cell: XLSX.CellObject): string {
  // `w` is Excel's displayed text. Numeric cells are never used as lookup keys because XLSX has already represented
  // them as JavaScript numbers, which cannot preserve a long AWB exactly.
  return String(cell.w ?? cell.v ?? "").trim()
}

function statusFor(cell: XLSX.CellObject, value: string): { status: ScannerEntryStatus; normalizedValue: string } {
  if (!value) return { status: "blank", normalizedValue: "" }
  if (cell.t === "n" || typeof cell.v === "number") return { status: "numeric_identifier", normalizedValue: "" }
  const normalized = normalizeTracking(value)
  if (!normalized.value) return { status: "blank", normalizedValue: "" }
  if (/^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(value)) {
    return { status: "scientific_notation", normalizedValue: "" }
  }
  if (!/^[A-Z0-9_-]{8,100}$/.test(normalized.value)) {
    return { status: "invalid_format", normalizedValue: normalized.value }
  }
  return { status: "valid", normalizedValue: normalized.value }
}

export function parseScannerList(buffer: Buffer): ScannerListParse {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, cellNF: true })
  const sheets: ScannerListSheet[] = []
  const entries: ScannerListEntry[] = []

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    const ref = sheet["!ref"] || ""
    const range = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } }
    const sheetEntries: ScannerListEntry[] = []
    const columns = new Set<number>()
    let nonEmptyCells = 0
    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let column = range.s.c; column <= range.e.c; column++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined
        if (!cell || cell.v === undefined || cell.v === null) continue
        const value = displayValue(cell)
        // Preserve explicit empty cells when the workbook contains them. Uninstantiated cells in the worksheet range
        // are layout whitespace, not scanner entries, and are intentionally ignored.
        if (!value && cell.v !== "") continue
        nonEmptyCells += 1
        columns.add(column + 1)
        const parsed = statusFor(cell, value)
        const entry: ScannerListEntry = {
          sheet: name,
          sourceRow: row + 1,
          sourceColumn: column + 1,
          sourceValue: value,
          normalizedValue: parsed.normalizedValue,
          status: parsed.status,
          duplicate: false,
        }
        sheetEntries.push(entry)
        entries.push(entry)
      }
    }
    sheets.push({
      name,
      sourceRows: ref ? range.e.r - range.s.r + 1 : 0,
      nonEmptyCells,
      columns: [...columns].sort((a, b) => a - b),
      entries: sheetEntries,
    })
  }

  const occurrences = new Map<string, number>()
  for (const entry of entries) {
    if (entry.status === "valid") occurrences.set(entry.normalizedValue, (occurrences.get(entry.normalizedValue) ?? 0) + 1)
  }
  for (const entry of entries) {
    entry.duplicate = entry.status === "valid" && (occurrences.get(entry.normalizedValue) ?? 0) > 1
  }

  return {
    kind: "scanner_list",
    sheets,
    entries,
    counts: {
      sheets: sheets.length,
      entries: entries.length,
      validEntries: entries.filter((entry) => entry.status === "valid").length,
      malformedEntries: entries.filter((entry) => entry.status !== "valid").length,
      numericEntries: entries.filter((entry) => entry.status === "numeric_identifier").length,
      duplicateEntries: entries.filter((entry) => entry.duplicate).length,
    },
  }
}
