// Display formatting shared by the API routes and the return register. Times are Indian Standard Time (IST).

export function formatCount(value: number): string {
  return Number(value).toLocaleString("en-US")
}

export function formatRowCount(value: number): string {
  return `${formatCount(value)} rows`
}

// A share of a total with one decimal place. A zero total has no share yet, so it shows a dash.
export function percentOf(part: number, whole: number): string {
  return whole ? `${((part / whole) * 100).toFixed(1)}%` : "—"
}

export function formatScanTime(date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  }).format(date)
}

export function formatUploadLabel(date = new Date()): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  }).format(date)
  return `${day}, ${formatScanTime(date)}`
}

// Unambiguous timestamp for API strings the client re-parses (e.g. unmapped SKU last-seen).
// formatUploadLabel drops the year, so `new Date(label)` on the client defaults to 2001 —
// never send that display-only shape where the client needs the true date. ISO keeps year + timezone.
export function toIsoTimestamp(value: Date | string | null | undefined): string {
  if (!value) return ""
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toISOString()
}

// For example "9 Oct 2026".
export function formatDay(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(value)
}

// For example "Today, 9 October".
export function headerDateLabel(date = new Date()): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Kolkata",
  }).format(date)
  return `Today, ${day}`
}

// Last sign-in that still has an open session. Signing out removes the session, so this can be empty.
export function lastSignInLabel(value: Date | null): string {
  return value ? formatUploadLabel(value) : "—"
}

// Indian Rupee currency display (e.g. ₹ 1,249.00)
export function formatInr(value: number): string {
  if (value === 0 || isNaN(value)) return "₹0.00"
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value)
}
