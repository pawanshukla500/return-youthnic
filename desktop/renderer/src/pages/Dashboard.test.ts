import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countJobStages,
  deriveOverallStatus,
  derivePanelChips,
  formatEngineTime,
  formatLogTime,
  normalizeLogLevel,
} from './dashboard/dashboard-logic'
import type { FollowUpsSummary, JobRow, PanelStatus, StatusSnapshot } from '../types/engine'

/* Synthetic fixtures — pure in-memory shapes, never touch the engine. */

function makeStatus(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    isRunning: true,
    isCurrentlyProcessing: false,
    activeJobInfo: null,
    activeSummary: null,
    nextPollCountdown: 30,
    lastHeartbeatTime: '10:20:30 am',
    lastPollTime: '2026-11-04T04:50:00.000Z',
    lastFollowUpCheckTime: '',
    followUpChecksRun: 0,
    lastFollowUpResult: '',
    backendUrl: 'http://127.0.0.1:4000',
    agentUuid: 'agent-1',
    agentName: 'Test agent',
    signedIn: true,
    ...overrides,
  }
}

function makePanel(overrides: Partial<PanelStatus> = {}): PanelStatus {
  return {
    key: 'meesho',
    name: 'Meesho',
    portalUrl: 'https://supplier.meesho.com',
    automated: true,
    profileDir: '/profiles/meesho',
    sessionSavedAt: '2026-11-04T04:00:00.000Z',
    state: 'idle',
    activeJobId: null,
    consecutiveErrors: 0,
    lastResult: null,
    lastResultAt: null,
    ...overrides,
  }
}

function makeJob(stage: string): JobRow {
  return {
    id: 1,
    claimId: 1,
    marketplace: 'Meesho',
    accountName: 'SYN-Account',
    orderNumber: 'SYN-ORDER-1',
    trackingId: 'SYN-TRACK-1',
    marketplaceClaimId: '',
    stage,
    manualActionReason: null,
    claimReason: null,
    claimTitle: null,
    updatedAt: '2026-11-04T04:50:00.000Z',
    attempts: 0,
    maxAttempts: 3,
    logs: [],
  }
}

function makeFollowSummary(overrides: Partial<FollowUpsSummary> = {}): FollowUpsSummary {
  return { active: 0, due: 0, resolved: 0, withErrors: 0, ...overrides }
}

/* ------------------------------------------------------------------ */
/* countJobStages                                                       */
/* ------------------------------------------------------------------ */

test('countJobStages: empty list gives zeroed buckets', () => {
  assert.deepEqual(countJobStages([]), {
    total: 0,
    completed: 0,
    queued: 0,
    inProgress: 0,
    actionRequired: 0,
  })
})

test('countJobStages: buckets every stage exactly like the legacy KPI counters', () => {
  const rows = [
    makeJob('completed'),
    makeJob('queued'),
    makeJob('downloading_media'),
    makeJob('opening_portal'),
    makeJob('filling_form'),
    makeJob('submitting'),
    makeJob('manual_intervention_required'),
    makeJob('failed'),
    makeJob('prepared'),
    makeJob('something_unmapped'),
  ]
  assert.deepEqual(countJobStages(rows), {
    total: 10,
    completed: 1,
    queued: 1,
    inProgress: 4,
    actionRequired: 3,
  })
})

/* ------------------------------------------------------------------ */
/* deriveOverallStatus                                                  */
/* ------------------------------------------------------------------ */

const ALL_IDLE_CONNECTED = [
  makePanel(),
  makePanel({ key: 'flipkart', name: 'Flipkart', automated: false }),
]

test('deriveOverallStatus: missing status or loading panels → checking', () => {
  assert.equal(
    deriveOverallStatus({ status: null, panels: [], followUpSummary: makeFollowSummary() }).state,
    'checking',
  )
  assert.equal(
    deriveOverallStatus({ status: makeStatus(), panels: undefined, followUpSummary: makeFollowSummary() }).state,
    'checking',
  )
})

test('deriveOverallStatus: signed out → Waiting for sign-in', () => {
  const result = deriveOverallStatus({
    status: makeStatus({ signedIn: false }),
    panels: [],
    followUpSummary: undefined,
  })
  assert.equal(result.state, 'signed-out')
  assert.equal(result.title, 'Waiting for sign-in')
})

test('deriveOverallStatus: healthy engine → All panels green with follow-up detail', () => {
  const result = deriveOverallStatus({
    status: makeStatus(),
    panels: ALL_IDLE_CONNECTED,
    followUpSummary: makeFollowSummary({ active: 3, due: 1 }),
  })
  assert.equal(result.state, 'all-green')
  assert.equal(result.title, 'All panels green')
  assert.match(result.detail, /bot is running/)
  assert.match(result.detail, /3 ticket\(s\) being followed up, 1 due now/)
})

test('deriveOverallStatus: paused bot is an action reason', () => {
  const result = deriveOverallStatus({
    status: makeStatus({ isRunning: false }),
    panels: ALL_IDLE_CONNECTED,
    followUpSummary: makeFollowSummary(),
  })
  assert.equal(result.state, 'action-required')
  assert.ok(result.reasons.includes('the bot is paused'))
})

test('deriveOverallStatus: manual_action and cooldown panels name themselves', () => {
  const result = deriveOverallStatus({
    status: makeStatus(),
    panels: [
      makePanel({ key: 'myntra_vb', name: 'Myntra VB', automated: false, state: 'manual_action' }),
      makePanel({ key: 'ajio', name: 'Ajio', automated: false, state: 'cooldown' }),
    ],
    followUpSummary: makeFollowSummary(),
  })
  assert.equal(result.state, 'action-required')
  assert.ok(result.reasons.includes('Myntra VB need(s) you in the supplier browser'))
  assert.ok(result.reasons.includes('Ajio stopped after repeated failures'))
})

test('deriveOverallStatus: failing ticket checks are an action reason', () => {
  const result = deriveOverallStatus({
    status: makeStatus(),
    panels: ALL_IDLE_CONNECTED,
    followUpSummary: makeFollowSummary({ withErrors: 2 }),
  })
  assert.ok(result.reasons.includes('2 ticket check(s) failing'))
})

test('deriveOverallStatus: multiple reasons join with a middle dot', () => {
  const result = deriveOverallStatus({
    status: makeStatus({ isRunning: false }),
    panels: ALL_IDLE_CONNECTED,
    followUpSummary: makeFollowSummary({ withErrors: 2 }),
  })
  assert.deepEqual(result.reasons, ['the bot is paused', '2 ticket check(s) failing'])
  assert.match(result.detail, /the bot is paused · 2 ticket check\(s\) failing/)
})

test('deriveOverallStatus: unconnected ASSISTED panels count, automated ones do not', () => {
  const result = deriveOverallStatus({
    status: makeStatus(),
    panels: [
      makePanel({ sessionSavedAt: null }), // automated, no session → not flagged (mission rule)
      makePanel({ key: 'ajio', name: 'Ajio', automated: false, sessionSavedAt: null }),
    ],
    followUpSummary: makeFollowSummary(),
  })
  assert.equal(result.state, 'action-required')
  assert.ok(result.reasons.includes('connect 1 panel(s): Ajio'))
  assert.equal(result.reasons.filter((reason) => reason.startsWith('connect')).length, 1)
})

test('deriveOverallStatus: failed follow-up summary is a reason, loading one is not', () => {
  const failed = deriveOverallStatus({
    status: makeStatus(),
    panels: ALL_IDLE_CONNECTED,
    followUpSummary: null,
  })
  assert.ok(failed.reasons.includes('ticket follow-ups could not be loaded'))

  const loading = deriveOverallStatus({
    status: makeStatus(),
    panels: ALL_IDLE_CONNECTED,
    followUpSummary: undefined,
  })
  assert.equal(loading.state, 'all-green')
})

test('deriveOverallStatus: failed panel load is a reason', () => {
  const result = deriveOverallStatus({
    status: makeStatus(),
    panels: null,
    followUpSummary: makeFollowSummary(),
  })
  assert.equal(result.state, 'action-required')
  assert.ok(result.reasons.includes('panel status could not be loaded'))
})

/* ------------------------------------------------------------------ */
/* derivePanelChips                                                     */
/* ------------------------------------------------------------------ */

test('derivePanelChips: tone and text mirror the legacy chip renderer', () => {
  const chips = derivePanelChips([
    makePanel({ key: 'a', name: 'A' }), // connected + idle → Ready
    makePanel({ key: 'b', name: 'B', sessionSavedAt: null }), // no session → Connect
    makePanel({ key: 'c', name: 'C', state: 'manual_action' }), // → Needs you
    makePanel({ key: 'd', name: 'D', state: 'cooldown' }), // → Cooling down
    makePanel({ key: 'e', name: 'E', state: 'submitting' }), // → Working
  ])
  assert.deepEqual(
    chips.map((chip) => `${chip.tone}:${chip.text}`),
    ['green:Ready', 'amber:Connect', 'amber:Needs you', 'amber:Cooling down', 'blue:Working'],
  )
})

/* ------------------------------------------------------------------ */
/* Formatters                                                           */
/* ------------------------------------------------------------------ */

test('formatEngineTime: empty → dash, ISO → localized, plain time passes through', () => {
  assert.equal(formatEngineTime(''), '—')
  assert.equal(formatEngineTime(null), '—')
  assert.match(formatEngineTime('2026-11-04T04:50:00.000Z'), /\d/)
  assert.equal(formatEngineTime('5:30:00 pm'), '5:30:00 pm')
})

test('formatLogTime: ISO timestamp keeps only the clock part', () => {
  assert.equal(formatLogTime('2026-11-04T10:20:30.123Z'), '10:20:30')
  assert.equal(formatLogTime('10:20:30'), '10:20:30')
  assert.equal(formatLogTime(''), '')
})

test('normalizeLogLevel: known levels kept, unknown mapped to info', () => {
  assert.equal(normalizeLogLevel('warn'), 'warn')
  assert.equal(normalizeLogLevel('ERROR'.toLowerCase()), 'error')
  assert.equal(normalizeLogLevel('notice'), 'info')
})
