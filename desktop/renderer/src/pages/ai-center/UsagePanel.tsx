import { useCallback, useState } from 'react'
import { Badge } from '../../components/ui/Badge'
import { DataTable } from '../../components/ui/DataTable'
import { ErrorState } from '../../components/ui/ErrorState'
import { Spinner } from '../../components/ui/Spinner'
import { apiGet } from '../../services/engineApi'
import type { AiUsage, AiUsageRecord } from '../../types/engine'
import {
  formatCount,
  formatDateTime,
  formatUsd,
  usageSummarySegments,
  validateDateRange,
} from './format'
import { BTN_SECONDARY, INPUT_CLS, Segments } from './controls'
import { useTabData } from './useTabData'

/**
 * Usage & Costs sub-tab: summary line, the last 200 usage records, and two
 * plain-text YYYY-MM-DD filters (per the repo DateField rule these are NOT
 * <input type="date">). Applying an invalid pair shows an inline error and
 * leaves the current data untouched; a valid pair refetches immediately.
 */
export function UsagePanel({ active }: { active: boolean }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [applied, setApplied] = useState<{ from: string; to: string }>({ from: '', to: '' })
  const [filterError, setFilterError] = useState<string | null>(null)

  const fetcher = useCallback(() => {
    const params = new URLSearchParams()
    if (applied.from) params.set('from', applied.from)
    if (applied.to) {
      // Backend queries compare against timestamps (created_at < to / r.at <= to).
      // Append end-of-day so that records on the selected date are included.
      const toParam = applied.to.length === 10 ? `${applied.to}T23:59:59.999Z` : applied.to
      params.set('to', toParam)
    }
    const query = params.toString()
    return apiGet<AiUsage>(`/api/v1/ai-center/usage${query ? `?${query}` : ''}`)
  }, [applied])

  const { data, error, refresh } = useTabData(fetcher, active)

  function applyFilters() {
    const nextFrom = from.trim()
    const nextTo = to.trim()
    const problem = validateDateRange(nextFrom, nextTo)
    setFilterError(problem)
    if (problem) return
    setApplied({ from: nextFrom, to: nextTo })
    refresh()
  }

  if (!data && !error) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading usage" />
      </div>
    )
  }

  if (error && !data) {
    return <ErrorState title="Usage could not be read." message={error.message} onRetry={refresh} />
  }

  const records: AiUsageRecord[] = data?.records ?? []

  return (
    <div className="flex flex-col gap-3">
      {data ? (
        <p className="text-sm leading-7 text-muted">
          <Segments parts={usageSummarySegments(data.summary)} />
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="aic-usage-from" className="text-muted">
          From
        </label>
        <input
          id="aic-usage-from"
          type="text"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          placeholder="YYYY-MM-DD"
          className={`${INPUT_CLS} w-32 text-xs`}
        />
        <label htmlFor="aic-usage-to" className="text-muted">
          To
        </label>
        <input
          id="aic-usage-to"
          type="text"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="YYYY-MM-DD"
          className={`${INPUT_CLS} w-32 text-xs`}
        />
        <button type="button" className={BTN_SECONDARY} onClick={applyFilters}>
          Filter
        </button>
        {filterError ? (
          <p role="alert" className="text-xs text-red">
            {filterError}
          </p>
        ) : null}
        <span className="text-xs text-muted">
          Costs are estimates from provider-reported tokens and public pricing; the provider bill is
          authoritative. Unknown means no public pricing was confirmed.
        </span>
      </div>

      <DataTable
        ariaLabel="AI usage records"
        rows={records}
        rowKey={(record) => `${record.at}|${record.provider}|${record.model}|${record.task}|${record.latencyMs}`}
        emptyTitle="No usage records in this range"
        emptyMessage="Records appear here after the worker or a connection test makes a real model call."
        columns={[
          { key: 'at', header: 'Time', render: (record) => formatDateTime(record.at) },
          { key: 'provider', header: 'Provider', render: (record) => record.provider },
          { key: 'model', header: 'Model', render: (record) => record.model },
          { key: 'task', header: 'Task', render: (record) => record.task },
          {
            key: 'tokens',
            header: 'Tokens in/out',
            render: (record) => `${formatCount(record.inputTokens)} / ${formatCount(record.outputTokens)}`,
          },
          { key: 'estimatedUsd', header: 'Est. USD', render: (record) => formatUsd(record.estimatedUsd) },
          { key: 'latencyMs', header: 'Latency', render: (record) => `${record.latencyMs} ms` },
          {
            key: 'status',
            header: 'Status',
            render: (record) =>
              record.ok ? (
                <Badge variant="green">ok</Badge>
              ) : (
                <Badge variant="red">failed [{record.errorCategory || 'error'}]</Badge>
              ),
          },
        ]}
      />
      <p className="text-xs text-muted">Last 200 records in the selected range, newest first.</p>
    </div>
  )
}
