import { useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal'
import { apiGet, apiPost, EngineApiError } from '../../services/engineApi'
import type { AiProviderStatus, TokenUsage } from '../../types/engine'
import { errorMessage, formatCount } from './format'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLS, InlineMessage, type InlineMessageKind } from './controls'

type ModelsResponse = { models: string[]; source?: string }
type TestOkResponse = { ok: boolean; latencyMs?: number; usage?: TokenUsage; mode?: string; model?: string; text?: string }

/**
 * Add/Change-key editor for one provider (replaces the old dashboard's inline
 * key editor). Key material lives only in the password input; it is cleared
 * from component state the moment the engine has stored it, and it is never
 * rendered, logged, or sent anywhere except POST .../key. The engine API only
 * ever answers `hasKey`, so this modal can never display a stored key either.
 *
 * The modal also hosts model management: Discover models (GET .../models)
 * fills the select, a free-text box accepts manual model IDs, Save model
 * (POST .../prefs) persists the default. Test connection (POST .../test)
 * makes one genuine low-cost request and reports latency/token usage or the
 * engine's error category.
 */
export function ProviderKeyModal({
  provider,
  autoTest = false,
  onClose,
  onChanged,
}: {
  provider: AiProviderStatus
  autoTest?: boolean
  onClose: () => void
  onChanged: () => void
}) {
  // `keyDraft` is the only place key material ever sits in renderer state.
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<string[] | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | 'prefs' | null>(null)
  const [message, setMessage] = useState<{ kind: InlineMessageKind; text: string } | null>(null)

  const basePath = `/api/v1/ai-center/providers/${provider.id}`

  async function saveKey() {
    const value = keyDraft.trim()
    if (!value) {
      setMessage({ kind: 'error', text: 'Paste a key first.' })
      return
    }
    setBusy('save')
    setMessage({ kind: 'info', text: 'Saving…' })
    try {
      const res = await apiPost<{ ok: boolean; encrypted: boolean }>(`${basePath}/key`, { key: value })
      setKeyDraft('')
      setMessage({ kind: 'ok', text: res.encrypted ? 'Saved (OS-encrypted).' : 'Saved.' })
      onChanged()
    } catch (cause) {
      setMessage({ kind: 'error', text: `Save failed: ${errorMessage(cause)}` })
    } finally {
      setBusy(null)
    }
  }

  async function runTest() {
    const model = manualModel.trim() || selectedModel.trim()
    setBusy('test')
    setMessage({ kind: 'info', text: 'Testing with a real low-cost request…' })
    try {
      const res = await apiPost<TestOkResponse>(`${basePath}/test`, model ? { model } : {})
      const usage = res.usage
      const tokens =
        usage && (usage.inputTokens != null || usage.outputTokens != null)
          ? ` · in ${formatCount(usage.inputTokens)} / out ${formatCount(usage.outputTokens)} tokens`
          : ''
      setMessage({ kind: 'ok', text: `Connection OK (${res.latencyMs ?? '?'} ms${tokens}).` })
      onChanged()
    } catch (cause) {
      // The engine answers test failures as 400 { category, error } — surface
      // the category exactly like the old dashboard did.
      const category =
        cause instanceof EngineApiError
          ? (cause.body as { category?: string } | null)?.category
          : undefined
      const detail = cause instanceof EngineApiError && cause.body?.error ? `: ${cause.body.error}` : ''
      setMessage({
        kind: 'error',
        text: category ? `Test failed: ${category}${detail}` : `Test failed: ${errorMessage(cause)}`,
      })
    } finally {
      setBusy(null)
    }
  }

  async function discoverModels() {
    setBusy('models')
    setMessage(null)
    try {
      const res = await apiGet<ModelsResponse>(`${basePath}/models`)
      setModels(res.models)
      if (res.models.length > 0) setSelectedModel((prev) => prev || res.models[0])
      setMessage({
        kind: 'info',
        text:
          res.models.length > 0
            ? `Discovered ${res.models.length} model(s)${res.source ? ` via ${res.source}` : ''}.`
            : `Discovery returned no models${res.source ? ` (via ${res.source})` : ''}. Type a model ID manually.`,
      })
    } catch (cause) {
      setModels([])
      setMessage({ kind: 'error', text: `Discovery failed: ${errorMessage(cause)}` })
    } finally {
      setBusy(null)
    }
  }

  async function saveModel() {
    const model = manualModel.trim() || selectedModel.trim()
    if (!model) {
      setMessage({ kind: 'error', text: 'Pick or type a model first.' })
      return
    }
    setBusy('prefs')
    setMessage({ kind: 'info', text: 'Saving…' })
    try {
      // Round-trip baseUrlOverride: the prefs endpoint overwrites both fields,
      // so omitting it here would wipe an override set elsewhere.
      await apiPost<{ ok: boolean }>(`${basePath}/prefs`, {
        defaultModel: model,
        baseUrlOverride: provider.baseUrlOverride ?? '',
      })
      setManualModel('')
      setMessage({ kind: 'ok', text: `Default model saved: ${model}` })
      onChanged()
    } catch (cause) {
      setMessage({ kind: 'error', text: `Save failed: ${errorMessage(cause)}` })
    } finally {
      setBusy(null)
    }
  }

  // Per-row "Test" opens this editor and immediately runs the connection
  // test, mirroring the old dashboard's quickTestAiConnection.
  useEffect(() => {
    if (!autoTest) return
    void runTest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const anyBusy = busy !== null

  return (
    <Modal title={`API key for ${provider.name}${provider.hasKey ? ' (replace)' : ''}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            placeholder="Paste key — it is encrypted on save and never shown again"
            aria-label="Provider API key"
            className={`${INPUT_CLS} w-full max-w-md`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_PRIMARY} onClick={() => void saveKey()} disabled={anyBusy}>
            {busy === 'save' ? 'Saving…' : 'Save key'}
          </button>
          <button type="button" className={BTN_SECONDARY} onClick={() => void runTest()} disabled={anyBusy}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <select
            aria-label="Discovered models"
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
            className={`${INPUT_CLS} max-w-[280px] text-xs`}
            disabled={!models || models.length === 0}
          >
            {!models || models.length === 0 ? (
              <option value="">{models === null ? 'Discover to list models' : 'No models discovered'}</option>
            ) : (
              models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))
            )}
          </select>
          <input
            type="text"
            value={manualModel}
            onChange={(event) => setManualModel(event.target.value)}
            placeholder="Or type a model ID"
            aria-label="Manual model ID"
            className={`${INPUT_CLS} max-w-[220px] text-xs`}
          />
          <button type="button" className={BTN_SECONDARY} onClick={() => void discoverModels()} disabled={anyBusy}>
            {busy === 'models' ? 'Discovering…' : 'Discover models'}
          </button>
          <button type="button" className={BTN_SECONDARY} onClick={() => void saveModel()} disabled={anyBusy}>
            {busy === 'prefs' ? 'Saving…' : 'Save model'}
          </button>
        </div>

        {message ? <InlineMessage kind={message.kind} text={message.text} /> : null}

        <p className="text-xs text-muted">
          Test connection makes one genuine low-cost model request (a few tokens). Manual model IDs are
          allowed; discovery lists what the provider reports.
        </p>
        <div className="flex justify-end">
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
