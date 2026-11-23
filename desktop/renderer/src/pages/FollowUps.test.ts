import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterFollowUps,
  followUpStateLabel,
  followUpSummaryText,
  isResponseNeeded,
  whenText,
} from './FollowUps.js'
import type { FollowUpRow } from '../types/engine.js'

const NOW = Date.parse('2026-11-04T12:00:00.000Z')

describe('whenText', () => {
  it('renders a dash when the timestamp is missing or unparseable', () => {
    assert.equal(whenText(null, NOW), '—')
    assert.equal(whenText(undefined, NOW), '—')
    assert.equal(whenText('', NOW), '—')
    assert.equal(whenText('not-a-date', NOW), '—')
  })

  it("renders 'just now' within the same minute", () => {
    assert.equal(whenText('2026-11-04T12:00:00.000Z', NOW), 'just now')
    assert.equal(whenText('2026-11-04T11:59:30.000Z', NOW), 'just now')
  })

  it('renders minutes, hours and days for past times', () => {
    assert.equal(whenText('2026-11-04T11:55:00.000Z', NOW), '5m ago')
    assert.equal(whenText('2026-11-04T10:30:00.000Z', NOW), '2h ago')
    assert.equal(whenText('2026-11-04T00:00:00.000Z', NOW), '12h ago')
    assert.equal(whenText('2026-11-01T12:00:00.000Z', NOW), '3d ago')
  })

  it('renders relative times for future checks', () => {
    assert.equal(whenText('2026-11-04T12:10:00.000Z', NOW), 'in 10m')
    assert.equal(whenText('2026-11-04T17:00:00.000Z', NOW), 'in 5h')
    assert.equal(whenText('2026-11-07T12:00:00.000Z', NOW), 'in 3d')
  })
})

describe('followUpStateLabel', () => {
  it('flags action required when the ticket demands a seller response or proof', () => {
    assert.equal(
      followUpStateLabel({
        isActive: true,
        errorStreak: 0,
        checkIntervalHours: 48,
        stopReason: '',
        statusAtLastCheck: 'Please provide clear unboxing video within 24 hours',
      }),
      'action required',
    )
    assert.equal(
      followUpStateLabel({
        isActive: true,
        errorStreak: 0,
        checkIntervalHours: 48,
        stopReason: '',
        statusAtLastCheck: 'Action required: waiting for seller response',
      }),
      'action required',
    )
  })

  it('reports the error streak for an active follow-up that keeps failing', () => {
    assert.equal(
      followUpStateLabel({ isActive: true, errorStreak: 3, checkIntervalHours: 48, stopReason: '' }),
      'errors ×3',
    )
  })

  it('reports the check cadence for a healthy active follow-up', () => {
    assert.equal(
      followUpStateLabel({ isActive: true, errorStreak: 0, checkIntervalHours: 48, stopReason: '' }),
      'checking every 48h',
    )
    assert.equal(
      followUpStateLabel({ isActive: true, errorStreak: 0, checkIntervalHours: 24, stopReason: '' }),
      'checking every 24h',
    )
  })

  it('maps every stop reason to its short label', () => {
    const stopped = { isActive: false, errorStreak: 0, checkIntervalHours: 48 }
    assert.equal(followUpStateLabel({ ...stopped, stopReason: 'ticket_resolved' }), 'resolved')
    assert.equal(followUpStateLabel({ ...stopped, stopReason: 'check_not_supported' }), 'tracking not supported')
    assert.equal(followUpStateLabel({ ...stopped, stopReason: 'repeated_errors' }), 'stopped: repeated errors')
    assert.equal(followUpStateLabel({ ...stopped, stopReason: 'max_checks_reached' }), 'stopped: max checks')
  })

  it('falls back to a generic stopped label for unknown or missing reasons', () => {
    const stopped = { isActive: false, errorStreak: 0, checkIntervalHours: 48 }
    assert.equal(followUpStateLabel({ ...stopped, stopReason: 'mystery' }), 'stopped')
    assert.equal(followUpStateLabel({ ...stopped, stopReason: '' }), 'stopped')
    assert.equal(followUpStateLabel({ ...stopped, stopReason: null }), 'stopped')
  })
})

describe('followUpSummaryText', () => {
  it('defaults missing counts to zero instead of rendering undefined', () => {
    assert.equal(followUpSummaryText({ active: 2 } as any, false), '(2 tracking · 0 due now · 0 resolved)')
    assert.equal(followUpSummaryText(undefined, true), '(unavailable)')
    assert.equal(followUpSummaryText(null, false), '')
  })
})

describe('isResponseNeeded', () => {
  it('identifies action and response request phrases from the marketplace', () => {
    assert.equal(
      isResponseNeeded({ claimStatus: 'under_review', statusAtLastCheck: 'Please provide unboxing video' }),
      true,
    )
    assert.equal(
      isResponseNeeded({ claimStatus: 'under_review', statusAtLastCheck: 'Action required: share proof' }),
      true,
    )
    assert.equal(
      isResponseNeeded({ claimStatus: 'under_review', statusAtLastCheck: 'Waiting for you to reply' }),
      true,
    )
    assert.equal(
      isResponseNeeded({ claimStatus: 'under_review', statusAtLastCheck: 'Upload new label photo' }),
      true,
    )
  })

  it('returns false for regular under review, approved, or rejected tickets', () => {
    assert.equal(
      isResponseNeeded({ claimStatus: 'under_review', statusAtLastCheck: 'Ticket under review by Meesho' }),
      false,
    )
    assert.equal(
      isResponseNeeded({ claimStatus: 'approved', statusAtLastCheck: 'Claim approved for ₹450' }),
      false,
    )
    assert.equal(
      isResponseNeeded({ claimStatus: 'rejected', statusAtLastCheck: 'Rejected: Product arrived intact' }),
      false,
    )
  })
})

describe('filterFollowUps', () => {
  const sampleRows: FollowUpRow[] = [
    {
      id: 1,
      marketplace: 'meesho',
      accountName: 'Ethnic Junction',
      orderNumber: 'ORD-101',
      subOrderId: '342207442614944832_1',
      awb: 'R2744240422FPL',
      marketplaceClaimId: '794219443852',
      claimStatus: 'approved',
      statusAtLastCheck: 'Claim approved for ₹618.24',
      approvedAmount: 618.24,
      lastCheckedAt: '2026-11-20T10:00:00.000Z',
      nextCheckAt: '',
      checkCount: 4,
      isActive: false,
      checkIntervalHours: 48,
      errorStreak: 0,
      stopReason: 'ticket_resolved',
      lastError: null,
    },
    {
      id: 2,
      marketplace: 'meesho',
      accountName: 'VB Exports',
      orderNumber: 'ORD-102',
      subOrderId: '344400518893652096_1',
      awb: 'R2752538828MEO',
      marketplaceClaimId: '794219052322',
      claimStatus: 'in_progress',
      statusAtLastCheck: 'Please provide clear unboxing video within 24 hours',
      claimAmount: 499.0,
      lastCheckedAt: '2026-11-22T08:00:00.000Z',
      nextCheckAt: '2026-11-24T08:00:00.000Z',
      checkCount: 2,
      isActive: true,
      checkIntervalHours: 48,
      errorStreak: 0,
      stopReason: null,
      lastError: null,
    },
    {
      id: 3,
      marketplace: 'flipkart',
      accountName: 'VB Exports',
      orderNumber: 'OD1234567890',
      subOrderId: '',
      awb: 'FMPC1234567',
      marketplaceClaimId: 'IN261103001',
      claimStatus: 'under_review',
      statusAtLastCheck: 'Investigating incident with courier partner',
      claimAmount: 850.0,
      lastCheckedAt: '2026-11-23T00:00:00.000Z',
      nextCheckAt: '2026-11-25T00:00:00.000Z',
      checkCount: 1,
      isActive: true,
      checkIntervalHours: 48,
      errorStreak: 0,
      stopReason: null,
      lastError: null,
    },
    {
      id: 4,
      marketplace: 'myntra',
      accountName: 'Ethnic Junction',
      orderNumber: 'MYN-998877',
      subOrderId: '',
      awb: '13380099',
      marketplaceClaimId: 'TKT-MYN-001',
      claimStatus: 'rejected',
      statusAtLastCheck: 'Claim rejected: Return window elapsed',
      claimAmount: 1200.0,
      lastCheckedAt: '2026-11-19T14:00:00.000Z',
      nextCheckAt: '',
      checkCount: 3,
      isActive: false,
      checkIntervalHours: 48,
      errorStreak: 0,
      stopReason: 'ticket_resolved',
      lastError: null,
    },
  ]

  it('returns all rows when no filters or query are applied', () => {
    const result = filterFollowUps(sampleRows, '', 'all', 'all')
    assert.equal(result.length, 4)
  })

  it('filters by search query matching Ticket ID', () => {
    const result = filterFollowUps(sampleRows, '794219443852', 'all', 'all')
    assert.equal(result.length, 1)
    assert.equal(result[0]?.id, 1)
  })

  it('filters by search query matching Sub-Order ID', () => {
    const result = filterFollowUps(sampleRows, '344400518893652096_1', 'all', 'all')
    assert.equal(result.length, 1)
    assert.equal(result[0]?.id, 2)
  })

  it('filters by search query matching AWB', () => {
    const result = filterFollowUps(sampleRows, 'FMPC1234567', 'all', 'all')
    assert.equal(result.length, 1)
    assert.equal(result[0]?.id, 3)
  })

  it('filters by status tab: action_required', () => {
    const result = filterFollowUps(sampleRows, '', 'all', 'action_required')
    assert.equal(result.length, 1)
    assert.equal(result[0]?.id, 2)
  })

  it('filters by status tab: active', () => {
    const result = filterFollowUps(sampleRows, '', 'all', 'active')
    assert.equal(result.length, 2)
    assert.deepEqual(
      result.map((r) => r.id),
      [2, 3],
    )
  })

  it('filters by status tab: resolved', () => {
    const result = filterFollowUps(sampleRows, '', 'all', 'resolved')
    assert.equal(result.length, 2)
    assert.deepEqual(
      result.map((r) => r.id),
      [1, 4],
    )
  })

  it('filters by marketplace: meesho', () => {
    const result = filterFollowUps(sampleRows, '', 'meesho', 'all')
    assert.equal(result.length, 2)
    assert.deepEqual(
      result.map((r) => r.id),
      [1, 2],
    )
  })

  it('filters by marketplace: flipkart', () => {
    const result = filterFollowUps(sampleRows, '', 'flipkart', 'all')
    assert.equal(result.length, 1)
    assert.equal(result[0]?.id, 3)
  })

  it('filters by marketplace: myntra', () => {
    const result = filterFollowUps(sampleRows, '', 'myntra', 'all')
    assert.equal(result.length, 1)
    assert.equal(result[0]?.id, 4)
  })

  it('combines marketplace and status filters correctly', () => {
    const result = filterFollowUps(sampleRows, '', 'meesho', 'action_required')
    assert.equal(result.length, 1)
    assert.equal(result[0]?.id, 2)

    const noResult = filterFollowUps(sampleRows, '', 'flipkart', 'action_required')
    assert.equal(noResult.length, 0)
  })
})
