import { test } from "node:test"
import assert from "node:assert/strict"
import { formatUploadLabel, toIsoTimestamp } from "../format.js"

// Regression test for the unmapped-table "16 Oct 2001" bug: the server used to send
// formatUploadLabel ("16 Oct, 2:30 PM" — no year) as lastSeenAt, and the client
// re-parsed it with `new Date()`, which defaults a missing year to 2001.
// The server must now emit unambiguous ISO strings; the client formats them in IST
// and renders NULL/invalid timestamps as "—" without fabricating a date.
// (Timestamps below are fixed synthetic values, not marketplace data.)

// Mirrors src/pages/Admin.tsx formatUnmappedSeen so the contract is locked on both sides.
const SEEN_FORMAT = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
})

function formatUnmappedSeen(value: string | null | undefined): string {
  if (!value) return "—"
  if (!/\d{4}|T\d{2}:/.test(value)) return value
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : SEEN_FORMAT.format(date)
}

test("formatUploadLabel drops the year, so re-parsing it loses the true date", () => {
  const seen = new Date("2026-10-16T09:00:00.000Z")
  const label = formatUploadLabel(seen)
  assert.ok(!/\d{4}/.test(label), `label must carry no year, got ${JSON.stringify(label)}`)
  const reparsed = new Date(label)
  assert.notEqual(reparsed.getFullYear(), 2026, "year-less label must never round-trip the true year")
})

test("toIsoTimestamp emits an unambiguous string that round-trips the true date", () => {
  const iso = toIsoTimestamp(new Date("2026-10-16T09:00:00.000Z"))
  assert.equal(iso, "2026-10-16T09:00:00.000Z")
  assert.equal(new Date(iso).getFullYear(), 2026)
  assert.equal(toIsoTimestamp("2026-10-16T09:00:00.000Z"), "2026-10-16T09:00:00.000Z")
})

test("toIsoTimestamp never fabricates a date from NULL/invalid input", () => {
  assert.equal(toIsoTimestamp(null), "")
  assert.equal(toIsoTimestamp(undefined), "")
  assert.equal(toIsoTimestamp(""), "")
  assert.equal(toIsoTimestamp("not-a-date"), "")
})

test("client format shows the true IST date for ISO input, never 2001", () => {
  const rendered = formatUnmappedSeen("2026-10-16T09:00:00.000Z")
  assert.ok(rendered.includes("2026"), `expected year 2026, got ${JSON.stringify(rendered)}`)
  assert.ok(!rendered.includes("2001"), `must never show 2001, got ${JSON.stringify(rendered)}`)
})

test("client format renders NULL/invalid as a dash and legacy labels as-is", () => {
  assert.equal(formatUnmappedSeen(""), "—")
  assert.equal(formatUnmappedSeen(null), "—")
  assert.equal(formatUnmappedSeen(undefined), "—")
  assert.equal(formatUnmappedSeen("garbage-T99:99"), "—")
  // Legacy year-less server shape: displayed untouched, no fabricated year.
  assert.equal(formatUnmappedSeen("16 Oct, 2:30 PM"), "16 Oct, 2:30 PM")
})
