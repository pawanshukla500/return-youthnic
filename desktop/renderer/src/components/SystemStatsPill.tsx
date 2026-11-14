import { useEffect, useState } from 'react'
import type { SystemStats } from '../types/global'
import { formatSystemStats, formatSystemStatsTooltip } from './system-stats-format'

const POLL_MS = 5000

/**
 * Top-bar resource pill: what the app and this PC are using right now.
 * Polls the shell every 5s; renders nothing when the desktop bridge is
 * missing (plain-browser dev) or before the first snapshot arrives.
 */
export default function SystemStatsPill() {
  const [stats, setStats] = useState<SystemStats | null>(null)

  useEffect(() => {
    const getStats = window.desktopApp?.getSystemStats
    if (!getStats) return undefined
    let cancelled = false
    const load = () => {
      getStats()
        .then((next) => {
          if (!cancelled) setStats(next)
        })
        .catch(() => {
          // Keep the last snapshot when the shell is busy; the pill must not flicker.
        })
    }
    load()
    const id = window.setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  if (!stats) return null
  return (
    <span className="whitespace-nowrap text-xs tabular-nums text-muted" title={formatSystemStatsTooltip(stats)}>
      {formatSystemStats(stats)}
    </span>
  )
}
