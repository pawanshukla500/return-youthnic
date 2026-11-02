/**
 * Nightly claim-tracking window (Asia/Kolkata 01:00-02:00) and 48-hour eligibility.
 *
 * Pure and dependency-free on purpose: the Express server (record/reschedule
 * path) and the desktop engine (lease-gate path) share this exact file, so the
 * window can never drift between the two sides. IST is a fixed UTC+05:30 with
 * no daylight saving, so wall-clock arithmetic with a constant offset is exact.
 *
 * Rules enforced:
 * - Only claims submitted AND verified >= 48h earlier are eligible. The anchor
 *   is the confirmed marketplace submission timestamp, never scan/claim dates.
 * - The first check lands in the earliest nightly window after eligibility.
 * - Unresolved claims re-enter later nightly windows via rescheduling.
 * - The same claim is never checked twice in one window (48h cadence >> 1h
 *   window, plus the server lease).
 * - Missed windows are NOT caught up outside the window: due rows simply wait
 *   for the next window (leases expire back to `scheduled`).
 */

export const NIGHTLY_WINDOW_START_HOUR_IST = 1
export const NIGHTLY_WINDOW_END_HOUR_IST = 2
export const FOLLOW_UP_ELIGIBILITY_HOURS = 48
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** Wall-clock fields of `date` in Asia/Kolkata. */
export function istWallClock(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

/** Start of the nightly window (01:00 IST) on the IST calendar day containing `date`. */
export function nightlyWindowStartForIstDay(date: Date): Date {
  const wall = istWallClock(date)
  return new Date(Date.UTC(wall.year, wall.month, wall.day, NIGHTLY_WINDOW_START_HOUR_IST, 0, 0, 0) - IST_OFFSET_MS)
}

/** True when `at` falls inside [01:00, 02:00) Asia/Kolkata. */
export function isWithinNightlyWindow(at: Date): boolean {
  const wall = istWallClock(at)
  const minutes = wall.hour * 60 + wall.minute
  return minutes >= NIGHTLY_WINDOW_START_HOUR_IST * 60 && minutes < NIGHTLY_WINDOW_END_HOUR_IST * 60
}

/**
 * Eligibility for automatic checking: the confirmed marketplace submission
 * timestamp must be at least 48h old. Claims younger than that are never
 * checked automatically, no matter when the worker runs.
 */
export function isEligibleForNightlyCheck(submittedAt: Date, now: Date): boolean {
  if (!(submittedAt instanceof Date) || Number.isNaN(submittedAt.getTime())) return false
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false
  return now.getTime() - submittedAt.getTime() >= FOLLOW_UP_ELIGIBILITY_HOURS * 60 * 60 * 1000
}

/** Start of the next nightly window at or after `from`. */
export function nextNightlyWindowStart(from: Date): Date {
  const todayStart = nightlyWindowStartForIstDay(from)
  if (from.getTime() <= todayStart.getTime()) return todayStart
  return new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
}

/**
 * Next eligible check time for an unresolved ticket: the 48h-cadence candidate,
 * aligned into a nightly window. A candidate already inside the window is kept
 * (never double-checked: cadence >> window), otherwise it moves to the next
 * window start. Missed windows are not caught up outside the window.
 */
export function nextEligibleCheckAt(from: Date, intervalHours = FOLLOW_UP_ELIGIBILITY_HOURS): Date {
  const candidate = new Date(from.getTime() + intervalHours * 60 * 60 * 1000)
  if (isWithinNightlyWindow(candidate)) return candidate
  return nextNightlyWindowStart(candidate)
}

/** Milliseconds until the next nightly window starts (for status display). */
export function msUntilNightlyWindow(from: Date): number {
  if (isWithinNightlyWindow(from)) return 0
  return Math.max(0, nextNightlyWindowStart(from).getTime() - from.getTime())
}
