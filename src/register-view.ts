import type { RegisterRow, RegisterTicket } from "./types"

// Pure view helpers for the return register page (/register). No React, no
// DOM, no network — safe to unit-test with node:test. Reports.tsx renders
// these; the server remains the source of truth for data.

// One page of the register table.
export const REGISTER_PAGE_SIZE = 50

export type RegisterFilters = {
  tracking: string
  order: string
  sku: string
  marketplaceId: string
  partner: string
  issue: string
  ticketStatus: string
  scannerId: string
  dateFrom: string
  dateTo: string
}

export type RegisterSort = { key: string; direction: "asc" | "desc" }

export type RegisterTabKey = "register" | "analytics" | "shopify" | "omsguru"

// Which columns a file has. "approved" is the default and is exactly the 19 approved columns.
export type RegisterExportColumns = "approved" | "operational"

export const EMPTY_FILTERS: RegisterFilters = {
  tracking: "",
  order: "",
  sku: "",
  marketplaceId: "",
  partner: "",
  issue: "",
  ticketStatus: "",
  scannerId: "",
  dateFrom: "",
  dateTo: "",
}

export const DEFAULT_SORT: RegisterSort = { key: "date", direction: "desc" }

// The server accepts these sort names only. Other columns are not sortable.
const SERVER_SORT: Record<string, string> = {
  date: "scanned_at",
  marketplace: "marketplace",
  tracking: "tracking_id",
  order: "order_number",
  orderItem: "order_item_id",
  marketplaceSku: "marketplace_sku",
  productSku: "product_sku",
  partner: "logistic_partner_name",
  returnType: "return_type",
  qty: "expected_qty",
  amount: "amount",
}

export function buildQuery(filters: RegisterFilters, sort: RegisterSort, page?: number): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    const trimmed = value.trim()
    if (trimmed) params.set(key, trimmed)
  }
  const serverKey = SERVER_SORT[sort.key]
  if (serverKey) {
    params.set("sort", serverKey)
    params.set("direction", sort.direction)
  }
  if (page) {
    params.set("page", String(page))
    params.set("pageSize", String(REGISTER_PAGE_SIZE))
  }
  return params.toString()
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))]
}

export function issueText(row: RegisterRow): string {
  return row.issues.length ? unique(row.issues.map((issue) => issue.categoryLabel)).join("; ") : "No issue"
}

export function subIssueText(row: RegisterRow): string {
  return unique(row.issues.map((issue) => issue.subIssueLabel)).join("; ")
}

export function tickets(row: RegisterRow): RegisterTicket[] {
  const found: RegisterTicket[] = []
  const seen = new Set<number>()
  for (const issue of row.issues) {
    if (issue.ticket && !seen.has(issue.ticket.id)) {
      seen.add(issue.ticket.id)
      found.push(issue.ticket)
    }
  }
  return found
}

export function ticketStatusTone(status: string): string {
  if (status === "Approved") return "success"
  if (status === "Rejected") return "danger"
  if (status === "Review" || status === "Raised") return "warning"
  return "neutral"
}

export const PARTNER_METHOD_LABELS: Record<string, string> = {
  explicit_carrier: "from the file",
  marketplace_mapping: "marketplace mapping",
  tracking_domain: "from the tracking link",
  manual: "entered by hand",
  none: "not identified",
}

export const VALIDATION_LABELS: Record<string, string> = {
  not_applicable: "",
  match: "AWB confirmed by the tracking link",
  mismatch_resolved: "AWB taken from the tracking link (rounding)",
  mismatch_kept: "AWB differs from the tracking link. Check the label",
  no_link: "No tracking link to check",
  invalid_link: "Tracking link not readable",
  unverified_host: "Tracking link host not verified",
  blank_awb: "AWB is blank",
  damaged_awb: "AWB is damaged (scientific notation)",
}

export const DISPLAY_KIND_LABELS: Record<string, string> = {
  order_line: "Order line",
  ajio_return_order_number: "Ajio return order number",
  amazon_shipment_id: "Amazon Shipment ID",
}

export const TRACKING_SOURCE_LABELS: Record<string, string> = {
  return_tracking: "Return AWB (file column)",
  forward_tracking: "Forward AWB (return AWB blank)",
  tracking_id: "Tracking ID (file column)",
  tracking_url: "Tracking link (verified)",
}

const MATCHED_FIELD_LABELS: Record<string, string> = {
  alt_tracking_id: "Forward (alternate) AWB",
  tracking_id: "Primary AWB",
  order_number: "Order ID",
}

const MATCHED_LEG_LABELS: Record<string, string> = {
  return: "return leg",
  forward: "forward leg",
}

export function matchedText(row: RegisterRow): string {
  if (!row.matchedTrackingField) return "Not recorded"
  const field = MATCHED_FIELD_LABELS[row.matchedTrackingField] ?? "Not recorded"
  const leg = MATCHED_LEG_LABELS[row.matchedLeg] ?? "leg not known"
  return `${field}, ${leg}`
}

// Flyer line for the record view: the captured ID, or what happened at the bench.
export function flyerLabel(flyerId: string | undefined, flyerState: string | undefined): string {
  if (flyerId) return flyerId
  if (flyerState === "unavailable") return "Unavailable at bench"
  if (flyerState === "scanned") return "—"
  return "Not required"
}

// The four tabs of /register, in order. The tab query param keeps refreshes
// on the same tab. Retired tab params ("reasons", "sizing") fall back to the
// register table; the reason backend and its tests stay for API use.
export type RegisterTab = {
  key: RegisterTabKey
  label: string
  param: string | null
  icon: "report" | "grid" | "upload" | "shopify"
  badge?: { text: string; title: string; className?: string; style?: Record<string, string> }
}

export const VIEW_TABS: RegisterTab[] = [
  { key: "register", label: "Return Register (All Accounts)", param: null, icon: "report" },
  {
    key: "analytics",
    label: "Return Analytics",
    param: "analytics",
    icon: "grid",
    badge: { text: "● Live", title: "Size, SKU, marketplace, date and reason figures from stored scans", className: "shopify-live-indicator" },
  },
  {
    key: "shopify",
    label: "Shopify Returns & RTO",
    param: "shopify",
    icon: "shopify",
    badge: { text: "● Real-time", title: "Real-time automated sync", className: "shopify-live-indicator" },
  },
  {
    key: "omsguru",
    label: "OMSGuru Update Daily",
    param: "omsguru",
    icon: "upload",
    badge: {
      text: "● Daily IST",
      title: "The daily time is set in Admin, System. The default is 11:00 PM IST",
      className: "omsguru-live-indicator",
    },
  },
]

export function parseRegisterTab(param: string | null): RegisterTabKey {
  if (param === "analytics") return "analytics"
  if (param === "omsguru") return "omsguru"
  if (param === "shopify") return "shopify"
  return "register"
}
