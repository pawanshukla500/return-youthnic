import { useState } from 'react'
import { DataTable } from '../../components/ui/DataTable'
import { ErrorState } from '../../components/ui/ErrorState'
import { Spinner } from '../../components/ui/Spinner'
import { apiGet, apiPost } from '../../services/engineApi'
import type { AiMemoryProcedure, AiMemoryResponse } from '../../types/engine'
import { errorMessage, memoryStatusLine, memoryStatusMeta } from './format'
import { ActionAlert, BTN_DANGER, ConfirmDialog } from './controls'
import { useTabData } from './useTabData'

/**
 * Learning & Memory sub-tab: the locally mirrored approved recovery
 * procedures with their status dot and step counts, plus the metadata-only AI
 * usage ledger. Disable flips one procedure to `disabled` on this PC only —
 * a local kill-switch; authoritative approvals stay in PostgreSQL.
 */
export function MemoryPanel({ active }: { active: boolean }) {
  const { data, error, refresh } = useTabData(() => apiGet<AiMemoryResponse>('/api/v1/ai-memory'), active)
  const [disableFor, setDisableFor] = useState<AiMemoryProcedure | null>(null)
  const [disabling, setDisabling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  async function confirmDisable() {
    if (!disableFor) return
    setDisabling(true)
    setActionError(null)
    try {
      await apiPost<{ ok: boolean; id: string; changed: boolean }>('/api/v1/ai-memory/disable', {
        id: disableFor.id,
      })
      setDisableFor(null)
      refresh()
    } catch (cause) {
      setActionError(`Could not disable that procedure: ${errorMessage(cause)}`)
      setDisableFor(null)
    } finally {
      setDisabling(false)
    }
  }

  if (!data && !error) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading AI memory" />
      </div>
    )
  }

  if (error && !data) {
    return <ErrorState title="AI memory could not be read." message={error.message} onRetry={refresh} />
  }

  const procedures = data?.procedures ?? []

  return (
    <div className="flex flex-col gap-3">
      {actionError ? <ActionAlert message={actionError} /> : null}

      {data ? <p className="text-sm text-muted">{memoryStatusLine(data)}</p> : null}

      <DataTable
        ariaLabel="Approved AI memory procedures"
        rows={procedures}
        rowKey={(procedure) => procedure.id}
        emptyTitle="No approved procedures yet"
        emptyMessage="The worker records verified fixes here after an operator approves them."
        columns={[
          {
            key: 'marketplace',
            header: 'Marketplace',
            render: (procedure) => <span className="font-medium">{procedure.marketplace}</span>,
          },
          {
            key: 'title',
            header: 'Procedure',
            render: (procedure) => (
              <span>
                {procedure.title}
                <span className="block text-xs text-muted">{procedure.steps.length} step(s)</span>
              </span>
            ),
          },
          {
            key: 'errorSignature',
            header: 'Error signature',
            render: (procedure) => (
              <code className="font-mono text-xs text-ink">{procedure.errorSignature}</code>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            render: (procedure) => {
              const meta = memoryStatusMeta(procedure.status)
              return (
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${meta.dotClass}`} />
                  <span className={`text-xs ${meta.textClass}`}>{meta.label}</span>
                </span>
              )
            },
          },
          {
            key: 'actions',
            header: '',
            render: (procedure) =>
              procedure.status === 'disabled' ? (
                <span className="text-xs text-muted">—</span>
              ) : (
                <button
                  type="button"
                  className={BTN_DANGER}
                  title="Stop the worker from reusing this procedure on this PC"
                  onClick={() => {
                    setActionError(null)
                    setDisableFor(procedure)
                  }}
                >
                  Disable
                </button>
              ),
          },
        ]}
      />

      <p className="text-xs text-muted">
        Only approved recovery procedures drive the worker without a new AI call. AI suggestions stay
        pending until an operator approves them. Disable is a local safety kill-switch for this PC.
        Authoritative approvals live in PostgreSQL and follow pending to approved; this PC mirrors
        approved and disabled procedures only.
      </p>

      {disableFor ? (
        <ConfirmDialog
          title="Disable this procedure?"
          confirmLabel="Disable procedure"
          busy={disabling}
          onConfirm={() => void confirmDisable()}
          onCancel={() => setDisableFor(null)}
        >
          “{disableFor.title}” stops being reused by the worker on this PC immediately. The approval in
          PostgreSQL is not affected.
        </ConfirmDialog>
      ) : null}
    </div>
  )
}
