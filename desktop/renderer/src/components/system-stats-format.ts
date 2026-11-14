import type { SystemStats } from '../types/global'

/** Top-bar pill: app CPU + memory, e.g. "CPU 2.1% · 184 MB". */
export function formatSystemStats(stats: SystemStats): string {
  const cpu = Number.isFinite(stats.app.cpuPercent) ? stats.app.cpuPercent : 0
  return `CPU ${cpu.toFixed(1)}% · ${Math.round(stats.app.memoryMB)} MB`
}

/** Tooltip detail: process count, system RAM share, and PC uptime. */
export function formatSystemStatsTooltip(stats: SystemStats): string {
  const processes = stats.app.processCount
  const totalGb = Math.round(stats.system.totalMemMB / 1024)
  return (
    `Return App total across ${processes} process${processes === 1 ? '' : 'es'} · ` +
    `System RAM: ${stats.system.usedMemPercent}% of ${totalGb} GB used · ` +
    `PC uptime ${formatUptime(stats.system.uptimeSec)}`
  )
}

/** Compact uptime: "3d 4h", "4h 12m", or "9m" (under an hour shows minutes only). */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
