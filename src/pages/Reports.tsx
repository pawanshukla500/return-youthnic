import { type ReactNode, useEffect, useState } from "react"
import { api, downloadFile } from "../api"
import { Loading, PageError } from "../shell"
import type { RegisterOptions, RegisterPage, RegisterRow, RegisterTicket, TicketHistoryEntry } from "../types"
import { Badge, Icon, MarketplaceBadge, Modal, PartnerBadge } from "../ui"
import { ShopifyReport } from "../ShopifyReport"

// The return register. Each row is one verified item of a return, or one line of a legacy scan. The default export is the
// 19 columns of the approved mapping, in that order. The operational export adds the service and traceability columns.
// Filters, sorting, pagination and the exports are applied by the server, on the same PostgreSQL data, so the screen and
// the exports always agree, and no account the user cannot see is included.

const PAGE_SIZE = 50

type Row = RegisterRow

type Filters = {
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

type Sort = { key: string; direction: "asc" | "desc" }

// Which columns a file has. "approved" is the default and is exactly the 19 approved columns.
type ExportColumns = "approved" | "operational"

const EMPTY_FILTERS: Filters = {
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

const DEFAULT_SORT: Sort = { key: "date", direction: "desc" }

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
}

function buildQuery(filters: Filters, sort: Sort, page?: number): string {
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
    params.set("pageSize", String(PAGE_SIZE))
  }
  return params.toString()
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))]
}

function issueText(row: Row): string {
  return row.issues.length ? unique(row.issues.map((issue) => issue.categoryLabel)).join("; ") : "No issue"
}

function subIssueText(row: Row): string {
  return unique(row.issues.map((issue) => issue.subIssueLabel)).join("; ")
}

function tickets(row: Row): RegisterTicket[] {
  const found: RegisterTicket[] = []
  for (const issue of row.issues) {
    if (issue.ticket && !found.some((ticket) => ticket.id === issue.ticket?.id)) found.push(issue.ticket)
  }
  return found
}

function ticketStatusTone(status: string): string {
  if (status === "Approved") return "success"
  if (status === "Rejected") return "danger"
  if (status === "Review" || status === "Raised") return "warning"
  return "neutral"
}

const PARTNER_METHOD_LABELS: Record<string, string> = {
  explicit_carrier: "from the file",
  marketplace_mapping: "marketplace mapping",
  tracking_domain: "from the tracking link",
  manual: "entered by hand",
  none: "not identified",
}

const VALIDATION_LABELS: Record<string, string> = {
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

const DISPLAY_KIND_LABELS: Record<string, string> = {
  order_line: "Order line",
  ajio_return_order_number: "Ajio return order number",
  amazon_shipment_id: "Amazon Shipment ID",
}

const TRACKING_SOURCE_LABELS: Record<string, string> = {
  return_tracking: "Return AWB (file column)",
  forward_tracking: "Forward AWB (return AWB blank)",
  tracking_id: "Tracking ID (file column)",
  tracking_url: "Tracking link (verified)",
}

function matchedText(row: Row): string {
  const field =
    row.matchedTrackingField === "alt_tracking_id"
      ? "Forward (alternate) AWB"
      : row.matchedTrackingField === "tracking_id"
        ? "Primary AWB"
        : "Not recorded"
  const leg = row.matchedLeg === "return" ? "return leg" : row.matchedLeg === "forward" ? "forward leg" : "leg not known"
  return row.matchedTrackingField ? `${field}, ${leg}` : "Not recorded"
}

type ColumnDef = {
  key: string
  header: string
  sortable?: boolean
  render: (row: Row) => ReactNode
  sticky?: boolean
}

// The 19 columns of the specification, in order, then the service columns.
const COLUMNS: ColumnDef[] = [
  {
    key: "date",
    header: "Date",
    sortable: true,
    render: (row) => (
      <>
        <strong>{row.scanDay}</strong>
        <small>{row.scanTime}</small>
      </>
    ),
  },
  { key: "marketplace", header: "Marketplace", sortable: true, render: (row) => <MarketplaceBadge name={row.marketplace} /> },
  { key: "tracking", header: "Tracking ID", sortable: true, sticky: true, render: (row) => <strong>{row.trackingId}</strong> },
  { key: "order", header: "Order ID", sortable: true, render: (row) => row.orderId || "—" },
  {
    key: "orderItem",
    header: "Order Item ID",
    sortable: true,
    render: (row) => (
      <>
        {row.orderItemId || "—"}
        {row.displayIdentifierKind && row.displayIdentifierKind !== "order_line" && (
          <small title="This identifier is shown for display only. It is not an order line.">
            {DISPLAY_KIND_LABELS[row.displayIdentifierKind] ?? row.displayIdentifierKind}
          </small>
        )}
      </>
    ),
  },
  { key: "marketplaceSku", header: "Marketplace SKU", sortable: true, render: (row) => row.marketplaceSku || "—" },
  {
    key: "productSku",
    header: "Product SKU",
    sortable: true,
    render: (row) => (row.productSku ? row.productSku : <Badge tone="warning">Not resolved</Badge>),
  },
  {
    key: "identifier",
    header: "Marketplace SKU Identification (FNSKU/ASIN/Myntra FSN)",
    render: (row) => row.marketplaceSkuIdentifier || "—",
  },
  {
    key: "partner",
    header: "Logistic Partner Name",
    sortable: true,
    render: (row) => (
      <>
        <PartnerBadge name={row.logisticPartner || "Unknown / Pending Verification"} />
        {row.partnerMethod && row.partnerMethod !== "none" && row.partnerMethod !== "tracking_domain" && (
          <small>{PARTNER_METHOD_LABELS[row.partnerMethod] ?? row.partnerMethod}</small>
        )}
      </>
    ),
  },
  {
    key: "returnType",
    header: "Return Type",
    sortable: true,
    render: (row) => (
      <>
        {row.returnType || "—"}
        {row.returnTypeRaw && row.returnTypeRaw !== row.returnType && <small>as file: {row.returnTypeRaw}</small>}
      </>
    ),
  },
  { key: "qty", header: "Qty", sortable: true, render: (row) => <strong>{row.expectedQty}</strong> },
  {
    key: "amount",
    header: "Amount",
    render: () => <span title="Awaiting the Sales Database integration. No value is recorded yet.">—</span>,
  },
  { key: "reason", header: "Return Reason", render: (row) => row.returnReason || "—" },
  {
    key: "issue",
    header: "Return Received Issue",
    render: (row) => <span className={row.issues.length ? "issue-text" : "clean"}>{issueText(row)}</span>,
  },
  {
    key: "subIssue",
    header: "Return Received Sub Issue (Only If Missing)",
    render: (row) => subIssueText(row) || "—",
  },
  {
    key: "ticket",
    header: "Ticket ID (Only If Return Received Issue)",
    render: (row) => unique(tickets(row).map((ticket) => ticket.code)).join(", ") || "—",
  },
  {
    key: "ticketStatus",
    header: "Ticket ID Status",
    render: (row) =>
      tickets(row).length
        ? tickets(row).map((ticket) => (
            <Badge key={ticket.id} tone={ticketStatusTone(ticket.status)}>
              {ticket.status}
            </Badge>
          ))
        : "—",
  },
  {
    key: "claimAmount",
    header: "Claim Amount",
    render: () => <span title="Awaiting the claims integration. No value is recorded yet.">—</span>,
  },
  {
    key: "rejection",
    header: "If Rejected, What the Reason",
    render: (row) => unique(tickets(row).map((ticket) => ticket.rejectionReason)).join("; ") || "—",
  },
  { key: "received", header: "Received Qty", render: (row) => (row.receivedQty === null ? "—" : row.receivedQty) },
  { key: "scanner", header: "Scanned By", render: (row) => row.scannedBy },
  {
    key: "source",
    header: "Source",
    render: (row) =>
      row.source === "legacy" ? <Badge tone="neutral">Legacy scan</Badge> : <Badge tone="success">Verified</Badge>,
  },
  {
    key: "matched",
    header: "Matched Tracking",
    render: (row) => (
      <>
        {matchedText(row)}
        {row.trackingValidation && VALIDATION_LABELS[row.trackingValidation] && (
          <small>{VALIDATION_LABELS[row.trackingValidation]}</small>
        )}
      </>
    ),
  },
]

// One ticket with its status, its reason, and its history. Rejecting a ticket needs a reason.
function TicketEditor({
  ticket,
  statuses,
  onSaved,
}: {
  ticket: RegisterTicket
  statuses: string[]
  onSaved: () => void
}) {
  const [status, setStatus] = useState(ticket.status)
  const [reason, setReason] = useState(ticket.rejectionReason)
  const [history, setHistory] = useState<TicketHistoryEntry[]>([])
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  const loadHistory = () => {
    api<{ history: TicketHistoryEntry[] }>(`/api/tickets/${ticket.id}/history`)
      .then((result) => setHistory(result.history))
      .catch((err: Error) => setMessage(err.message))
  }

  useEffect(() => {
    setStatus(ticket.status)
    setReason(ticket.rejectionReason)
    loadHistory()
    // Reload when a different ticket is shown. The history is fetched fresh each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id])

  const save = async () => {
    setBusy(true)
    setMessage("")
    try {
      await api(`/api/tickets/${ticket.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, reason }),
      })
      setMessage("Saved.")
      loadHistory()
      onSaved()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The ticket was not saved.")
    } finally {
      setBusy(false)
    }
  }

  const needsReason = status === "Rejected" && !reason.trim()
  const unchanged = status === ticket.status && (status !== "Rejected" || reason.trim() === ticket.rejectionReason)

  return (
    <section className="panel" style={{ padding: 16, marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <strong>{ticket.code}</strong>
        <Badge tone={ticketStatusTone(ticket.status)}>{ticket.status}</Badge>
      </div>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <label>
          New status
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label={`Status for ${ticket.code}`}>
            {statuses.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Reason {status === "Rejected" ? "(required)" : "(optional)"}
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            aria-label={`Reason for ${ticket.code}`}
          />
        </label>
        {needsReason && <div className="form-error">A rejection needs a reason.</div>}
        {message && <div className={message === "Saved." ? "scan-notice" : "form-error"}>{message}</div>}
        <div>
          <button className="btn primary" onClick={() => void save()} disabled={busy || needsReason || unchanged}>
            Save ticket status
          </button>
        </div>
      </div>
      <h4 style={{ marginTop: 16 }}>History</h4>
      {history.length === 0 && <p>No history yet.</p>}
      {history.map((entry, index) => (
        <div key={`${entry.changedAt}-${index}`} style={{ fontSize: 13, padding: "4px 0" }}>
          <strong>{entry.fromStatus ? `${entry.fromStatus} → ${entry.toStatus}` : `Created as ${entry.toStatus}`}</strong>{" "}
          <span>
            {new Date(entry.changedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
            {entry.changedBy ? ` · ${entry.changedBy}` : ""}
          </span>
          {entry.reason && <div>{entry.reason}</div>}
        </div>
      ))}
    </section>
  )
}

// Every field of one row, for the record view: the 19 columns, then the scan and the file the return came from.
function RecordDetail({ row }: { row: Row }) {
  const traceability: [string, string | number][] = [
    ["Scanned AWB", row.scannedTracking || "Not recorded"],
    ["Original tracking ID (file)", row.originalTrackingId || "—"],
    ["Link tracking ID", row.urlTrackingId || "—"],
    ["Tracking source", TRACKING_SOURCE_LABELS[row.trackingSource] ?? row.trackingSource],
    ["Forward tracking ID", row.forwardTrackingId || "—"],
    ["Return event ID", row.returnEventId || "—"],
    ["Source file", row.sourceFile || "—"],
    ["Import batch", row.sourceBatchId ?? "—"],
    ["Return type (as file)", row.returnTypeRaw || "—"],
    ["Tracking validation", VALIDATION_LABELS[row.trackingValidation] || row.trackingValidation || "—"],
    ["Scan ID", row.scanId],
    ["Scanned at (UTC)", row.scannedAt],
    ["Scan status", row.scanStatus],
    ["Product name", row.productName || "—"],
  ]
  return (
    <div className="record-sheet">
      <dl>
        {COLUMNS.map((column) => (
          <div key={column.key}>
            <dt>{column.header}</dt>
            <dd>{column.render(row)}</dd>
          </div>
        ))}
      </dl>
      <h3>Scan and file</h3>
      <dl>
        {traceability.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function Reports() {
  const [options, setOptions] = useState<RegisterOptions | null>(null)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<RegisterPage | null>(null)
  const [error, setError] = useState("")
  const [exportError, setExportError] = useState("")
  const [exportColumns, setExportColumns] = useState<ExportColumns>("approved")
  const [refreshKey, setRefreshKey] = useState(0)
  const [detail, setDetail] = useState<Row | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showColumns, setShowColumns] = useState(false)
  const [viewMode, setViewMode] = useState<"register" | "shopify">(() => {
    return new URLSearchParams(window.location.search).get("tab") === "shopify" ? "shopify" : "register"
  })

  const changeView = (mode: "register" | "shopify") => {
    setViewMode(mode)
    const url = new URL(window.location.href)
    if (mode === "shopify") url.searchParams.set("tab", "shopify")
    else url.searchParams.delete("tab")
    window.history.replaceState(null, "", url.toString())
  }

  useEffect(() => {
    api<RegisterOptions>("/api/register/options")
      .then(setOptions)
      .catch((err: Error) => setError(err.message))
  }, [])

  // Filters are applied after a short pause, so typing does not send a request for every key press.
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      api<RegisterPage>(`/api/register?${buildQuery(filters, sort, page)}`)
        .then((result) => {
          if (!cancelled) {
            setData(result)
            setError("")
          }
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [filters, sort, page, refreshKey])

  const update = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(1)
  }

  const toggleSort = (key: string) => {
    setSort((current) => {
      if (current.key !== key) return { key, direction: "asc" }
      return { key, direction: current.direction === "asc" ? "desc" : "asc" }
    })
    setPage(1)
  }

  const toggleColumn = (key: string) => {
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // The export uses the same filters and sort as the screen, and the chosen column set. The server builds the file.
  const exportRegister = (format: "csv" | "xlsx") => {
    setExportError("")
    const query = buildQuery(filters, sort)
    const separator = query ? "&" : ""
    downloadFile(
      `/api/register/export?${query}${separator}columns=${exportColumns}&format=${format}`,
      `return-register-${exportColumns}.${format}`,
    ).catch((err: Error) => setExportError(err.message))
  }

  const switcher = (
    <div className="report-view-switcher">
      <button
        type="button"
        className={`report-view-tab ${viewMode === "register" ? "active" : ""}`}
        onClick={() => changeView("register")}
      >
        <Icon name="report" size={16} />
        <span>Return Register (All Accounts)</span>
      </button>
      <button
        type="button"
        className={`report-view-tab ${viewMode === "shopify" ? "active" : ""}`}
        onClick={() => changeView("shopify")}
      >
        <img src="/logos/shopify.svg" alt="Shopify" width={16} height={16} />
        <span>Shopify Returns & RTO</span>
        <span className="shopify-live-indicator" title="Real-time automated sync">● Real-time</span>
      </button>
    </div>
  )

  if (viewMode === "shopify") {
    return (
      <div className="page-content">
        {switcher}
        <ShopifyReport />
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="page-content">
        {switcher}
        <PageError message={error} />
      </div>
    )
  }

  if (!data || !options) {
    return (
      <div className="page-content">
        {switcher}
        <Loading label="Loading the return register…" />
      </div>
    )
  }

  const visible = COLUMNS.filter((column) => !hidden.has(column.key))
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize))
  const start = data.total ? (data.page - 1) * data.pageSize + 1 : 0
  const end = Math.min(data.total, data.page * data.pageSize)
  const selectClass = "filter-button"

  const sortIndicator = (key: string) => (sort.key === key ? (sort.direction === "asc" ? " ▲" : " ▼") : "")

  return (
    <div className="page-content">
      {switcher}
      <section className="report-summary">
        <div>
          <span>VERIFIED LINES</span>
          <strong>{data.total.toLocaleString("en-US")}</strong>
          <small>Matching the current filters, in the accounts you can see</small>
        </div>
        <div>
          <span>SHOWING</span>
          <strong>
            {start}–{end}
          </strong>
          <small>
            Page {data.page} of {pageCount}
          </small>
        </div>
      </section>

      <section className="panel report-table">
        <div className="register-filters">
          <div className="register-row">
          <div className="search-box">
            <Icon name="search" />
            <input
              aria-label="Tracking ID"
              value={filters.tracking}
              onChange={(event) => update({ tracking: event.target.value })}
              placeholder="Tracking ID…"
            />
          </div>
          <div className="search-box">
            <input
              aria-label="Order ID or order item ID"
              value={filters.order}
              onChange={(event) => update({ order: event.target.value })}
              placeholder="Order ID…"
            />
          </div>
          <div className="search-box">
            <input
              aria-label="Marketplace SKU or product SKU"
              value={filters.sku}
              onChange={(event) => update({ sku: event.target.value })}
              placeholder="SKU…"
            />
          </div>
          </div>
          <div className="register-row">
          <select
            className={selectClass}
            aria-label="Marketplace"
            value={filters.marketplaceId}
            onChange={(event) => update({ marketplaceId: event.target.value })}
          >
            <option value="">All accounts</option>
            {options.marketplaces.map((market) => (
              <option key={market.id} value={market.id}>
                {market.name}
              </option>
            ))}
          </select>
          <select
            className={selectClass}
            aria-label="Logistic partner"
            value={filters.partner}
            onChange={(event) => update({ partner: event.target.value })}
          >
            <option value="">All partners</option>
            {options.partners.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            className={selectClass}
            aria-label="Received issue"
            value={filters.issue}
            onChange={(event) => update({ issue: event.target.value })}
          >
            <option value="">All issues</option>
            <option value="no_issue">No issue</option>
            {options.issueCategories
              .filter((category) => category.code !== "no_issue")
              .map((category) => (
                <option key={category.code} value={category.code}>
                  {category.label}
                </option>
              ))}
          </select>
          <select
            className={selectClass}
            aria-label="Ticket status"
            value={filters.ticketStatus}
            onChange={(event) => update({ ticketStatus: event.target.value })}
          >
            <option value="">Any ticket status</option>
            {options.ticketStatuses.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
          <select
            className={selectClass}
            aria-label="Scanner"
            value={filters.scannerId}
            onChange={(event) => update({ scannerId: event.target.value })}
          >
            <option value="">All scanners</option>
            {options.scanners.map((scanner) => (
              <option key={scanner.id} value={scanner.id}>
                {scanner.name}
              </option>
            ))}
          </select>
          <label className={filters.dateFrom ? "date-filter" : "date-filter is-empty"}>
            From
            <span>
              <input
                type="date"
                aria-label="From date"
                value={filters.dateFrom}
                onChange={(event) => update({ dateFrom: event.target.value })}
              />
              {!filters.dateFrom && <em>Any day</em>}
            </span>
          </label>
          <label className={filters.dateTo ? "date-filter" : "date-filter is-empty"}>
            To
            <span>
              <input
                type="date"
                aria-label="To date"
                value={filters.dateTo}
                onChange={(event) => update({ dateTo: event.target.value })}
              />
              {!filters.dateTo && <em>Any day</em>}
            </span>
          </label>
          </div>
          <p className="filter-hint">Leave From and To empty to include every scan day. Pick both to limit the register to that range.</p>
          {filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo && (
            <p className="filter-note">The From date is after the To date, so this range matches no scans.</p>
          )}
          <div className="register-row register-actions">
          <button
            className="btn secondary"
            onClick={() => update(EMPTY_FILTERS)}
            disabled={buildQuery(filters, DEFAULT_SORT) === ""}
          >
            Clear filters
          </button>
          <button className="btn secondary" onClick={() => setShowColumns((value) => !value)} aria-expanded={showColumns}>
            Columns ({visible.length} of {COLUMNS.length})
          </button>
          <select
            className={selectClass}
            aria-label="Export columns"
            value={exportColumns}
            onChange={(event) => setExportColumns(event.target.value as ExportColumns)}
          >
            <option value="approved">Export: approved 19 columns</option>
            <option value="operational">Export: operational (with traceability)</option>
          </select>
          <button className="btn secondary" onClick={() => exportRegister("csv")} disabled={data.total === 0}>
            <Icon name="upload" /> Export CSV ({data.total.toLocaleString("en-US")})
          </button>
          <button className="btn secondary" onClick={() => exportRegister("xlsx")} disabled={data.total === 0}>
            <Icon name="upload" /> Export Excel
          </button>
          </div>
        </div>

        {showColumns && (
          <div
            className="panel"
            style={{ margin: "0 20px 12px", padding: 12, display: "flex", flexWrap: "wrap", gap: "6px 16px" }}
          >
            {COLUMNS.map((column) => (
              <label key={column.key} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!hidden.has(column.key)}
                  onChange={() => toggleColumn(column.key)}
                />
                {column.header}
              </label>
            ))}
          </div>
        )}

        {exportError && (
          <div className="form-error" style={{ margin: "12px 20px 0" }}>
            {exportError}
          </div>
        )}
        {error && (
          <div className="form-error" style={{ margin: "12px 20px 0" }}>
            {error}
          </div>
        )}

        {/* Desktop and tablet: the table scrolls sideways, and the Tracking ID column stays in view. */}
        <div className="table-wrap" style={{ overflowX: "auto" }}>
          <table style={{ width: "max-content", minWidth: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                {visible.map((column) => (
                  <th
                    key={column.key}
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      whiteSpace: "nowrap",
                      position: column.sticky ? "sticky" : undefined,
                      left: column.sticky ? 0 : undefined,
                      background: "#fff",
                      borderBottom: "1px solid #e2e8f0",
                    }}
                    aria-sort={
                      column.sortable && sort.key === column.key
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    {column.sortable ? (
                      <button className="text-button" onClick={() => toggleSort(column.key)} title="Sort">
                        {column.header}
                        {sortIndicator(column.key)}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                ))}
                <th style={{ borderBottom: "1px solid #e2e8f0" }} aria-label="Details" />
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={visible.length + 1} style={{ padding: 20 }}>
                    No verified returns match these filters.
                  </td>
                </tr>
              )}
              {data.rows.map((row) => (
                <tr key={row.key} style={{ borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                  {visible.map((column) => (
                    <td
                      key={column.key}
                      style={{
                        padding: "8px 10px",
                        position: column.sticky ? "sticky" : undefined,
                        left: column.sticky ? 0 : undefined,
                        background: column.sticky ? "#fff" : undefined,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                  <td style={{ padding: "8px 10px" }}>
                    <button
                      className="text-button"
                      onClick={() => setDetail(row)}
                      aria-label={`Details for ${row.trackingId}`}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pagination">
          <span>
            {data.total
              ? `Showing ${start}–${end} of ${data.total.toLocaleString("en-US")}`
              : "No returns match these filters"}
          </span>
          <div>
            <button onClick={() => setPage(data.page - 1)} disabled={data.page <= 1} aria-label="Previous page">
              ‹
            </button>
            <span>
              Page {data.page} of {pageCount}
            </span>
            <button onClick={() => setPage(data.page + 1)} disabled={data.page >= pageCount} aria-label="Next page">
              ›
            </button>
          </div>
        </div>
      </section>

      {detail && (
        <Modal wide onClose={() => setDetail(null)}>
          <div className="record-modal">
            <button className="modal-close" onClick={() => setDetail(null)} aria-label="Close">
              <Icon name="close" />
            </button>
            <span className="eyebrow">Return record</span>
            <h2>{detail.trackingId}</h2>
            <p className="record-lead">
              <MarketplaceBadge name={detail.marketplace} />
              <span>Order {detail.orderId || "—"}</span>
              <span>{detail.productName || detail.marketplaceSku || "—"}</span>
            </p>
            <RecordDetail row={detail} />
            {tickets(detail).map((ticket) => (
              <TicketEditor
                key={ticket.id}
                ticket={ticket}
                statuses={options.ticketStatuses}
                onSaved={() => setRefreshKey((value) => value + 1)}
              />
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}
