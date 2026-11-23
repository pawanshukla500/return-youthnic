import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FollowUpRow, FollowUpsResponse } from '../types/engine'
import { apiGet, EngineApiError } from '../services/engineApi'
import { useSession } from '../state/SessionContext'
import { DataTable, type DataTableColumn } from '../components/ui/DataTable'
import { MarketplaceBadge } from '../components/ui/MarketplaceBadge'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Spinner } from '../components/ui/Spinner'
import { StatCard } from '../components/ui/StatCard'

export function followUpSummaryText(summary: FollowUpsResponse['summary'] | undefined | null, hasError: boolean): string {
  if (summary) {
    return `(${summary.active ?? 0} tracking · ${summary.due ?? 0} due now · ${summary.resolved ?? 0} resolved)`
  }
  return hasError ? '(unavailable)' : ''
}

const POLL_MS = 60_000

const STOP_REASON_LABELS: Record<string, string> = {
  ticket_resolved: 'resolved',
  check_not_supported: 'tracking not supported',
  repeated_errors: 'stopped: repeated errors',
  max_checks_reached: 'stopped: max checks',
}

/**
 * Relative-time text for a check timestamp. Past times read 'just now',
 * '5m ago', '3h ago', '2d ago'; future times read 'in 5m', 'in 3h', 'in 2d'.
 * `now` is injectable so tests stay deterministic.
 */
export function whenText(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!then) return '—'
  const diffMin = Math.round((then - now) / 60000)
  const abs = Math.abs(diffMin)
  if (abs < 1) return 'just now'
  const amount = abs < 60 ? `${abs}m` : abs < 2880 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`
  return diffMin >= 0 ? `in ${amount}` : `${amount} ago`
}

type FollowUpStateInput = Pick<FollowUpRow, 'isActive' | 'errorStreak' | 'checkIntervalHours' | 'stopReason'>

const RESPONSE_TRIGGER_WORDS = [
  'provide',
  'upload',
  'reply',
  'action required',
  'waiting for you',
  'share proof',
  'seller response',
] as const

/**
 * Detects if a ticket follow-up requires action or response from the seller.
 */
export function isResponseNeeded(row: Pick<FollowUpRow, 'claimStatus' | 'statusAtLastCheck'>): boolean {
  const combined = `${row.claimStatus || ''} ${row.statusAtLastCheck || ''}`.toLowerCase()
  return RESPONSE_TRIGGER_WORDS.some((word) => combined.includes(word))
}

/**
 * One-line lifecycle state for a follow-up row, matching the engine
 * dashboard: active rows report their check cadence (or an error streak),
 * stopped rows report why they stopped.
 */
export function followUpStateLabel(row: FollowUpStateInput & { statusAtLastCheck?: string; claimStatus?: string }): string {
  if (row.isActive) {
    if (isResponseNeeded(row as any)) return 'action required'
    if (row.errorStreak > 0) return `errors ×${row.errorStreak}`
    return `checking every ${Math.round(row.checkIntervalHours || 48)}h`
  }
  return STOP_REASON_LABELS[row.stopReason ?? ''] ?? 'stopped'
}

function stateToneClass(row: FollowUpStateInput & { statusAtLastCheck?: string; claimStatus?: string }): string {
  if (row.isActive) {
    if (isResponseNeeded(row as any)) return 'text-amber font-semibold'
    return row.errorStreak > 0 ? 'text-orange' : 'text-green'
  }
  if (row.stopReason === 'repeated_errors') return 'text-red'
  if (row.stopReason === 'max_checks_reached') return 'text-orange'
  return 'text-muted'
}

/** Rows carry the backend `id`; fall back to a composite when it is absent. */
function followUpRowKey(row: FollowUpRow): string {
  const id = (row as Record<string, unknown>).id
  if (typeof id === 'number' && Number.isFinite(id)) return `fu-${id}`
  return [row.marketplace, row.accountName, row.orderNumber, row.marketplaceClaimId, row.checkCount].join('|')
}

export type StatusTab = 'all' | 'action_required' | 'active' | 'resolved'
export type MarketplaceFilter = 'all' | 'meesho' | 'flipkart' | 'myntra'

/**
 * Pure filter function for follow-up rows, used both in the UI and in tests.
 */
export function filterFollowUps(
  rows: FollowUpRow[],
  query: string,
  marketplaceFilter: string,
  statusTab: string,
): FollowUpRow[] {
  const q = query.trim().toLowerCase()
  const m = marketplaceFilter.trim().toLowerCase()
  const s = statusTab.trim().toLowerCase()

  return rows.filter((row) => {
    // 1. Marketplace filter
    if (m && m !== 'all') {
      const rowMarketplace = (row.marketplace || '').toLowerCase()
      if (!rowMarketplace.includes(m)) return false
    }

    // 2. Status tab filter
    if (s && s !== 'all') {
      if (s === 'action_required') {
        if (!isResponseNeeded(row)) return false
      } else if (s === 'active') {
        if (!row.isActive) return false
      } else if (s === 'resolved') {
        const isResolved =
          !row.isActive &&
          (row.stopReason === 'ticket_resolved' ||
            row.claimStatus?.toLowerCase() === 'approved' ||
            row.claimStatus?.toLowerCase() === 'rejected')
        if (!isResolved) return false
      }
    }

    // 3. Search query
    if (q) {
      const ticketId = (row.marketplaceClaimId || '').toLowerCase()
      const orderNum = (row.orderNumber || '').toLowerCase()
      const subOrder = (row.subOrderId || '').toLowerCase()
      const awb = (row.awb || '').toLowerCase()
      const account = (row.accountName || '').toLowerCase()
      const lastCheck = (row.statusAtLastCheck || '').toLowerCase()
      const status = (row.claimStatus || '').toLowerCase()

      const matches =
        ticketId.includes(q) ||
        orderNum.includes(q) ||
        subOrder.includes(q) ||
        awb.includes(q) ||
        account.includes(q) ||
        lastCheck.includes(q) ||
        status.includes(q)

      if (!matches) return false
    }

    return true
  })
}

function CopyTicketButton({ ticketId }: { ticketId: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(ticketId)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        const ta = document.createElement('textarea')
        ta.value = ticketId
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    },
    [ticketId],
  )

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy Ticket ID'}
      aria-label={copied ? 'Copied!' : 'Copy Ticket ID'}
      className="inline-flex items-center rounded p-1 text-muted hover:bg-surface-2 hover:text-ink transition-colors"
    >
      {copied ? (
        <svg className="h-3.5 w-3.5 text-green" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

const columns: Array<DataTableColumn<FollowUpRow>> = [
  {
    key: 'marketplace',
    header: 'Marketplace',
    render: (row) => (
      <div>
        <div className="flex items-center gap-1.5">
          <MarketplaceBadge marketplace={row.marketplace || '—'} />
          <span className="text-xs font-medium text-ink">{row.accountName}</span>
        </div>
        <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted font-mono">
          {row.orderNumber ? <span>Order: {row.orderNumber}</span> : null}
          {row.subOrderId ? <span className="text-ink font-semibold">Sub: {row.subOrderId}</span> : null}
          {row.awb ? <span>AWB: {row.awb}</span> : null}
        </div>
      </div>
    ),
  },
  {
    key: 'marketplaceClaimId',
    header: 'Ticket ID',
    render: (row) =>
      row.marketplaceClaimId ? (
        <div className="inline-flex items-center gap-1">
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">{row.marketplaceClaimId}</code>
          <CopyTicketButton ticketId={row.marketplaceClaimId} />
        </div>
      ) : (
        <span className="text-muted">—</span>
      ),
  },
  {
    key: 'claimStatus',
    header: 'Claim status',
    render: (row) => {
      const needsAction = isResponseNeeded(row)
      return (
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-ink">{row.claimStatus || '—'}</span>
            {needsAction ? <Badge variant="orange">Action Required</Badge> : null}
            {typeof row.approvedAmount === 'number' && row.approvedAmount > 0 ? (
              <Badge variant="green" title="Approved settlement payout">
                +₹{row.approvedAmount.toFixed(2)}
              </Badge>
            ) : typeof row.claimAmount === 'number' && row.claimAmount > 0 ? (
              <span className="text-[11px] font-mono text-muted">₹{row.claimAmount.toFixed(2)}</span>
            ) : null}
          </div>
          {row.statusAtLastCheck ? (
            <div className="mt-0.5 max-w-[280px] break-words text-[11px] text-muted">{row.statusAtLastCheck}</div>
          ) : null}
        </div>
      )
    },
  },
  {
    key: 'lastCheckedAt',
    header: 'Last check',
    render: (row) => whenText(row.lastCheckedAt),
  },
  {
    key: 'nextCheckAt',
    header: 'Next check',
    render: (row) => (row.isActive ? whenText(row.nextCheckAt) : '—'),
  },
  {
    key: 'checkCount',
    header: 'Checks',
    render: (row) => row.checkCount ?? 0,
  },
  {
    key: 'state',
    header: 'State',
    render: (row) => (
      <div>
        <span className={`text-xs font-semibold ${stateToneClass(row)}`}>{followUpStateLabel(row)}</span>
        {row.lastError ? (
          <div className="mt-0.5 max-w-[260px] truncate text-[11px] text-muted" title={row.lastError}>
            {row.lastError}
          </div>
        ) : null}
      </div>
    ),
  },
]

export default function FollowUpsPage() {
  const [data, setData] = useState<FollowUpsResponse | null>(null)
  const [error, setError] = useState<EngineApiError | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusTab, setStatusTab] = useState<StatusTab>('all')
  const [marketplaceFilter, setMarketplaceFilter] = useState<MarketplaceFilter>('all')
  const { handleAuthError } = useSession()

  // Poll the engine directly: fetch with pageSize=500 to cover all tracked claims
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      try {
        const result = await apiGet<FollowUpsResponse>('/api/follow-ups?pageSize=500')
        if (cancelled) return
        setData(result)
        setError(null)
      } catch (cause) {
        if (cancelled) return
        handleAuthError(cause)
        setError(
          cause instanceof EngineApiError
            ? cause
            : new EngineApiError(0, cause instanceof Error ? cause.message : String(cause)),
        )
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refreshKey, handleAuthError])

  const retry = useCallback(() => setRefreshKey((key) => key + 1), [])

  const rows = data?.rows ?? []
  const summary = data?.summary
  const headlineCount = followUpSummaryText(summary, Boolean(error))

  // Metrics
  const totalTracked = data?.total ?? rows.length
  const activeCount = summary?.active ?? rows.filter((r) => r.isActive).length
  const needsResponseCount = rows.filter((r) => isResponseNeeded(r)).length
  const resolvedCount = summary?.resolved ?? rows.filter((r) => !r.isActive).length
  const settledPayout = rows.reduce((sum, r) => sum + (Number(r.approvedAmount) || 0), 0)

  // Filtered rows
  const filteredRows = useMemo(
    () => filterFollowUps(rows, searchQuery, marketplaceFilter, statusTab),
    [rows, searchQuery, marketplaceFilter, statusTab],
  )

  return (
    <section aria-labelledby="followups-title">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="followups-title" className="font-display text-xl font-bold text-ink">
          Ticket follow-ups <span className="text-sm font-normal text-muted">{headlineCount}</span>
        </h1>
        {needsResponseCount > 0 ? (
          <Badge variant="orange" title="Follow-ups where the marketplace requires seller response or proof">
            {needsResponseCount} action required
          </Badge>
        ) : null}
        {summary && summary.withErrors > 0 ? (
          <Badge variant="red" title="Follow-ups whose last check failed">
            {summary.withErrors} with errors
          </Badge>
        ) : null}
      </div>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Once a claim is submitted, the automation engine checks the marketplace ticket every 48 hours until approved,
        rejected, or paid. Search, filter and monitor all ticket outcomes below.
      </p>

      {/* Metric Stat Cards */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Total Tracked"
          value={totalTracked}
          hint="All portal tickets recorded"
        />
        <StatCard
          label="Active Tracking"
          value={activeCount}
          hint="Checking every 48 hours"
        />
        <StatCard
          label="Action Required"
          value={needsResponseCount}
          hint={needsResponseCount > 0 ? 'Supplier response or proof needed' : 'All tickets clear'}
        />
        <StatCard
          label="Approved / Resolved"
          value={resolvedCount}
          hint={settledPayout > 0 ? `₹${settledPayout.toFixed(2)} settled payouts` : 'Terminal status reached'}
        />
      </div>

      {/* Filter and Search Controls */}
      <div className="mt-6 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 shadow-card sm:flex-row sm:items-center sm:justify-between">
        {/* Status Tabs */}
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Ticket status filters">
          <button
            type="button"
            role="tab"
            aria-selected={statusTab === 'all'}
            onClick={() => setStatusTab('all')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
              statusTab === 'all'
                ? 'bg-ink text-surface font-semibold shadow-sm'
                : 'text-muted hover:bg-surface-2 hover:text-ink'
            }`}
          >
            All ({rows.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusTab === 'action_required'}
            onClick={() => setStatusTab('action_required')}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
              statusTab === 'action_required'
                ? 'bg-orange text-white font-semibold shadow-sm'
                : 'text-muted hover:bg-surface-2 hover:text-ink'
            }`}
          >
            <span>Action Required</span>
            {needsResponseCount > 0 ? (
              <span className="rounded-full bg-orange-soft px-1.5 text-[10px] font-bold text-orange">
                {needsResponseCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusTab === 'active'}
            onClick={() => setStatusTab('active')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
              statusTab === 'active'
                ? 'bg-ink text-surface font-semibold shadow-sm'
                : 'text-muted hover:bg-surface-2 hover:text-ink'
            }`}
          >
            Active ({activeCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusTab === 'resolved'}
            onClick={() => setStatusTab('resolved')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
              statusTab === 'resolved'
                ? 'bg-ink text-surface font-semibold shadow-sm'
                : 'text-muted hover:bg-surface-2 hover:text-ink'
            }`}
          >
            Resolved ({resolvedCount})
          </button>
        </div>

        {/* Marketplace Filter Pills */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] font-medium text-muted">Portal:</span>
          {(['all', 'meesho', 'flipkart', 'myntra'] as const).map((mp) => (
            <button
              key={mp}
              type="button"
              onClick={() => setMarketplaceFilter(mp)}
              className={`rounded-md px-2 py-0.5 text-xs font-medium capitalize transition-colors ${
                marketplaceFilter === mp
                  ? 'bg-surface-2 text-ink border border-line font-semibold'
                  : 'text-muted hover:text-ink hover:bg-surface-2/60'
              }`}
            >
              {mp}
            </button>
          ))}
        </div>
      </div>

      {/* Search Input Bar */}
      <div className="mt-3 relative flex items-center">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search by Ticket ID, Sub-Order ID, AWB, Order number, Account..."
          className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-8 text-xs text-ink placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted hover:text-ink"
            title="Clear search"
            aria-label="Clear search"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        ) : null}
      </div>

      {/* Main Content Area */}
      {error ? (
        <div className="mt-4">
          <ErrorState title="Ticket follow-ups could not be read." message={error.message} onRetry={retry} />
        </div>
      ) : !data ? (
        <div className="mt-6">
          <Spinner label="Loading ticket follow-ups" />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No followed-up tickets yet."
            message="A ticket appears here as soon as a claim is filed."
          />
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No tickets match your filters."
            message="Try clearing your search query or changing the status and marketplace filters."
          />
        </div>
      ) : (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>
              Showing {filteredRows.length} of {rows.length} tickets
            </span>
          </div>
          <DataTable
            ariaLabel="Ticket follow-ups"
            rows={filteredRows}
            rowKey={followUpRowKey}
            columns={columns}
            emptyTitle="No followed-up tickets yet."
            emptyMessage="A ticket appears here as soon as a claim is filed."
          />
        </div>
      )}
    </section>
  )
}
