import { useEffect, useState } from 'react'
import { DataTable } from '../../components/ui/DataTable'
import { ErrorState } from '../../components/ui/ErrorState'
import { Spinner } from '../../components/ui/Spinner'
import { apiGet, apiPost } from '../../services/engineApi'
import type { AiRoutingResponse, AiTaskRoute } from '../../types/engine'
import { errorMessage, formatTimeoutMs } from './format'
import { BTN_PRIMARY, InlineMessage, INPUT_CLS, type InlineMessageKind } from './controls'
import { useTabData } from './useTabData'

type TaskRow = { taskId: string; route: AiTaskRoute }

/**
 * Routing sub-tab: read-only per-task routing table plus the monthly budget
 * editor. Save round-trips the full routing object from GET and swaps in the
 * modified monthlyBudgetUsd, exactly like the old dashboard.
 */
export function RoutingPanel({ active }: { active: boolean }) {
  const { data, error, refresh } = useTabData(
    () => apiGet<AiRoutingResponse>('/api/v1/ai-center/routing'),
    active,
  )
  const [budget, setBudget] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: InlineMessageKind; text: string } | null>(null)

  // Sync the input whenever a fresh routing payload lands (first load, poll
  // tick, post-save refresh) — but never clobber uncommitted user edits.
  useEffect(() => {
    if (isDirty) return
    const value = data?.routing.monthlyBudgetUsd
    setBudget(value == null ? '' : String(value))
  }, [data, isDirty])

  if (!data && !error) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading routing" />
      </div>
    )
  }

  if (error && !data) {
    return <ErrorState title="Routing could not be read." message={error.message} onRetry={refresh} />
  }

  const routing = data?.routing
  const rows: TaskRow[] = routing ? Object.entries(routing.tasks).map(([taskId, route]) => ({ taskId, route })) : []

  async function saveRouting() {
    if (!routing) {
      setMessage({ kind: 'error', text: 'Routing not loaded yet.' })
      return
    }
    const raw = budget.trim()
    let monthlyBudgetUsd: number | null
    if (raw === '') {
      monthlyBudgetUsd = null
    } else {
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setMessage({ kind: 'error', text: 'Budget must be a positive number, or empty for no budget.' })
        return
      }
      monthlyBudgetUsd = parsed
    }
    setSaving(true)
    setMessage({ kind: 'info', text: 'Saving…' })
    try {
      await apiPost<{ ok: boolean }>('/api/v1/ai-center/routing', {
        routing: { ...routing, monthlyBudgetUsd },
      })
      setIsDirty(false)
      setMessage({ kind: 'ok', text: 'Routing saved.' })
      refresh()
    } catch (cause) {
      setMessage({ kind: 'error', text: `Save failed: ${errorMessage(cause)}` })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        ariaLabel="AI task routing"
        rows={rows}
        rowKey={(row) => row.taskId}
        emptyTitle="No routing tasks"
        emptyMessage="The routing table is empty."
        columns={[
          { key: 'taskId', header: 'Task', render: (row) => <span className="font-medium">{row.taskId}</span> },
          { key: 'mode', header: 'Mode', render: (row) => row.route.mode },
          {
            key: 'primary',
            header: 'Primary',
            render: (row) => `${row.route.primary.provider} / ${row.route.primary.model}`,
          },
          {
            key: 'fallback',
            header: 'Fallback',
            render: (row) =>
              row.route.fallback ? `${row.route.fallback.provider} / ${row.route.fallback.model}` : '—',
          },
          { key: 'maxTokens', header: 'Tokens', render: (row) => row.route.maxTokens ?? '—' },
          { key: 'timeoutMs', header: 'Timeout', render: (row) => formatTimeoutMs(row.route.timeoutMs) },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="aic-budget" className="text-muted">
          Monthly budget (USD, empty = none)
        </label>
        <input
          id="aic-budget"
          type="text"
          inputMode="decimal"
          value={budget}
          onChange={(event) => {
            setIsDirty(true)
            setBudget(event.target.value)
          }}
          disabled={!routing}
          className={`${INPUT_CLS} w-28 text-xs`}
        />
        <button
          type="button"
          className={BTN_PRIMARY}
          onClick={() => void saveRouting()}
          disabled={!routing || saving}
        >
          {saving ? 'Saving…' : 'Save routing'}
        </button>
        {message ? <InlineMessage kind={message.kind} text={message.text} /> : null}
      </div>

      <p className="text-xs text-muted">
        Automatic mode picks the cheapest healthy provider per task and escalates only inside your budget.
        Manual mode pins a primary and optional fallback. Reasoning options are sent only to models that
        advertise support.
      </p>
    </div>
  )
}
