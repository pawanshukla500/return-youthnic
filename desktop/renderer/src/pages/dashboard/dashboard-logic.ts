import type { FollowUpsSummary, JobRow, PanelStatus, StatusSnapshot } from '../../types/engine'

/**
 * Pure dashboard derivations — no DOM, no React. Kept side-effect free so the
 * co-located node:test suite (Dashboard.test.ts) can exercise them directly.
 * Behaviour mirrors the legacy engine dashboard in
 * desktop-agent/src/desktop-app-server.ts (renderOverall ~line 2019,
 * KPI counters ~line 2087) unless a deviation is called out in a comment.
 */

/* ------------------------------------------------------------------ */
/* Job stage KPIs                                                       */
/* ------------------------------------------------------------------ */

export const IN_PROGRESS_STAGES = ['downloading_media', 'opening_portal', 'filling_form', 'submitting'] as const
export const ACTION_REQUIRED_STAGES = ['manual_intervention_required', 'failed', 'prepared'] as const

export type JobStageCounts = {
  total: number
  completed: number
  queued: number
  inProgress: number
  actionRequired: number
}

/** Buckets the job list into the five dashboard KPI counters. */
export function countJobStages(rows: JobRow[]): JobStageCounts {
  const counts: JobStageCounts = { total: rows.length, completed: 0, queued: 0, inProgress: 0, actionRequired: 0 }
  for (const row of rows) {
    if (row.stage === 'completed') counts.completed += 1
    else if (row.stage === 'queued') counts.queued += 1
    else if ((IN_PROGRESS_STAGES as readonly string[]).includes(row.stage)) counts.inProgress += 1
    else if ((ACTION_REQUIRED_STAGES as readonly string[]).includes(row.stage)) counts.actionRequired += 1
  }
  return counts
}

/* ------------------------------------------------------------------ */
/* Overall status headline                                              */
/* ------------------------------------------------------------------ */

export type OverallStatusState = 'checking' | 'signed-out' | 'action-required' | 'all-green'

export type OverallStatus = {
  state: OverallStatusState
  title: string
  detail: string
  reasons: string[]
}

/**
 * Derives the one headline the dashboard leads with.
 *
 * Deviation from the legacy dashboard (kept deliberately, per mission spec):
 * only ASSISTED panels without a saved session count as "unconnected".
 * The old dashboard counted every session-less panel, including automated ones.
 */
/**
 * `undefined` means the value is still loading (no verdict yet); `null` means
 * the poll failed (that becomes an "Action required" reason, as in the legacy
 * dashboard). Only ASSISTED panels without a saved session count as
 * "unconnected" — the old dashboard counted every session-less panel,
 * including automated ones.
 */
export function deriveOverallStatus(input: {
  status: StatusSnapshot | null
  panels: PanelStatus[] | null | undefined
  followUpSummary: FollowUpsSummary | null | undefined
}): OverallStatus {
  const { status, panels, followUpSummary } = input
  if (!status || panels === undefined) {
    return {
      state: 'checking',
      title: 'Checking status…',
      detail: 'Reading panel sessions, the bot state, and ticket follow-ups.',
      reasons: [],
    }
  }
  if (!status.signedIn) {
    return {
      state: 'signed-out',
      title: 'Waiting for sign-in',
      detail: 'Sign in to start the 24/7 claim bot.',
      reasons: [],
    }
  }

  const panelList = panels ?? []
  const reasons: string[] = []
  if (!status.isRunning) reasons.push('the bot is paused')

  const unconnectedAssisted = panelList.filter((panel) => !panel.automated && !panel.sessionSavedAt)
  if (unconnectedAssisted.length) {
    reasons.push(`connect ${unconnectedAssisted.length} panel(s): ${unconnectedAssisted.map((panel) => panel.name).join(', ')}`)
  }

  const needsYou = panelList.filter((panel) => panel.state === 'manual_action')
  if (needsYou.length) {
    reasons.push(`${needsYou.map((panel) => panel.name).join(', ')} need(s) you in the supplier browser`)
  }

  const cooling = panelList.filter((panel) => panel.state === 'cooldown')
  if (cooling.length) {
    reasons.push(`${cooling.map((panel) => panel.name).join(', ')} stopped after repeated failures`)
  }

  if (followUpSummary === null) {
    reasons.push('ticket follow-ups could not be loaded')
  } else if (followUpSummary && followUpSummary.withErrors > 0) {
    reasons.push(`${followUpSummary.withErrors} ticket check(s) failing`)
  }

  if (panels === null) reasons.push('panel status could not be loaded')

  if (reasons.length) {
    return {
      state: 'action-required',
      title: 'Action required',
      detail: `Please ${reasons.join(' · ')}.`,
      reasons,
    }
  }

  // reasons empty ⇒ the summary loaded (a missing one would itself be a reason)
  const summary = followUpSummary ?? { active: 0, due: 0, resolved: 0, withErrors: 0 }
  return {
    state: 'all-green',
    title: 'All panels green',
    detail:
      `Every panel is connected and the bot is ${status.isRunning ? 'running' : 'ready'}. ` +
      (followUpSummary === undefined
        ? 'Updating follow-up status…'
        : `${summary.active || 0} ticket(s) being followed up${summary.due ? `, ${summary.due} due now` : ''}.`),
    reasons: [],
  }
}

/* ------------------------------------------------------------------ */
/* Per-panel chips                                                      */
/* ------------------------------------------------------------------ */

export type PanelChipTone = 'green' | 'amber' | 'blue'

export type PanelChip = {
  key: string
  name: string
  tone: PanelChipTone
  text: string
}

/** Same tone/text mapping as the legacy dashboard chip renderer. */
export function derivePanelChips(panels: PanelStatus[]): PanelChip[] {
  return panels.map((panel) => {
    const ready = Boolean(panel.sessionSavedAt) && panel.state === 'idle'
    if (!panel.sessionSavedAt) return { key: panel.key, name: panel.name, tone: 'amber', text: 'Connect' }
    if (ready) return { key: panel.key, name: panel.name, tone: 'green', text: 'Ready' }
    if (panel.state === 'manual_action') return { key: panel.key, name: panel.name, tone: 'amber', text: 'Needs you' }
    if (panel.state === 'cooldown') return { key: panel.key, name: panel.name, tone: 'amber', text: 'Cooling down' }
    return { key: panel.key, name: panel.name, tone: 'blue', text: 'Working' }
  })
}

/* ------------------------------------------------------------------ */
/* Small formatters                                                     */
/* ------------------------------------------------------------------ */

/** ISO strings render localized; already-human strings (e.g. a bare en-IN time) pass through. */
export function formatEngineTime(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return '—'
  const parsed = new Date(trimmed)
  if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString()
  return trimmed
}

/** '2026-11-04T10:20:30.123Z' → '10:20:30'; anything else passes through unchanged. */
export function formatLogTime(timestamp: string): string {
  const trimmed = (timestamp ?? '').trim()
  if (!trimmed) return ''
  const timePart = trimmed.split('T')[1]
  if (timePart) return (timePart.split('.')[0] ?? trimmed) || trimmed
  return trimmed
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const KNOWN_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error']

export function normalizeLogLevel(level: string): LogLevel {
  return KNOWN_LEVELS.includes(level) ? (level as LogLevel) : 'info'
}
