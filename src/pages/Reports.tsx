import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react"
import { api, downloadFile } from "../api"
import { DateField } from "../date-field"
import { Loading, PageError } from "../shell"
import type { RegisterOptions, RegisterPage, RegisterRow, RegisterTicket, TicketHistoryEntry } from "../types"
import { Badge, Icon, MarketplaceBadge, Modal, PartnerBadge } from "../ui"
import {
  DEFAULT_SORT,
  DISPLAY_KIND_LABELS,
  EMPTY_FILTERS,
  PARTNER_METHOD_LABELS,
  TRACKING_SOURCE_LABELS,
  VALIDATION_LABELS,
  VIEW_TABS,
  buildQuery,
  flyerLabel,
  issueText,
  matchedText,
  parseRegisterTab,
  subIssueText,
  ticketStatusTone,
  tickets,
  unique,
  type RegisterExportColumns,
  type RegisterFilters,
  type RegisterSort,
  type RegisterTab,
  type RegisterTabKey,
} from "../register-view"
import { useLiveChanges } from "../live"

// The return register. Each row is one verified item of a return, or one line of a legacy scan. The default export is the
// 19 columns of the approved mapping, in that order. The operational export adds the service and traceability columns.
// Filters, sorting, pagination and the exports are applied by the server, on the same PostgreSQL data, so the screen and
// the exports always agree, and no account the user cannot see is included.
//
// The four analysis tabs are code-split: each loads on first open, so the register table stays fast on warehouse PCs.

function lazyNamed<T>(load: () => Promise<T>, name: keyof T) {
  return lazy(() => load().then((module) => ({ default: module[name] as ComponentType })))
}

const AnalyticsReport = lazyNamed(() => import("../AnalyticsReport"), "AnalyticsReport")
const ShopifyReport = lazyNamed(() => import("../ShopifyReport"), "ShopifyReport")
const OmsguruDailyReport = lazyNamed(() => import("../OmsguruDailyReport"), "OmsguruDailyReport")

// Analysis tabs behind the switcher: label, loading text, and component.
const TAB_PANELS: Partial<Record<RegisterTabKey, { tab: RegisterTab; loading: string; Panel: ComponentType }>> = {
  analytics: { tab: VIEW_TABS[1], loading: "Loading return analytics…", Panel: AnalyticsReport },
  shopify: { tab: VIEW_TABS[2], loading: "Loading Shopify returns…", Panel: ShopifyReport },
  omsguru: { tab: VIEW_TABS[3], loading: "Loading OMSGuru update…", Panel: OmsguruDailyReport },
}

type Row = RegisterRow

// One row plus its derived labels, computed once per dataset so the table
// does not re-derive tickets and issue text on every render.
type EnrichedRow = {
  row: Row
  issue: string
  subIssue: string
  ticketList: RegisterTicket[]
  ticketCodes: string
  rejectionText: string
  matched: string
}

function enrich(row: Row): EnrichedRow {
  const ticketList = tickets(row)
  return {
    row,
    issue: issueText(row),
    subIssue: subIssueText(row),
    ticketList,
    ticketCodes: unique(ticketList.map((ticket) => ticket.code)).join(", ") || "—",
    rejectionText: unique(ticketList.map((ticket) => ticket.rejectionReason)).join("; ") || "—",
    matched: matchedText(row),
  }
}

type ColumnDef = {
  key: string
  header: string
  sortable?: boolean
  render: (entry: EnrichedRow) => ReactNode
  sticky?: boolean
}

// The 19 columns of the specification, in order, then the service columns.
const COLUMNS: ColumnDef[] = [
  {
    key: "date",
    header: "Date",
    sortable: true,
    render: (entry) => (
      <>
        <strong>{entry.row.scanDay}</strong>
        <small>{entry.row.scanTime}</small>
      </>
    ),
  },
  {
    key: "marketplace",
    header: "Marketplace",
    sortable: true,
    render: (entry) => <MarketplaceBadge name={entry.row.marketplace} />,
  },
  {
    key: "tracking",
    header: "Tracking ID",
    sortable: true,
    sticky: true,
    render: (entry) => <strong>{entry.row.trackingId}</strong>,
  },
  { key: "order", header: "Order ID", sortable: true, render: (entry) => entry.row.orderId || "—" },
  {
    key: "orderItem",
    header: "Order Item ID",
    sortable: true,
    render: (entry) => (
      <>
        {entry.row.orderItemId || "—"}
        {entry.row.displayIdentifierKind && entry.row.displayIdentifierKind !== "order_line" && (
          <small title="This identifier is shown for display only. It is not an order line.">
            {DISPLAY_KIND_LABELS[entry.row.displayIdentifierKind] ?? entry.row.displayIdentifierKind}
          </small>
        )}
      </>
    ),
  },
  {
    key: "marketplaceSku",
    header: "Marketplace SKU",
    sortable: true,
    render: (entry) => entry.row.marketplaceSku || "—",
  },
  {
    key: "productSku",
    header: "Product SKU",
    sortable: true,
    render: (entry) =>
      entry.row.productSku ? entry.row.productSku : <Badge tone="warning">Not resolved</Badge>,
  },
  {
    key: "identifier",
    header: "Marketplace SKU Identification (FNSKU/ASIN/Myntra FSN)",
    render: (entry) => entry.row.marketplaceSkuIdentifier || "—",
  },
  {
    key: "partner",
    header: "Logistic Partner Name",
    sortable: true,
    render: (entry) => (
      <>
        <PartnerBadge name={entry.row.logisticPartner || "Unknown / Pending Verification"} />
        {entry.row.partnerMethod && entry.row.partnerMethod !== "none" && entry.row.partnerMethod !== "tracking_domain" && (
          <small>{PARTNER_METHOD_LABELS[entry.row.partnerMethod] ?? entry.row.partnerMethod}</small>
        )}
      </>
    ),
  },
  {
    key: "returnType",
    header: "Return Type",
    sortable: true,
    render: (entry) => (
      <>
        {entry.row.returnType || "—"}
        {entry.row.returnTypeRaw && entry.row.returnTypeRaw !== entry.row.returnType && (
          <small>as file: {entry.row.returnTypeRaw}</small>
        )}
      </>
    ),
  },
  { key: "qty", header: "Qty", sortable: true, render: (entry) => <strong>{entry.row.expectedQty}</strong> },
  {
    key: "amount",
    header: "Amount",
    sortable: true,
    render: (entry) =>
      entry.row.amount !== null && entry.row.amount !== undefined ? (
        <strong style={{ color: "#0f6b56" }}>
          ₹{Number(entry.row.amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </strong>
      ) : (
        <span title="Sales amount pending sync" style={{ color: "#94a3b8" }}>
          —
        </span>
      ),
  },
  { key: "reason", header: "Return Reason", render: (entry) => entry.row.returnReason || "—" },
  {
    key: "issue",
    header: "Return Received Issue",
    render: (entry) => <span className={entry.row.issues.length ? "issue-text" : "clean"}>{entry.issue}</span>,
  },
  {
    // Iron Send is operational, not a return issue, so it has its own column.
    key: "ironSend",
    header: "Iron Send",
    render: (entry) =>
      entry.row.ironSendQty ? (
        <span className="iron-state state-pending" title="Sent for ironing. Not a return issue. Tracked on Iron tracking.">
          Iron Send ×{entry.row.ironSendQty}
        </span>
      ) : (
        "—"
      ),
  },
  {
    // Meesho flyer ID captured at the bench for an issue return (permanent claim evidence).
    key: "flyer",
    header: "Meesho Flyer ID",
    render: (entry) =>
      entry.row.flyerId ? (
        <span title={`Flyer status: ${entry.row.flyerState || "scanned"}`}>
          <strong>{entry.row.flyerId}</strong>
        </span>
      ) : entry.row.flyerState === "unavailable" ? (
        <span title="The flyer was missing at the bench. No ID was stored.">
          <Badge tone="warning">Unavailable</Badge>
        </span>
      ) : (
        "—"
      ),
  },
  {
    key: "subIssue",
    header: "Return Received Sub Issue (Only If Missing)",
    render: (entry) => entry.subIssue || "—",
  },
  {
    key: "ticket",
    header: "Ticket ID (Only If Return Received Issue)",
    render: (entry) => entry.ticketCodes,
  },
  {
    key: "ticketStatus",
    header: "Ticket ID Status",
    render: (entry) =>
      entry.ticketList.length
        ? entry.ticketList.map((ticket) => (
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
    render: (entry) => entry.rejectionText,
  },
  {
    key: "received",
    header: "Received Qty",
    render: (entry) => (entry.row.receivedQty === null ? "—" : entry.row.receivedQty),
  },
  { key: "scanner", header: "Scanned By", render: (entry) => entry.row.scannedBy },
  {
    key: "source",
    header: "Source",
    render: (entry) =>
      entry.row.source === "legacy" ? <Badge tone="neutral">Legacy scan</Badge> : <Badge tone="success">Verified</Badge>,
  },
  {
    key: "matched",
    header: "Matched Tracking",
    render: (entry) => (
      <>
        {entry.matched}
        {entry.row.trackingValidation && VALIDATION_LABELS[entry.row.trackingValidation] && (
          <small>{VALIDATION_LABELS[entry.row.trackingValidation]}</small>
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
    let cancelled = false
    setStatus(ticket.status)
    setReason(ticket.rejectionReason)
    api<{ history: TicketHistoryEntry[] }>(`/api/tickets/${ticket.id}/history`)
      .then((result) => {
        if (!cancelled) setHistory(result.history)
      })
      .catch((err: Error) => {
        if (!cancelled) setMessage(err.message)
      })
    // Reload when a different ticket is shown. The history is fetched fresh each time.
    // A slow reply for a previous ticket never overwrites the current one.
    return () => {
      cancelled = true
    }
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
  const entry = enrich(row)
  const traceability: [string, string | number][] = [
    ["Meesho flyer ID (claim)", flyerLabel(row.flyerId, row.flyerState)],
    ["Flyer status", row.flyerState || "not_required"],
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
            <dd>{column.render(entry)}</dd>
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

function TabPanel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="page-content" role="tabpanel" aria-label={label}>
      {children}
    </div>
  )
}

export function Reports() {
  const [options, setOptions] = useState<RegisterOptions | null>(null)
  const [filters, setFilters] = useState<RegisterFilters>(EMPTY_FILTERS)
  const [sort, setSort] = useState<RegisterSort>(DEFAULT_SORT)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<RegisterPage | null>(null)
  const [error, setError] = useState("")
  const [exportError, setExportError] = useState("")
  const [exportColumns, setExportColumns] = useState<RegisterExportColumns>("approved")
  const [refreshKey, setRefreshKey] = useState(0)
  const [detail, setDetail] = useState<Row | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showColumns, setShowColumns] = useState(false)
  const [viewMode, setViewMode] = useState<RegisterTabKey>(() => parseRegisterTab(new URLSearchParams(window.location.search).get("tab")))

  const changeView = (mode: RegisterTabKey) => {
    setViewMode(mode)
    const tab = VIEW_TABS.find((entry) => entry.key === mode)
    const url = new URL(window.location.href)
    if (tab?.param) url.searchParams.set("tab", tab.param)
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

  // A scan saved on another screen or phone shows up in the register without a manual refresh.
  useLiveChanges(() => {
    if (viewMode === "register") setRefreshKey((key) => key + 1)
  }, 1000)

  // Derived labels are computed once per dataset, not once per cell per render.
  const enriched = useMemo(() => (data ? data.rows.map(enrich) : []), [data])

  const update = (patch: Partial<RegisterFilters>) => {
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
    <div className="report-view-switcher" role="tablist" aria-label="Register views">
      {VIEW_TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={viewMode === tab.key}
          className={`report-view-tab ${viewMode === tab.key ? "active" : ""}`}
          onClick={() => changeView(tab.key)}
        >
          {tab.icon === "shopify" ? (
            <img src="/logos/shopify.svg" alt="" width={16} height={16} aria-hidden="true" />
          ) : (
            <Icon name={tab.icon} size={16} />
          )}
          <span>{tab.label}</span>
          {tab.badge && (
            <span className={tab.badge.className} style={tab.badge.style} title={tab.badge.title}>
              {tab.badge.text}
            </span>
          )}
        </button>
      ))}
    </div>
  )

  if (viewMode !== "register") {
    const panel = TAB_PANELS[viewMode]
    if (panel) {
      return (
        <TabPanel label={panel.tab.label}>
          {switcher}
          <Suspense fallback={<Loading label={panel.loading} />}>
            <panel.Panel />
          </Suspense>
        </TabPanel>
      )
    }
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
      <section className="report-summary" aria-label="Register totals">
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

      <section className="panel report-table" aria-label="Return register table">
        <div className="register-filters">
          <div className="register-row register-search-row">
            <div className="search-box">
              <Icon name="search" />
              <input
                aria-label="Tracking ID"
                value={filters.tracking}
                onChange={(event) => update({ tracking: event.target.value })}
                placeholder="Tracking ID…"
                autoComplete="off"
              />
            </div>
            <div className="search-box">
              <input
                aria-label="Order ID or order item ID"
                value={filters.order}
                onChange={(event) => update({ order: event.target.value })}
                placeholder="Order ID…"
                autoComplete="off"
              />
            </div>
            <div className="search-box">
              <input
                aria-label="Marketplace SKU or product SKU"
                value={filters.sku}
                onChange={(event) => update({ sku: event.target.value })}
                placeholder="SKU…"
                autoComplete="off"
              />
            </div>
          </div>
          <div className="register-row register-select-row">
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
          <label className="date-filter">
            From
            <span>
              <DateField
                label="From date"
                placeholder="Any day"
                value={filters.dateFrom}
                onChange={(value) => update({ dateFrom: value })}
              />
            </span>
          </label>
          <label className="date-filter">
            To
            <span>
              <DateField
                label="To date"
                placeholder="Any day"
                value={filters.dateTo}
                onChange={(value) => update({ dateTo: value })}
              />
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
            onChange={(event) => setExportColumns(event.target.value as RegisterExportColumns)}
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
        <div className="table-wrap">
          <table className="register-table-grid">
            <thead>
              <tr>
                {visible.map((column) => (
                  <th
                    key={column.key}
                    className={column.sticky ? "sticky-col" : undefined}
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
                <th aria-label="Details" />
              </tr>
            </thead>
            <tbody>
              {enriched.length === 0 && (
                <tr>
                  <td colSpan={visible.length + 1} style={{ padding: 20 }}>
                    No verified returns match these filters.
                  </td>
                </tr>
              )}
              {enriched.map((entry) => (
                <tr key={entry.row.key}>
                  {visible.map((column) => (
                    <td key={column.key} className={column.sticky ? "sticky-col" : undefined}>
                      {column.render(entry)}
                    </td>
                  ))}
                  <td>
                    <button
                      className="text-button"
                      onClick={() => setDetail(entry.row)}
                      aria-label={`Details for ${entry.row.trackingId}`}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <nav className="pagination" aria-label="Register pages">
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
        </nav>
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
