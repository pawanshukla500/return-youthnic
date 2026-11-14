import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SystemStats } from '../types/global'
import { formatSystemStats, formatSystemStatsTooltip, formatUptime } from './system-stats-format'

function stats(partial: Partial<SystemStats> = {}): SystemStats {
  return {
    app: { cpuPercent: 2.14, memoryMB: 184.4, processCount: 3 },
    system: { totalMemMB: 16384, usedMemMB: 9984, usedMemPercent: 61, uptimeSec: 273600 },
    ...partial,
  }
}

test('formatSystemStats renders one-decimal CPU and whole MB', () => {
  assert.equal(formatSystemStats(stats()), 'CPU 2.1% · 184 MB')
  assert.equal(formatSystemStats(stats({ app: { cpuPercent: 0, memoryMB: 0.4, processCount: 1 } })), 'CPU 0.0% · 0 MB')
  assert.equal(
    formatSystemStats(stats({ app: { cpuPercent: 12.05, memoryMB: 1024, processCount: 2 } })),
    'CPU 12.1% · 1024 MB',
  )
})

test('formatSystemStatsTooltip mirrors process count, RAM share and uptime', () => {
  assert.equal(
    formatSystemStatsTooltip(stats()),
    'Return App total across 3 processes · System RAM: 61% of 16 GB used · PC uptime 3d 4h',
  )
  assert.equal(
    formatSystemStatsTooltip(stats({ app: { cpuPercent: 1, memoryMB: 50, processCount: 1 }, system: { totalMemMB: 4096, usedMemMB: 2048, usedMemPercent: 50, uptimeSec: 0 } })),
    'Return App total across 1 process · System RAM: 50% of 4 GB used · PC uptime 0m',
  )
})

test('formatUptime renders days/hours/minutes compactly', () => {
  assert.equal(formatUptime(273600), '3d 4h') // 3*86400 + 4*3600
  assert.equal(formatUptime(0), '0m')
  assert.equal(formatUptime(3600 + 12 * 60), '1h 12m')
  assert.equal(formatUptime(59), '0m')
  assert.equal(formatUptime(Number.NaN), '0m')
})
