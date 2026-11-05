import { useCallback, useEffect, useState } from 'react'
import type { FollowUpRow, FollowUpsResponse } from '../types/engine'
import { apiGet, EngineApiError } from '../services/engineApi'
import { DataTable, type DataTableColumn } from '../components/ui/DataTable'
import { MarketplaceBadge } from '../components/ui/MarketplaceBadge'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Spinner } from '../components/ui/Spinner'

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

/**
 * One-line lifecycle state for a follow-up row, matching the engine
 * dashboard: active rows report their check cadence (or an error streak),
 * stopped rows report why they stopped.
 */
export function followUpStateLabel(row: FollowUpStateInput): string {
  if (row.isActive) {
    if (row.errorStreak > 0) return `errors ×${row.errorStreak}`
    return `checking every ${Math.round(row.checkIntervalHours || 48)}h`
  }
  return STOP_REASON_LABELS[row.stopReason ?? ''] ?? 'stopped'
}

function stateToneClass(row: FollowUpStateInput): string {
  if (row.isActive) return row.errorStreak > 0 ? 'text-orange' : 'text-green'
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

const columns: Array<DataTableColumn<FollowUpRow>> = [
  {
    key: 'marketplace',
    header: 'Marketplace',
    render: (row) => (
      <div>
        <MarketplaceBadge marketplace={row.marketplace || '—'} />
        <div className="mt-0.5 text-[11px] text-muted">
          {row.accountName}
          {row.orderNumber ? ` · ${row.orderNumber}` : ''}
        </div>
      </div>
    ),
  },
  {
    key: 'marketplaceClaimId',
    header: 'Ticket ID',
    render: (row) =>
      row.marketplaceClaimId ? (
        <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">{row.marketplaceClaimId}</code>
      ) : (
        <span className="text-muted">—</span>
      ),
  },
  {
    key: 'claimStatus',
    header: 'Claim status',
    render: (row) => (
      <div>
        <span>{row.claimStatus || '—'}</span>
        {row.statusAtLastCheck ? <div className="mt-0.5 text-[11px] text-muted">{row.statusAtLastCheck}</div> : null}
      </div>
    ),
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

  // Poll the engine directly (mirrors useEngineStatus): useEnginePolling has no
  // manual refresh, and this page's error state must offer a retry that
  // re-fetches immediately instead of waiting for the next 60s tick.
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      try {
        const result = await apiGet<FollowUpsResponse>('/api/follow-ups?pageSize=100')
        if (cancelled) return
        setData(result)
        setError(null)
      } catch (cause) {
        if (cancelled) return
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
  }, [refreshKey])

  const retry = useCallback(() => setRefreshKey((key) => key + 1), [])

  const summary = data?.summary
  const headlineCount = summary
    ? `(${summary.active} tracking · ${summary.due} due now · ${summary.resolved} resolved)`
    : error
      ? '(unavailable)'
      : ''

  return (
    <section aria-labelledby="followups-title">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="followups-title" className="font-display text-xl font-bold text-ink">
          Ticket follow-ups <span className="text-sm font-normal text-muted">{headlineCount}</span>
        </h1>
        {summary && summary.withErrors > 0 ? (
          <Badge variant="red" title="Follow-ups whose last check failed">
            {summary.withErrors} with errors
          </Badge>
        ) : null}
      </div>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Once a ticket is due, the bot re-opens that supplier panel in the nightly window, reads the
        ticket status and records it here — keeping at it until the ticket is approved, rejected or paid.
      </p>

      {error ? (
        <div className="mt-4">
          <ErrorState title="Ticket follow-ups could not be read." message={error.message} onRetry={retry} />
        </div>
      ) : !data ? (
        <div className="mt-6">
          <Spinner label="Loading ticket follow-ups" />
        </div>
      ) : data.rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No followed-up tickets yet."
            message="A ticket appears here as soon as a claim is filed."
          />
        </div>
      ) : (
        <div className="mt-4">
          <DataTable
            ariaLabel="Ticket follow-ups"
            rows={data.rows}
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
