// Date handling for marketplace report columns and OMSGuru day windows.
//
// parseReportDate returns YYYY-MM-DD, or "" when the value is not a date. Formats seen in the samples:
//  - ISO, with or without a time:      2026-10-02   2026-10-02 15:58:58      (Meesho)
//  - Day, month name, year:            6 October, 2026                       (Flipkart)
//  - Month/day/year with slashes:      9/19/2026   4/24/26                   (Myntra; M/D/YYYY)
//  - Day-month-year with dashes:       08-10-2026                            (Flipkart invoice date; DD-MM-YYYY)
// A value that is only a time, such as "09:07.0", returns "".

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

function ymd(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return ""
  if (month < 1 || month > 12 || day < 1 || day > 31) return ""
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return ""
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export function parseReportDate(value: string): string {
  const text = value.trim()
  if (!text) return ""

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/)
  if (match) return ymd(Number(match[1]), Number(match[2]), Number(match[3]))

  match = text.match(/^(\d{1,2}) ([A-Za-z]+),? (\d{4})$/)
  if (match) {
    const month = MONTHS[match[2].toLowerCase()]
    return month ? ymd(Number(match[3]), month, Number(match[1])) : ""
  }

  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (match) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])
    return ymd(year, Number(match[1]), Number(match[2]))
  }

  match = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (match) return ymd(Number(match[3]), Number(match[2]), Number(match[1]))

  return ""
}

// Unix seconds for the first and last second of an IST calendar day (UTC+5:30, no daylight saving).
export function istDayUnixRange(day: string): { start: number; end: number } | null {
  const match = day.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - (5 * 60 + 30) * 60_000
  const start = Math.floor(startMs / 1000)
  return { start, end: start + 86_399 }
}

// The IST calendar day (YYYY-MM-DD) of a moment.
export function istDay(date: Date): string {
  return new Date(date.getTime() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10)
}

// Yesterday in IST, for the default daily run.
export function istYesterday(now = new Date()): string {
  return istDay(new Date(now.getTime() - 24 * 3600_000))
}
