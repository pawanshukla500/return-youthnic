import { useCallback, useEffect, useState } from 'react'
import type { StatusSnapshot } from '../types/engine'
import { apiGet, EngineApiError, isSessionError } from '../services/engineApi'

/**
 * Polls GET /api/status every `intervalMs` (default 2000ms). Bumping
 * `refreshKey` (via `refresh()`) restarts the poll immediately — use it after
 * actions that change the worker state instead of waiting for the next tick.
 */
export function useEngineStatus(intervalMs = 2000): {
  status: StatusSnapshot | null
  error: EngineApiError | null
  refreshKey: number
  refresh: () => void
} {
  const [status, setStatus] = useState<StatusSnapshot | null>(null)
  const [error, setError] = useState<EngineApiError | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      try {
        const snapshot = await apiGet<StatusSnapshot>('/api/status')
        if (cancelled) return
        setStatus(snapshot)
        setError(null)
      } catch (cause) {
        if (cancelled) return
        const apiError =
          cause instanceof EngineApiError
            ? cause
            : new EngineApiError(0, cause instanceof Error ? cause.message : String(cause))
        // A 401 from /api/status means the engine session ended: surface it so
        // the shell can drop back to the login gate.
        if (isSessionError(apiError)) setStatus(null)
        setError(apiError)
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), intervalMs)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [intervalMs, refreshKey])

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), [])

  return { status, error, refreshKey, refresh }
}
