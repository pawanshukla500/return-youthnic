import { Badge, type BadgeVariant } from '../../components/ui/Badge'
import { DataTable } from '../../components/ui/DataTable'
import { ErrorState } from '../../components/ui/ErrorState'
import { Spinner } from '../../components/ui/Spinner'
import { apiGet } from '../../services/engineApi'
import type { AiActivity, AiActivityEntry } from '../../types/engine'
import { formatDateTime, truncate } from './format'
import { useTabData } from './useTabData'

const APPROVAL_VARIANTS: Record<AiActivityEntry['approval'], BadgeVariant> = {
  'none-required': 'neutral',
  pending: 'orange',
  approved: 'green',
  rejected: 'red',
}

/**
 * Agents sub-tab: read-only ledger of real worker AI executions (last 100),
 * newest first. Nothing here is rendered unless the worker actually ran it.
 */
export function AgentsPanel({ active }: { active: boolean }) {
  const { data, error, refresh } = useTabData(() => apiGet<AiActivity>('/api/v1/ai-center/activity'), active)

  if (!data && !error) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading activity" />
      </div>
    )
  }

  if (error && !data) {
    return <ErrorState title="Activity could not be read." message={error.message} onRetry={refresh} />
  }

  const rows = data?.activity ?? []

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        ariaLabel="AI agent activity"
        rows={rows}
        rowKey={(entry) => entry.id}
        emptyTitle="No agent executions yet"
        emptyMessage="The worker records here only when it actually runs AI assistance."
        columns={[
          { key: 'at', header: 'Started', render: (entry) => formatDateTime(entry.at) },
          {
            key: 'claim',
            header: 'Claim',
            render: (entry) => (
              <span>
                {entry.marketplace} #{entry.claimId}
              </span>
            ),
          },
          { key: 'agentFunction', header: 'Function', render: (entry) => entry.agentFunction },
          {
            key: 'model',
            header: 'Provider / model',
            render: (entry) => (entry.provider ? `${entry.provider} / ${entry.model || 'memory'}` : entry.model || 'memory'),
          },
          {
            key: 'stage',
            header: 'Stage',
            render: (entry) => (
              <span>
                {entry.stage} ({entry.memoryHit ? 'memory' : 'model'}
                {entry.fallback ? ', fallback' : ''}){entry.errorCategory ? ` [${entry.errorCategory}]` : ''}
              </span>
            ),
          },
          { key: 'result', header: 'Result', render: (entry) => truncate(String(entry.result || ''), 120) },
          {
            key: 'approval',
            header: 'Approval',
            render: (entry) => (
              <Badge variant={APPROVAL_VARIANTS[entry.approval] ?? 'neutral'}>{entry.approval}</Badge>
            ),
          },
        ]}
      />
      <p className="text-xs text-muted">
        Read-only ledger of real worker executions. Nothing here is active unless the worker actually ran
        it; interrupted rows mark an application restart.
      </p>
    </div>
  )
}
