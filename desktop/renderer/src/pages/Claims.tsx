import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiPost, EngineApiError, getEngineBase } from '../services/config'
import { useEnginePolling } from '../hooks/useEnginePolling'
import { Badge, type BadgeVariant } from '../components/ui/Badge'
import { DataTable, type DataTableColumn } from '../components/ui/DataTable'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { MarketplaceBadge } from '../components/ui/MarketplaceBadge'
import { PanelStateDot } from '../components/ui/PanelStateDot'
import { Spinner } from '../components/ui/Spinner'
import type { JobRow, PanelClearResponse, PanelStatus, PanelsResponse } from '../types/engine'

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                    */
/* ------------------------------------------------------------------ */

export type ClaimBucket = 'queued' | 'processing' | 'completed' | 'action'

const PROCESSING_STAGES = new Set(['downloading_media', 'opening_portal', 'filling_form', 'submitting'])

/**
 * Bucket a job stage into a pipeline lane. Parity with the old dashboard
 * (getDashboardHtml renderJobs): manual_intervention_required, failed and
 * prepared all land in the action lane; any unknown stage also goes there so
 * it is never silently hidden from the operator.
 */
export function jobBucket(stage: string): ClaimBucket {
  if (stage === 'queued') return 'queued'
  if (PROCESSING_STAGES.has(stage)) return 'processing'
  if (stage === 'completed') return 'completed'
  return 'action'
}

/** Case-insensitive search across the fields the old dashboard searched. */
export function filterJobs(rows: JobRow[], query: string): JobRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((row) =>
    (row.orderNumber || '').toLowerCase().includes(needle) ||
    (row.trackingId || '').toLowerCase().includes(needle) ||
    (row.marketplaceClaimId || '').toLowerCase().includes(needle) ||
    (row.marketplace || '').toLowerCase().includes(needle),
  )
}

export type EvidenceItem = {
  name: string
  sizeBytes: number
  mtimeIso: string | null
}

/**
 * Normalize the evidence list payload. The engine serves
 * `{ claimId, files: [{ name, sizeBytes, mtimeIso }] }` from disk; the shared
 * EvidenceFile type declares the richer backend shape. Accept both so the
 * renderer stays truthful to whatever the engine actually returns.
 */
export function normalizeEvidenceList(payload: unknown): EvidenceItem[] {
  if (!payload || typeof payload !== 'object') return []
  const files = (payload as { files?: unknown }).files
  if (!Array.isArray(files)) return []
  const items: EvidenceItem[] = []
  for (const raw of files) {
    if (!raw || typeof raw !== 'object') continue
    const file = raw as Record<string, unknown>
    const name = typeof file.name === 'string' ? file.name : typeof file.fileName === 'string' ? file.fileName : ''
    if (!name) continue
    const sizeBytes = typeof file.sizeBytes === 'number' && Number.isFinite(file.sizeBytes) ? file.sizeBytes : 0
    const mtimeIso = typeof file.mtimeIso === 'string' ? file.mtimeIso : typeof file.downloadedAt === 'string' ? file.downloadedAt : null
    items.push({ name, sizeBytes, mtimeIso })
  }
  return items
}

/** Local evidence kinds that can render an inline preview. */
export function evidenceFileKind(name: string): 'image' | 'video' | 'other' {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 'image'
  if (ext === 'mp4' || ext === 'webm') return 'video'
  return 'other'
}

export function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 B'
  if (sizeBytes < 1024) return `${Math.round(sizeBytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = sizeBytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/* ------------------------------------------------------------------ */
/* Page constants                                                       */
/* ------------------------------------------------------------------ */

export const CLAIMS_FILTER_STORAGE_KEY = 'ra-claims-filter'
export const FOCUS_LOGIN_STORAGE_KEY = 'ra-focus-login'

type ChipFilter = 'all' | ClaimBucket

const CHIPS: Array<{ id: ChipFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'queued', label: 'Queued' },
  { id: 'processing', label: 'In Progress' },
  { id: 'completed', label: 'Done-Completed' },
  { id: 'action', label: 'Attention Needed' },
]

const JOBS_POLL_MS = 10_000
const PANELS_POLL_MS = 5_000
const ACTION_REASON_LOGIN = /login|otp|password/i

function stageVariant(stage: string): BadgeVariant {
  if (stage === 'completed') return 'green'
  if (stage === 'queued') return 'neutral'
  if (stage === 'manual_intervention_required' || stage === 'failed') return 'red'
  if (stage === 'prepared') return 'orange'
  if (jobBucket(stage) === 'processing') return 'blue'
  return 'orange'
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-IN')
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN')
}

function needsLoginSetup(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && ACTION_REASON_LOGIN.test(reason)
}

function asApiError(cause: unknown): EngineApiError {
  return cause instanceof EngineApiError
    ? cause
    : new EngineApiError(0, cause instanceof Error ? cause.message : String(cause))
}

function readStoredFilter(): ChipFilter {
  try {
    const stored = window.sessionStorage.getItem(CLAIMS_FILTER_STORAGE_KEY)
    if (stored && CHIPS.some((chip) => chip.id === stored)) return stored as ChipFilter
  } catch {
    // Storage unavailable: default filter.
  }
  return 'all'
}

const BTN_PRIMARY = 'rounded-lg bg-green px-3 py-1 text-xs font-semibold text-white hover:bg-green-dark'
const BTN_SECONDARY = 'rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2'

/* ------------------------------------------------------------------ */
/* Evidence                                                             */
/* ------------------------------------------------------------------ */

function EvidenceFileCard({ file, claimId, engineBase }: { file: EvidenceItem; claimId: number; engineBase: string }) {
  const [previewFailed, setPreviewFailed] = useState(false)
  const kind = evidenceFileKind(file.name)
  const showPreview = (kind === 'image' || kind === 'video') && !previewFailed
  const url = `${engineBase}/api/evidence/${claimId}/${encodeURIComponent(file.name)}`

  return (
    <li className="rounded-lg border border-line bg-surface-2 p-2">
      {showPreview && kind === 'image' ? (
        <img
          src={url}
          alt={file.name}
          loading="lazy"
          onError={() => setPreviewFailed(true)}
          className="h-36 w-full rounded bg-surface object-contain"
        />
      ) : null}
      {showPreview && kind === 'video' ? (
        <video
          src={url}
          controls
          preload="metadata"
          onError={() => setPreviewFailed(true)}
          className="h-36 w-full rounded bg-surface"
        />
      ) : null}
      <div className="mt-1 truncate text-xs font-medium text-ink" title={file.name}>
        {file.name}
      </div>
      <div className="text-[11px] text-muted">
        {formatBytes(file.sizeBytes)}
        {file.mtimeIso ? ` · ${formatDateTime(file.mtimeIso)}` : ''}
      </div>
      {/* The download link is always present: it is the fallback when a
          preview is blocked (e.g. CSP) and the accessible path for every file. */}
      <a href={url} download={file.name} className="mt-1 inline-block text-xs font-semibold text-blue hover:underline">
        Download
      </a>
    </li>
  )
}

function EvidenceSection({ claimId, engineBase }: { claimId: number; engineBase: string | null }) {
  const [items, setItems] = useState<EvidenceItem[] | null>(null)
  const [error, setError] = useState<EngineApiError | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    apiGet<unknown>(`/api/evidence/${claimId}`)
      .then((payload) => {
        if (!cancelled) setItems(normalizeEvidenceList(payload))
      })
      .catch((cause) => {
        if (!cancelled) setError(asApiError(cause))
      })
    return () => {
      cancelled = true
    }
  }, [claimId, nonce])

  if (error) {
    return <ErrorState title="Could not load evidence" message={error.body?.error || error.message} onRetry={() => setNonce((n) => n + 1)} />
  }
  if (items === null || engineBase === null) {
    return (
      <div className="py-4">
        <Spinner label="Loading evidence" />
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title="No local evidence yet"
        message="Evidence is downloaded when the worker picks up the claim. Downloaded files are local proof only — they are not proof the marketplace received them."
      />
    )
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {items.map((file) => (
        <EvidenceFileCard key={file.name} file={file} claimId={claimId} engineBase={engineBase} />
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function ClaimsPage() {
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<ChipFilter>(readStoredFilter)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [clearingPanelKey, setClearingPanelKey] = useState<string | null>(null)
  const [engineBase, setEngineBase] = useState<string | null>(null)

  // Polling is the steady cadence; the overrides give instant feedback after
  // operator actions and converge back to the poll data on the next tick.
  const jobsPoll = useEnginePolling<JobRow[]>(useCallback(() => apiGet<JobRow[]>('/api/jobs'), []), JOBS_POLL_MS, true)
  const panelsPoll = useEnginePolling<PanelsResponse>(useCallback(() => apiGet<PanelsResponse>('/api/panels'), []), PANELS_POLL_MS, true)
  const [jobsOverride, setJobsOverride] = useState<JobRow[] | null>(null)
  const [panelsOverride, setPanelsOverride] = useState<PanelStatus[] | null>(null)

  const lastJobsPollData = useRef<JobRow[] | null>(null)
  useEffect(() => {
    if (jobsPoll.data !== lastJobsPollData.current) {
      lastJobsPollData.current = jobsPoll.data
      setJobsOverride(null)
    }
  }, [jobsPoll.data])

  const lastPanelsPollData = useRef<PanelsResponse | null>(null)
  useEffect(() => {
    if (panelsPoll.data !== lastPanelsPollData.current) {
      lastPanelsPollData.current = panelsPoll.data
      setPanelsOverride(null)
    }
  }, [panelsPoll.data])

  useEffect(() => {
    let active = true
    getEngineBase()
      .then((base) => {
        if (active) setEngineBase(base)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    try {
      window.sessionStorage.setItem(CLAIMS_FILTER_STORAGE_KEY, chip)
    } catch {
      // Filter persistence is best-effort.
    }
  }, [chip])

  const jobs = jobsOverride ?? jobsPoll.data
  const jobsError = jobsPoll.error
  const rows = useMemo(() => jobs ?? [], [jobs])
  const panels = panelsOverride ?? panelsPoll.data?.panels ?? null
  const panelsError = panelsPoll.error

  const counts = useMemo(() => {
    const result: Record<ChipFilter, number> = { all: rows.length, queued: 0, processing: 0, completed: 0, action: 0 }
    for (const row of rows) result[jobBucket(row.stage)] += 1
    return result
  }, [rows])

  const filteredRows = useMemo(() => {
    const searched = filterJobs(rows, query)
    return chip === 'all' ? searched : searched.filter((row) => jobBucket(row.stage) === chip)
  }, [rows, query, chip])

  const selectedRow = selectedId === null ? null : rows.find((row) => row.id === selectedId) ?? null

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const [jobsResult, panelsResult] = await Promise.allSettled([
      apiGet<JobRow[]>('/api/jobs'),
      apiGet<PanelsResponse>('/api/panels'),
    ])
    if (jobsResult.status === 'fulfilled') {
      setJobsOverride(jobsResult.value)
    } else {
      setNotice({ kind: 'error', text: `Claims refresh failed: ${asApiError(jobsResult.reason).message}` })
    }
    if (panelsResult.status === 'fulfilled') {
      setPanelsOverride(panelsResult.value.panels)
    } else {
      setNotice({ kind: 'error', text: `Panels refresh failed: ${asApiError(panelsResult.reason).message}` })
    }
    setRefreshing(false)
  }, [])

  const runOne = useCallback(async (row: JobRow) => {
    setRunningId(row.id)
    setNotice(null)
    try {
      const result = await apiPost<{ ok: boolean; message?: string }>('/api/jobs/run-one', { jobId: row.id })
      setNotice({ kind: 'ok', text: result.message || 'That claim is running.' })
      void refresh()
    } catch (cause) {
      const error = asApiError(cause)
      setNotice({
        kind: 'error',
        text:
          error.status === 409
            ? error.body?.error || 'A claim or a supplier login is using the browser profile. Wait for it to finish, then run the claim.'
            : error.body?.error || error.message,
      })
    } finally {
      setRunningId(null)
    }
  }, [refresh])

  const setUpLogin = useCallback((marketplace: string) => {
    try {
      window.sessionStorage.setItem(FOCUS_LOGIN_STORAGE_KEY, marketplace)
    } catch {
      // Best effort: the Settings page simply will not pre-focus the panel.
    }
    window.location.hash = '#settings'
  }, [])

  const rejoinPanel = useCallback(async (panel: PanelStatus) => {
    setClearingPanelKey(panel.key)
    try {
      const result = await apiPost<PanelClearResponse>(`/api/panels/${encodeURIComponent(panel.key)}/clear`)
      setPanelsOverride(result.panels)
    } catch (cause) {
      setNotice({ kind: 'error', text: asApiError(cause).body?.error || asApiError(cause).message })
    } finally {
      setClearingPanelKey(null)
    }
  }, [])

  const columns = useMemo<Array<DataTableColumn<JobRow>>>(() => [
    {
      key: 'channel',
      header: 'Channel',
      render: (row) => <MarketplaceBadge marketplace={row.marketplace} />,
    },
    {
      key: 'order',
      header: 'Order / AWB',
      render: (row) => (
        <button
          type="button"
          onClick={() => setSelectedId((current) => (current === row.id ? null : row.id))}
          aria-expanded={selectedId === row.id}
          aria-controls="claim-detail"
          className="block text-left"
        >
          <span className="block font-semibold text-ink">{row.trackingId || '—'}</span>
          <span className="block font-mono text-xs text-muted">{row.orderNumber || '—'}</span>
        </button>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => row.claimReason || 'Damaged / Wrong',
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div>
          <Badge variant={stageVariant(row.stage)}>{row.stage}</Badge>
          {row.manualActionReason ? <div className="mt-1 text-xs text-red">{row.manualActionReason}</div> : null}
        </div>
      ),
    },
    {
      key: 'ticket',
      header: 'Marketplace Ticket Ref',
      render: (row) =>
        row.marketplaceClaimId ? (
          <span className="font-mono text-green-dark">{row.marketplaceClaimId}</span>
        ) : (
          <span className="text-muted">Pending Submit</span>
        ),
    },
    {
      key: 'updated',
      header: 'Updated',
      render: (row) => <span className="text-xs text-muted">{formatTime(row.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          {row.stage !== 'completed' ? (
            <button
              type="button"
              disabled={runningId === row.id}
              onClick={() => void runOne(row)}
              className={BTN_PRIMARY}
            >
              {runningId === row.id ? 'Running…' : 'Run this claim'}
            </button>
          ) : null}
          {needsLoginSetup(row.manualActionReason) ? (
            <button type="button" onClick={() => setUpLogin(row.marketplace)} className={BTN_SECONDARY}>
              Set up login
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setSelectedId((current) => (current === row.id ? null : row.id))}
            aria-expanded={selectedId === row.id}
            aria-controls="claim-detail"
            className="text-xs font-medium text-blue hover:underline"
          >
            {selectedId === row.id ? 'Hide details' : 'Details'}
          </button>
        </div>
      ),
    },
  ], [runningId, selectedId, runOne, setUpLogin])

  const detailLogs = useMemo(() => {
    if (!selectedRow) return []
    const logs = Array.isArray(selectedRow.logs) ? selectedRow.logs : []
    return [...logs].sort((a, b) => {
      const left = typeof a.timestamp === 'string' ? a.timestamp : ''
      const right = typeof b.timestamp === 'string' ? b.timestamp : ''
      return left < right ? -1 : left > right ? 1 : 0
    })
  }, [selectedRow])

  return (
    <section aria-labelledby="page-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 id="page-title" className="font-display text-xl font-bold text-ink">Claims</h1>
          <p className="text-xs text-muted">Live claim pipeline from the engine — never shows downloaded evidence as uploaded.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={refreshing} className={BTN_SECONDARY}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {notice ? (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`mt-3 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
            notice.kind === 'error' ? 'border-red/30 bg-red-soft text-red' : 'border-green/25 bg-green-soft text-green-dark'
          }`}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss message"
            className="rounded-md px-1.5 py-0.5 text-xs hover:bg-surface"
          >
            ✕
          </button>
        </div>
      ) : null}

      {jobsError && jobs ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-orange/30 bg-orange-soft px-3 py-2 text-sm text-orange">
          <span>Live claim updates paused — {jobsError.body?.error || jobsError.message}</span>
          <button type="button" onClick={() => void refresh()} className="text-xs font-semibold underline">
            Retry now
          </button>
        </div>
      ) : null}

      {/* Supplier panel strip */}
      <div className="mt-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Supplier panels</h2>
        {panels === null && !panelsError ? (
          <div className="mt-2">
            <Spinner label="Loading panels" />
          </div>
        ) : null}
        {panelsError && panels === null ? (
          <div className="mt-2">
            <ErrorState
              title="Could not load panels"
              message={panelsError.body?.error || panelsError.message}
              onRetry={() => void refresh()}
            />
          </div>
        ) : null}
        {panels ? (
          panels.length === 0 ? (
            <div className="mt-2">
              <EmptyState title="No panels reported" message="Panel states appear here after the engine starts." />
            </div>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
              {panels.map((panel) => (
                <div key={panel.key} className="rounded-xl border border-line bg-surface p-3 shadow-card">
                  <div className="flex items-center justify-between gap-2">
                    <PanelStateDot state={panel.state} />
                    <Badge variant={panel.automated ? 'purple' : 'neutral'}>{panel.automated ? 'Automatic' : 'Assisted'}</Badge>
                  </div>
                  <div className="mt-2 truncate text-sm font-semibold text-ink" title={panel.name}>
                    {panel.name}
                  </div>
                  <div className="text-xs text-muted">{panel.sessionSavedAt ? 'Cookies ✓' : 'No saved session'}</div>
                  <div className="truncate text-xs text-muted" title={panel.lastResult ?? undefined}>
                    {panel.lastResult || 'No activity yet'}
                  </div>
                  {panel.state === 'manual_action' || panel.state === 'cooldown' ? (
                    <button
                      type="button"
                      disabled={clearingPanelKey === panel.key}
                      onClick={() => void rejoinPanel(panel)}
                      className="mt-2 w-full rounded-lg border border-orange/40 bg-orange-soft px-2 py-1 text-xs font-semibold text-orange hover:opacity-90"
                    >
                      {clearingPanelKey === panel.key ? 'Rejoining…' : 'Rejoin rotation'}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>

      {/* Claims pipeline */}
      <div className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Claims pipeline</h2>

        {jobs === null && !jobsError ? (
          <div className="mt-3">
            <Spinner label="Loading claims" />
          </div>
        ) : null}

        {jobsError && !jobs ? (
          <div className="mt-3">
            <ErrorState
              title="Could not load claims"
              message={jobsError.body?.error || jobsError.message}
              onRetry={() => void refresh()}
            />
          </div>
        ) : null}

        {jobs !== null ? (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label htmlFor="claims-search" className="sr-only">
                Search by order number, AWB, ticket reference or marketplace
              </label>
              <input
                id="claims-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search order, AWB, ticket, marketplace…"
                className="w-full max-w-xs rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink outline-none focus:border-blue"
              />
              <div role="group" aria-label="Filter claims by stage" className="flex flex-wrap items-center gap-2">
                {CHIPS.map((item) => {
                  const active = chip === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setChip(item.id)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium ${
                        active
                          ? 'border-green/40 bg-green-soft text-green-dark'
                          : 'border-line bg-surface text-muted hover:text-ink'
                      }`}
                    >
                      {item.label} <span aria-hidden="true">{counts[item.id]}</span>
                      <span className="sr-only">{` (${counts[item.id]} claims)`}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="mt-3">
              <DataTable
                ariaLabel="Claims"
                columns={columns}
                rows={filteredRows}
                rowKey={(row) => row.id}
                emptyTitle="No claims match"
                emptyMessage={query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing in this bucket right now.'}
              />
            </div>

            {selectedId !== null ? (
              <div id="claim-detail" className="mt-4 rounded-xl border border-line bg-surface shadow-card">
                <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <MarketplaceBadge marketplace={selectedRow?.marketplace ?? ''} />
                    <h3 className="font-display text-sm font-bold text-ink">
                      {selectedRow?.claimTitle || selectedRow?.trackingId || selectedRow?.orderNumber || 'Claim details'}
                    </h3>
                    {selectedRow ? <Badge variant={stageVariant(selectedRow.stage)}>{selectedRow.stage}</Badge> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    aria-label="Close claim details"
                    className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-ink"
                  >
                    ✕
                  </button>
                </div>

                {selectedRow ? (
                  <div className="px-4 py-3">
                    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <dt className="text-xs text-muted">Order</dt>
                        <dd className="font-mono text-ink">{selectedRow.orderNumber || '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">AWB</dt>
                        <dd className="font-semibold text-ink">{selectedRow.trackingId || '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Attempts</dt>
                        <dd className="text-ink">
                          {selectedRow.attempts}/{selectedRow.maxAttempts}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Marketplace ticket</dt>
                        <dd className="font-mono text-ink">{selectedRow.marketplaceClaimId || 'Pending Submit'}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Reason</dt>
                        <dd className="text-ink">{selectedRow.claimReason || 'Damaged / Wrong'}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Updated</dt>
                        <dd className="text-ink">{formatDateTime(selectedRow.updatedAt)}</dd>
                      </div>
                    </dl>

                    {selectedRow.manualActionReason ? (
                      <p className="mt-3 rounded-lg bg-red-soft px-3 py-2 text-xs text-red">{selectedRow.manualActionReason}</p>
                    ) : null}

                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <section aria-label="Claim log timeline">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Log timeline</h4>
                        {detailLogs.length === 0 ? (
                          <p className="mt-2 text-xs text-muted">No log entries for this claim yet.</p>
                        ) : (
                          <ol className="mt-2 max-h-72 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface-2 p-3">
                            {detailLogs.map((entry, index) => (
                              <li key={index} className="flex items-baseline gap-2 text-xs">
                                <span className="shrink-0 text-muted">{formatTime(entry.timestamp)}</span>
                                <span
                                  className={
                                    entry.level === 'error'
                                      ? 'shrink-0 font-semibold text-red'
                                      : entry.level === 'warn'
                                        ? 'shrink-0 font-semibold text-orange'
                                        : entry.level === 'info'
                                          ? 'shrink-0 text-blue'
                                          : 'shrink-0 text-muted'
                                  }
                                >
                                  {entry.level}
                                </span>
                                <span className="break-words text-ink">{entry.message}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </section>

                      <section aria-label="Claim evidence">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Local evidence</h4>
                        <div className="mt-2">
                          <EvidenceSection claimId={selectedRow.claimId} engineBase={engineBase} />
                        </div>
                      </section>
                    </div>
                  </div>
                ) : (
                  <div className="px-4 py-3">
                    <EmptyState
                      title="Claim left the recent list"
                      message="It is no longer in the latest jobs returned by the engine."
                    />
                  </div>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}
