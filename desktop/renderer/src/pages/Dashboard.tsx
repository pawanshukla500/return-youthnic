import { useEffect, useMemo, useState } from 'react'
import { useEngineStatus } from '../hooks/useEngineStatus'
import { useEnginePolling } from '../hooks/useEnginePolling'
import { apiGet, apiPost, EngineApiError } from '../services/engineApi'
import type {
  FollowUpsResponse,
  FollowUpsSummary,
  JobRow,
  OkResponse,
  PanelClearResponse,
  PanelsResponse,
  PanelStatus,
  SchedulerToggleResponse,
  StatusSnapshot,
} from '../types/engine'
import { Badge } from '../components/ui/Badge'
import { StatCard } from '../components/ui/StatCard'
import { PanelStateDot } from '../components/ui/PanelStateDot'
import { MarketplaceBadge } from '../components/ui/MarketplaceBadge'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Spinner } from '../components/ui/Spinner'
import {
  countJobStages,
  deriveOverallStatus,
  derivePanelChips,
  formatEngineTime,
  formatLogTime,
  normalizeLogLevel,
  type LogLevel,
  type PanelChipTone,
} from './dashboard/dashboard-logic'
import { useLogStream } from './dashboard/useLogStream'

const JOBS_POLL_MS = 10_000
const PANELS_POLL_MS = 5_000
const FOLLOW_UPS_POLL_MS = 60_000

function actionErrorMessage(cause: unknown): string {
  if (cause instanceof EngineApiError) return cause.body?.error || cause.message
  return cause instanceof Error ? cause.message : String(cause)
}

function WorkerPill({ status }: { status: StatusSnapshot | null }) {
  if (!status) return null
  if (status.isCurrentlyProcessing) return <Badge variant="blue">Processing {status.activeSummary ?? ''}</Badge>
  if (status.isRunning) return <Badge variant="green">Running</Badge>
  if (status.signedIn) return <Badge variant="orange">Paused</Badge>
  return <Badge>Idle</Badge>
}

const CHIP_TONE_CLASSES: Record<PanelChipTone, string> = {
  green: 'border-green/25 bg-green-soft text-green-dark',
  amber: 'border-orange/25 bg-orange-soft text-orange',
  blue: 'border-blue/25 bg-blue-soft text-blue',
}

const CHIP_DOT_CLASSES: Record<PanelChipTone, string> = {
  green: 'bg-green',
  amber: 'bg-orange',
  blue: 'bg-blue',
}

const LEVEL_TEXT_CLASSES: Record<LogLevel, string> = {
  debug: 'text-muted',
  info: 'text-ink',
  warn: 'text-orange',
  error: 'text-red',
}

export default function DashboardPage() {
  const { status, refresh } = useEngineStatus(2_000)
  const jobsPoll = useEnginePolling(() => apiGet<JobRow[]>('/api/jobs'), JOBS_POLL_MS, true)
  const panelsPoll = useEnginePolling(() => apiGet<PanelsResponse>('/api/panels'), PANELS_POLL_MS, true)
  const followUpsPoll = useEnginePolling(
    () => apiGet<FollowUpsResponse>('/api/follow-ups?pageSize=100'),
    FOLLOW_UPS_POLL_MS,
    true,
  )

  // A successful panel action returns the fresh panel list; hold it until the
  // next poll tick replaces it so the strip reacts immediately.
  const [panelsOverride, setPanelsOverride] = useState<PanelStatus[] | null>(null)
  useEffect(() => {
    setPanelsOverride(null)
  }, [panelsPoll.data])

  const panelsLoaded: PanelStatus[] | null | undefined =
    panelsPoll.data !== null ? panelsPoll.data.panels : panelsPoll.error !== null ? null : undefined
  const activePanels: PanelStatus[] | null | undefined = panelsOverride ?? panelsLoaded
  const panels = activePanels ?? null

  const followUpSummary: FollowUpsSummary | null | undefined =
    followUpsPoll.data !== null
      ? followUpsPoll.data.summary
      : followUpsPoll.error !== null
        ? null
        : undefined

  const overall = useMemo(
    () => deriveOverallStatus({ status, panels: activePanels, followUpSummary }),
    [status, activePanels, followUpSummary],
  )
  const chips = useMemo(() => derivePanelChips(panels ?? []), [panels])
  const kpis = useMemo(() => countJobStages(jobsPoll.data ?? []), [jobsPoll.data])

  // Next-poll countdown: seeded by each status snapshot, decremented locally
  // once per second between polls.
  const [countdown, setCountdown] = useState<number | null>(null)
  useEffect(() => {
    if (status) setCountdown(Math.max(0, Math.round(status.nextPollCountdown)))
  }, [status])
  useEffect(() => {
    const timer = window.setInterval(() => {
      setCountdown((value) => (value !== null && value > 0 ? value - 1 : value))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const [toggleBusy, setToggleBusy] = useState(false)
  const [pollBusy, setPollBusy] = useState(false)
  const [workerActionError, setWorkerActionError] = useState<string | null>(null)

  const toggleWorker = async () => {
    if (!status || toggleBusy) return
    const action = status.isRunning ? 'pause' : 'start'
    setToggleBusy(true)
    setWorkerActionError(null)
    try {
      await apiPost<SchedulerToggleResponse>(`/api/scheduler/toggle?action=${action}`)
      refresh()
    } catch (cause) {
      setWorkerActionError(actionErrorMessage(cause))
    } finally {
      setToggleBusy(false)
    }
  }

  const pollNow = async () => {
    if (!status || pollBusy) return
    setPollBusy(true)
    setWorkerActionError(null)
    try {
      await apiPost<OkResponse>('/api/scheduler/poll-now')
      refresh()
    } catch (cause) {
      setWorkerActionError(actionErrorMessage(cause))
    } finally {
      setPollBusy(false)
    }
  }

  const [clearingKey, setClearingKey] = useState<string | null>(null)
  const [panelActionError, setPanelActionError] = useState<string | null>(null)

  const rejoinRotation = async (key: string) => {
    if (clearingKey) return
    setClearingKey(key)
    setPanelActionError(null)
    try {
      const result = await apiPost<PanelClearResponse>(`/api/panels/${encodeURIComponent(key)}/clear`)
      setPanelsOverride(result.panels)
    } catch (cause) {
      setPanelActionError(actionErrorMessage(cause))
    } finally {
      setClearingKey(null)
    }
  }

  const { entries: logEntries, status: logStatus, clear: clearLogs } = useLogStream(5)

  const overallDotClass =
    overall.state === 'all-green'
      ? 'bg-green'
      : overall.state === 'action-required'
        ? 'bg-orange'
        : 'bg-muted'

  return (
    <section aria-labelledby="page-title" className="space-y-4">
      <h1 id="page-title" className="font-display text-xl font-bold text-ink">Dashboard</h1>

      {/* 1 — overall status headline */}
      <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className={`inline-block h-3.5 w-3.5 rounded-full ${overallDotClass}`} />
            <div>
              <div className="font-display text-base font-extrabold text-ink">{overall.title}</div>
              <div className="text-xs text-muted">{overall.detail}</div>
            </div>
          </div>
          {chips.length ? (
            <div className="flex flex-wrap items-center gap-2" aria-label="Panel overview">
              {chips.map((chip) => (
                <span
                  key={chip.key}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4 ${CHIP_TONE_CLASSES[chip.tone]}`}
                >
                  <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${CHIP_DOT_CLASSES[chip.tone]}`} />
                  {chip.name} · {chip.text}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* 2 — KPI grid */}
      {jobsPoll.data === null && jobsPoll.error === null ? (
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
          <Spinner label="Loading claim counts" />
        </div>
      ) : jobsPoll.data === null && jobsPoll.error !== null ? (
        <ErrorState
          title="Could not load claims"
          message={actionErrorMessage(jobsPoll.error)}
        />
      ) : (
        <div>
          {jobsPoll.error !== null ? (
            <div className="mb-2 rounded-lg border border-amber/30 bg-amber-soft px-3 py-1.5 text-xs font-medium text-amber">
              Could not refresh live claims ({actionErrorMessage(jobsPoll.error)}). Showing last snapshot.
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <StatCard label="Total" value={kpis.total} hint="All claims on this PC" />
          <StatCard label="Completed" value={kpis.completed} hint="Stage: completed" />
          <StatCard label="Queued" value={kpis.queued} hint="Waiting for the worker" />
          <StatCard label="In progress" value={kpis.inProgress} hint="Download → portal → form → submit" />
          <StatCard label="Action required" value={kpis.actionRequired} hint="Manual, failed or prepared" />
          </div>
        </div>
      )}

      {/* 3 + 5 — worker card and recent activity */}
      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-4 shadow-card" aria-labelledby="worker-title">
          <div className="flex items-center justify-between gap-2">
            <h2 id="worker-title" className="font-display text-sm font-bold text-ink">Worker</h2>
            <WorkerPill status={status} />
          </div>

          {!status ? (
            <div className="mt-3">
              <Spinner label="Reading worker status" />
            </div>
          ) : (
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted">Next poll</dt>
                <dd className="font-semibold text-ink">{countdown !== null ? `${countdown}s` : '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted">Last heartbeat</dt>
                <dd className="font-medium text-ink">{formatEngineTime(status.lastHeartbeatTime)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted">Last poll</dt>
                <dd className="font-medium text-ink">{formatEngineTime(status.lastPollTime)}</dd>
              </div>
              {status.nightlyWindow ? (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted">Nightly window</dt>
                  <dd className="text-right font-medium text-ink">
                    {status.nightlyWindow.nightlyOnly ? 'Nightly only' : 'Runs all day'}
                    {' — '}
                    {status.nightlyWindow.inWindow
                      ? 'inside the window now'
                      : `next window ${formatEngineTime(status.nightlyWindow.nextWindowStartIso)}`}
                  </dd>
                </div>
              ) : null}
            </dl>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void toggleWorker()}
              disabled={!status || toggleBusy}
              title={!status ? 'Waiting for the engine status' : undefined}
              className="rounded-lg bg-green px-4 py-2 text-sm font-semibold text-white hover:bg-green-dark"
            >
              {!status ? 'Pause bot' : toggleBusy ? 'Updating…' : status.isRunning ? 'Pause bot' : 'Resume bot'}
            </button>
            <button
              type="button"
              onClick={() => void pollNow()}
              disabled={!status || pollBusy}
              title={!status ? 'Waiting for the engine status' : undefined}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2"
            >
              {pollBusy ? 'Polling…' : '↻ Poll now'}
            </button>
          </div>
          {workerActionError ? (
            <p role="alert" className="mt-2 text-xs text-red">{workerActionError}</p>
          ) : null}
        </div>

        {/* 5 — recent activity (engine log stream, newest first) */}
        <div className="rounded-xl border border-line bg-surface p-4 shadow-card" aria-labelledby="activity-title">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 id="activity-title" className="font-display text-sm font-bold text-ink">Recent activity</h2>
              {logStatus === 'live' ? <Badge variant="green">Live</Badge> : null}
              {logStatus === 'connecting' ? <Badge>Connecting</Badge> : null}
              {logStatus === 'reconnecting' ? <Badge variant="orange">Reconnecting</Badge> : null}
            </div>
            <button
              type="button"
              onClick={clearLogs}
              disabled={logEntries.length === 0}
              title={logEntries.length === 0 ? 'Nothing to clear' : 'Clear the list'}
              className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-muted hover:text-ink"
            >
              Clear
            </button>
          </div>

          {logEntries.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              {logStatus === 'unavailable' ? 'Log stream unavailable.' : 'Waiting for engine log events…'}
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {logEntries.map((entry, index) => {
                const level = normalizeLogLevel(entry.level)
                return (
                  <li key={`${entry.timestamp}-${index}`} className="flex items-start gap-2 text-xs">
                    <span className="shrink-0 font-mono text-muted">{formatLogTime(entry.timestamp)}</span>
                    <span className={`w-10 shrink-0 font-semibold uppercase ${LEVEL_TEXT_CLASSES[level]}`}>{level}</span>
                    <span className="min-w-0 break-words text-ink">{entry.message}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* 4 — supplier panels strip */}
      <div aria-labelledby="panels-title">
        <h2 id="panels-title" className="font-display text-sm font-bold text-ink">Supplier panels</h2>
        {activePanels === undefined ? (
          <div className="mt-2 rounded-xl border border-line bg-surface p-6 shadow-card">
            <Spinner label="Loading panels" />
          </div>
        ) : activePanels === null ? (
          <div className="mt-2">
            <ErrorState title="Could not load panels" message={actionErrorMessage(panelsPoll.error)} />
          </div>
        ) : activePanels.length === 0 ? (
          <div className="mt-2">
            <EmptyState
              title="No supplier panels"
              message="The engine did not report any supplier panels."
            />
          </div>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-3">
              {activePanels.map((panel) => (
                <div
                  key={panel.key}
                  className="w-full min-w-[230px] flex-1 rounded-xl border border-line bg-surface p-3 shadow-card sm:w-[calc(50%-0.75rem)] xl:w-[calc(33.333%-0.75rem)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <PanelStateDot state={panel.state} />
                    <MarketplaceBadge marketplace={panel.name} size={20} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {panel.automated ? <Badge variant="green">Automated</Badge> : <Badge>Assisted</Badge>}
                    {panel.sessionSavedAt ? (
                      <Badge variant="blue" title={`Session saved ${formatEngineTime(panel.sessionSavedAt)}`}>
                        cookies ✓
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-2 truncate text-xs text-muted" title={panel.lastResult ?? ''}>
                    {panel.lastResult ? panel.lastResult : 'No result yet'}
                  </div>
                  {panel.state === 'manual_action' || panel.state === 'cooldown' ? (
                    <button
                      type="button"
                      onClick={() => void rejoinRotation(panel.key)}
                      disabled={clearingKey !== null}
                      title={clearingKey !== null && clearingKey !== panel.key ? 'Another panel action is running' : undefined}
                      className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
                    >
                      {clearingKey === panel.key ? 'Rejoining…' : 'Rejoin rotation'}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {panelActionError ? (
              <p role="alert" className="mt-2 text-xs text-red">{panelActionError}</p>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
