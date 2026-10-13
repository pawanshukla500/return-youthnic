// Counts return lifecycle stages per day from stored upload rows.
// Column names come from each marketplace's LifecycleConfig in server/import-profiles.ts.
// Dates are read with parseReportDate, so both report date styles are handled.

import { parseReportDate } from "./dates.js"
import type { LifecycleConfig } from "./import-profiles.js"

export type LifecycleCounts = {
  rows: number
  // Stage counts. With a day given, only rows whose stage date is that day count.
  requested: number
  approved: number
  pickedUp: number
  completed: number
  // Rows whose status text says "delivered". Status has no date in the samples, so this is not day-filtered.
  deliveredStatus: number
}

export function emptyCounts(): LifecycleCounts {
  return { rows: 0, requested: 0, approved: 0, pickedUp: 0, completed: 0, deliveredStatus: 0 }
}

// rows: the stored row_data objects (normalized header name to text value).
// day: YYYY-MM-DD, or "" for all dates.
export function summarizeLifecycle(
  rows: Record<string, string>[],
  config: LifecycleConfig | undefined,
  day = "",
): LifecycleCounts {
  const counts = emptyCounts()
  for (const row of rows) {
    counts.rows++
    const onDay = (column: string | undefined) => {
      if (!column) return false
      const date = parseReportDate(row[column] ?? "")
      return date !== "" && (day === "" || date === day)
    }
    if (onDay(config?.requested)) counts.requested++
    if (onDay(config?.approved)) counts.approved++
    if (onDay(config?.pickedUp)) counts.pickedUp++
    if (onDay(config?.completed)) counts.completed++
    if (day === "" && config?.statusColumn && /deliver/i.test(row[config.statusColumn] ?? "")) {
      counts.deliveredStatus++
    }
  }
  return counts
}
