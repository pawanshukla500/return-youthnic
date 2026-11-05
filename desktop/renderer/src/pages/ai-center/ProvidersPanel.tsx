import { useState } from 'react'
import { Badge } from '../../components/ui/Badge'
import { DataTable } from '../../components/ui/DataTable'
import { ErrorState } from '../../components/ui/ErrorState'
import { Spinner } from '../../components/ui/Spinner'
import { apiDelete, apiGet } from '../../services/engineApi'
import type { AiProviderStatus, AiProvidersResponse } from '../../types/engine'
import { errorMessage, formatDateTime, truncate } from './format'
import { ActionAlert, BTN_DANGER, BTN_SECONDARY, ConfirmDialog } from './controls'
import { ProviderKeyModal } from './ProviderKeyModal'
import { useTabData } from './useTabData'

/**
 * Providers sub-tab: one row per catalog provider with key status, default
 * model, and last success/error. Row actions open the key editor (Add/Change
 * key, Test, Discover models, Save model) or the remove-key confirm. Key
 * material never appears here — the engine API only answers `hasKey`.
 */
export function ProvidersPanel({ active }: { active: boolean }) {
  const { data, error, refresh } = useTabData(
    () => apiGet<AiProvidersResponse>('/api/v1/ai-center/providers'),
    active,
  )
  const [editorFor, setEditorFor] = useState<AiProviderStatus | null>(null)
  const [editorAutoTest, setEditorAutoTest] = useState(false)
  const [removeFor, setRemoveFor] = useState<AiProviderStatus | null>(null)
  const [removing, setRemoving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  function openEditor(provider: AiProviderStatus, autoTest: boolean) {
    setActionError(null)
    setEditorFor(provider)
    setEditorAutoTest(autoTest)
  }

  async function confirmRemove() {
    if (!removeFor) return
    setRemoving(true)
    setActionError(null)
    try {
      await apiDelete(`/api/v1/ai-center/providers/${removeFor.id}/key`)
      setRemoveFor(null)
      refresh()
    } catch (cause) {
      setActionError(`Could not remove the key for ${removeFor.name}: ${errorMessage(cause)}`)
      setRemoveFor(null)
    } finally {
      setRemoving(false)
    }
  }

  if (!data && !error) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading providers" />
      </div>
    )
  }

  if (error && !data) {
    return (
      <ErrorState
        title="AI Center could not be read."
        message={error.message}
        onRetry={refresh}
      />
    )
  }

  const providers = data?.providers ?? []
  const configured = providers.filter((p) => p.hasKey).length

  return (
    <div className="flex flex-col gap-3">
      {actionError ? <ActionAlert message={actionError} /> : null}

      {data ? (
        <div className="flex flex-wrap items-center gap-2">
          {data.encryptionAvailable ? (
            <Badge variant="green" title="Provider keys are encrypted with the OS credential store on this PC">
              Keys encrypted with the OS credential store
            </Badge>
          ) : (
            <Badge variant="red" title="The OS credential store is unavailable on this PC">
              OS credential store unavailable — keys are not OS-encrypted on this PC
            </Badge>
          )}
          {data.rtdbConfigured ? (
            <Badge variant="blue" title="AI Center signals sync to the configured Firebase realtime database">
              Cloud sync configured
            </Badge>
          ) : null}
          <span className="text-xs text-muted">
            ({configured} of {providers.length} providers configured)
          </span>
        </div>
      ) : null}

      <DataTable
        ariaLabel="AI providers"
        rows={providers}
        rowKey={(p) => p.id}
        emptyTitle="No providers"
        emptyMessage="The provider catalog is empty."
        columns={[
          { key: 'name', header: 'Provider', render: (p) => <span className="font-medium">{p.name}</span> },
          {
            key: 'key',
            header: 'Key',
            render: (p) =>
              p.hasKey ? (
                <Badge variant="green" title="A key is stored on this PC; it is never shown again">
                  Saved (encrypted)
                </Badge>
              ) : (
                <Badge>No key</Badge>
              ),
          },
          { key: 'defaultModel', header: 'Default model', render: (p) => p.defaultModel || '—' },
          { key: 'lastSuccessAt', header: 'Last success', render: (p) => formatDateTime(p.lastSuccessAt) },
          {
            key: 'lastError',
            header: 'Last error',
            render: (p) =>
              p.lastError ? (
                <span className="text-red" title={p.lastError}>
                  {p.lastErrorCategory || 'error'}: {truncate(p.lastError, 80)}
                </span>
              ) : (
                '—'
              ),
          },
          {
            key: 'actions',
            header: '',
            className: 'whitespace-nowrap',
            render: (p) => (
              <span className="flex gap-1.5">
                <button type="button" className={BTN_SECONDARY} onClick={() => openEditor(p, false)}>
                  Key…
                </button>
                <button type="button" className={BTN_SECONDARY} onClick={() => openEditor(p, true)}>
                  Test
                </button>
                <button
                  type="button"
                  className={BTN_DANGER}
                  disabled={!p.hasKey}
                  title={p.hasKey ? 'Remove the stored key from this PC' : 'No key stored for this provider'}
                  onClick={() => {
                    setActionError(null)
                    setRemoveFor(p)
                  }}
                >
                  Remove
                </button>
              </span>
            ),
          },
        ]}
      />

      <p className="text-xs text-muted">
        Your own provider keys, model routing, agent activity, and usage costs. Keys are encrypted with
        the OS credential store on this PC, never shown again, and never sent anywhere except the provider
        API. The claim worker stays deterministic: memory first, then a low-cost model, then human review.
      </p>

      {editorFor ? (
        <ProviderKeyModal
          provider={editorFor}
          autoTest={editorAutoTest}
          onClose={() => setEditorFor(null)}
          onChanged={refresh}
        />
      ) : null}

      {removeFor ? (
        <ConfirmDialog
          title={`Remove key for ${removeFor.name}?`}
          confirmLabel="Remove key"
          busy={removing}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoveFor(null)}
        >
          The stored key for {removeFor.name} is deleted from this PC. Claims routed to this provider fail
          until a new key is saved.
        </ConfirmDialog>
      ) : null}
    </div>
  )
}
