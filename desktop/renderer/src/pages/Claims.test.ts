import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  evidenceFileKind,
  filterJobs,
  formatBytes,
  jobBucket,
  normalizeEvidenceList,
} from './Claims'
import type { JobRow } from '../types/engine'

function job(partial: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    claimId: 10,
    marketplace: 'Meesho',
    accountName: 'SYN-Account',
    orderNumber: 'ORD-1',
    trackingId: 'AWB-1',
    marketplaceClaimId: '',
    stage: 'queued',
    manualActionReason: null,
    claimReason: null,
    claimTitle: null,
    updatedAt: '2026-11-04T00:00:00.000Z',
    attempts: 0,
    maxAttempts: 3,
    logs: [],
    ...partial,
  }
}

test('jobBucket maps every pipeline stage', () => {
  assert.equal(jobBucket('queued'), 'queued')
  for (const stage of ['downloading_media', 'opening_portal', 'filling_form', 'submitting']) {
    assert.equal(jobBucket(stage), 'processing', stage)
  }
  assert.equal(jobBucket('completed'), 'completed')
  for (const stage of ['manual_intervention_required', 'failed', 'prepared', 'some_future_stage']) {
    assert.equal(jobBucket(stage), 'action', stage)
  }
})

test('filterJobs returns all rows for a blank query', () => {
  const rows = [job({ id: 1 }), job({ id: 2 })]
  assert.equal(filterJobs(rows, '').length, 2)
  assert.equal(filterJobs(rows, '   ').length, 2)
})

test('filterJobs matches orderNumber, trackingId, marketplaceClaimId and marketplace', () => {
  const rows = [
    job({ id: 1, orderNumber: 'ORD-900', trackingId: 'AWB-100', marketplaceClaimId: 'CLM-77', marketplace: 'Meesho' }),
    job({ id: 2, orderNumber: 'ORD-901', trackingId: 'XWB-200', marketplaceClaimId: 'TKT-88', marketplace: 'Flipkart' }),
  ]
  assert.deepEqual(filterJobs(rows, 'ord-900').map((r) => r.id), [1])
  assert.deepEqual(filterJobs(rows, 'xwb-200').map((r) => r.id), [2])
  assert.deepEqual(filterJobs(rows, 'tkt-88').map((r) => r.id), [2])
  assert.deepEqual(filterJobs(rows, 'FLIPKART').map((r) => r.id), [2])
  assert.deepEqual(filterJobs(rows, 'nothing-matches'), [])
})

test('filterJobs trims the query', () => {
  const rows = [job({ orderNumber: 'ORD-42' })]
  assert.equal(filterJobs(rows, '  ord-42  ').length, 1)
})

test('filterJobs tolerates missing string fields', () => {
  const rows = [job({ orderNumber: '', trackingId: '', marketplaceClaimId: '', marketplace: '' })]
  assert.equal(filterJobs(rows, 'anything').length, 0)
  assert.equal(filterJobs(rows, '').length, 1)
})

test('normalizeEvidenceList reads the engine disk shape', () => {
  const payload = {
    claimId: '7',
    files: [{ name: 'a.png', sizeBytes: 128, mtimeIso: '2026-11-04T01:02:03.000Z' }],
  }
  assert.deepEqual(normalizeEvidenceList(payload), [
    { name: 'a.png', sizeBytes: 128, mtimeIso: '2026-11-04T01:02:03.000Z' },
  ])
})

test('normalizeEvidenceList reads the declared EvidenceFile shape too', () => {
  const payload = {
    claimId: 7,
    files: [
      {
        fileName: 'b.mp4',
        sizeBytes: 2048,
        mimeType: 'video/mp4',
        downloadedAt: '2026-11-03T10:00:00.000Z',
      },
    ],
  }
  assert.deepEqual(normalizeEvidenceList(payload), [
    { name: 'b.mp4', sizeBytes: 2048, mtimeIso: '2026-11-03T10:00:00.000Z' },
  ])
})

test('normalizeEvidenceList rejects malformed payloads and entries', () => {
  assert.deepEqual(normalizeEvidenceList(null), [])
  assert.deepEqual(normalizeEvidenceList('nope'), [])
  assert.deepEqual(normalizeEvidenceList({ files: 'nope' }), [])
  assert.deepEqual(
    normalizeEvidenceList({ files: [null, 42, { sizeBytes: 1 }, { name: 'ok.jpg', sizeBytes: 'x' }] }),
    [{ name: 'ok.jpg', sizeBytes: 0, mtimeIso: null }],
  )
})

test('evidenceFileKind classifies previewable and other files', () => {
  for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp']) {
    assert.equal(evidenceFileKind(name), 'image', name)
  }
  assert.equal(evidenceFileKind('clip.mp4'), 'video')
  assert.equal(evidenceFileKind('clip.WEBM'), 'video')
  assert.equal(evidenceFileKind('notes.pdf'), 'other')
  // The server filters .part files before listing; if one ever arrives it
  // must not be treated as a finished video/image.
  assert.equal(evidenceFileKind('clip.mp4.part'), 'other')
  assert.equal(evidenceFileKind('noextension'), 'other')
})

test('formatBytes renders human sizes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(-5), '0 B')
  assert.equal(formatBytes(Number.NaN), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})
