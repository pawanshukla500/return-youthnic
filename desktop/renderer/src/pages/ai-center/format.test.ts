import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AiMemoryResponse, AiUsageSummary } from '../../types/engine'
import {
  errorMessage,
  formatCount,
  formatDateTime,
  formatTimeoutMs,
  formatUsd,
  isValidYmd,
  memoryStatusLine,
  memoryStatusMeta,
  truncate,
  usageSummarySegments,
  validateDateRange,
} from './format.ts'

function usageSummary(partial: Partial<AiUsageSummary>): AiUsageSummary {
  return {
    total: 0,
    successful: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    estimatedUsd: 0,
    unknownPricing: 0,
    avgLatencyMs: null,
    byProvider: {},
    byModel: {},
    byTask: {},
    ...partial,
  }
}

test('formatUsd keeps unknown pricing unknown and trims zeros', () => {
  assert.equal(formatUsd(null), 'Unknown')
  assert.equal(formatUsd(undefined), 'Unknown')
  assert.equal(formatUsd(Number.NaN), 'Unknown')
  assert.equal(formatUsd(0), '$0')
  assert.equal(formatUsd(1.5), '$1.5')
  assert.equal(formatUsd(0.0012), '$0.0012')
  assert.equal(formatUsd(0.1), '$0.1')
})

test('formatCount renders reported counts and questions missing ones', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(1234), '1234')
  assert.equal(formatCount(null), '?')
  assert.equal(formatCount(undefined), '?')
})

test('formatDateTime mirrors the dashboard format and never throws', () => {
  assert.equal(formatDateTime(null), '—')
  assert.equal(formatDateTime(''), '—')
  const rendered = formatDateTime('2026-11-04T10:20:30.000Z')
  assert.match(rendered, /^\d{1,2}\/\d{1,2}\/\d{4},? /)
  assert.equal(formatDateTime('not-a-date'), 'not-a-date')
})

test('truncate slices without an ellipsis like the old dashboard', () => {
  assert.equal(truncate('short', 80), 'short')
  assert.equal(truncate('x'.repeat(100), 80), 'x'.repeat(80))
})

test('formatTimeoutMs renders whole seconds', () => {
  assert.equal(formatTimeoutMs(45000), '45s')
  assert.equal(formatTimeoutMs(undefined), '—')
  assert.equal(formatTimeoutMs(null), '—')
})

test('isValidYmd accepts real dates only', () => {
  assert.equal(isValidYmd('2026-11-04'), true)
  assert.equal(isValidYmd('2026-01-01'), true)
  assert.equal(isValidYmd('2026-13-01'), false)
  assert.equal(isValidYmd('2026-02-30'), false)
  assert.equal(isValidYmd('04/11/2026'), false)
  assert.equal(isValidYmd('2026-11-4'), false)
  assert.equal(isValidYmd(''), false)
})

test('validateDateRange allows empty bounds and rejects bad ranges', () => {
  assert.equal(validateDateRange('', ''), null)
  assert.equal(validateDateRange('2026-11-01', ''), null)
  assert.equal(validateDateRange('', '2026-11-01'), null)
  assert.equal(validateDateRange('2026-11-01', '2026-11-04'), null)
  assert.match(validateDateRange('nope', '') ?? '', /YYYY-MM-DD/)
  assert.match(validateDateRange('', '2026-11-31') ?? '', /YYYY-MM-DD/)
  assert.match(validateDateRange('2026-11-04', '2026-11-01') ?? '', /on or before/)
})

test('usageSummarySegments bolds the headline numbers', () => {
  const parts = usageSummarySegments(
    usageSummary({
      total: 12,
      successful: 10,
      failed: 2,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 25,
      estimatedUsd: 0.004,
      unknownPricing: 3,
      avgLatencyMs: 123,
    }),
  )
  const text = parts.map((p) => p.t).join('')
  assert.match(text, /Requests 12 \(ok 10 \/ failed 2\)/)
  assert.match(text, /in 100 \/ out 50 tokens \(cached 25\)/)
  assert.match(text, /est\. cost \$0\.004 \(3 without pricing\)/)
  assert.match(text, /avg latency 123 ms/)
  assert.equal(parts.find((p) => p.t === '12')?.strong, true)
  assert.equal(parts.find((p) => p.t === '$0.004')?.strong, true)
  // Unknown cost and missing latency stay honest (the engine may serialize a
  // null estimate even though the summary type declares a number).
  const bare = usageSummarySegments(
    usageSummary({ total: 1, successful: 1, failed: 0, estimatedUsd: null as unknown as number }),
  )
  const bareText = bare.map((p) => p.t).join('')
  assert.match(bareText, /est\. cost Unknown/)
  assert.match(bareText, /avg latency —/)
  assert.ok(!bareText.includes('cached'))
})

test('memoryStatusMeta maps the three known statuses', () => {
  assert.equal(memoryStatusMeta('approved').dotClass, 'bg-green')
  assert.equal(memoryStatusMeta('pending').dotClass, 'bg-orange')
  assert.equal(memoryStatusMeta('disabled').dotClass, 'bg-muted')
  assert.equal(memoryStatusMeta('mystery').label, 'mystery')
  assert.equal(memoryStatusMeta('').label, 'unknown')
})

test('memoryStatusLine merges mirror counts, events, switch and usage', () => {
  const data: AiMemoryResponse = {
    procedures: [
      { id: 'a', marketplace: 'meesho', errorSignature: 'sig', title: 't', steps: ['s'], status: 'approved', updatedAt: '' },
      { id: 'b', marketplace: 'meesho', errorSignature: 'sig', title: 't', steps: ['s'], status: 'disabled', updatedAt: '' },
      { id: 'c', marketplace: 'meesho', errorSignature: 'sig', title: 't', steps: [], status: 'pending', updatedAt: '' },
    ],
    events: [],
    recentEventCap: 20,
    usage: { calls: 7, failures: 1, lastLatencyMs: 88, lastModel: 'm', lastUsage: null },
    assistEnabled: true,
  }
  const line = memoryStatusLine(data)
  assert.match(line, /1 approved, 1 disabled/)
  assert.match(line, /0 recent events \(cap 20\)/)
  assert.match(line, /AI assistance on/)
  assert.match(line, /model calls 7/)
  assert.match(line, /failures 1/)
  assert.match(line, /last call 88 ms/)
  const quiet: AiMemoryResponse = { ...data, assistEnabled: false, usage: { calls: 0, failures: 0, lastLatencyMs: null, lastModel: '', lastUsage: null } }
  assert.match(memoryStatusLine(quiet), /AI assistance off/)
  assert.ok(!memoryStatusLine(quiet).includes('last call'))
})

test('errorMessage extracts a message from anything thrown', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage('plain'), 'plain')
})
