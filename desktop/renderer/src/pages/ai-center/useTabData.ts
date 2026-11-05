import { useCallback, useEffect, useRef, useState } from 'react'
import { EngineApiError } from '../../services/engineApi'

/**
 * Sub-tab-scoped engine data hook (AI Center). While the panel is `active`
 * (mounted and its sub-tab selected) it fetches immediately, then every
 * `intervalMs` (60s), serially — only the visible sub-tab polls the engine.
 * `refresh()` restarts the cycle right away; mutations call it so their
 * effect shows without waiting for the next tick.
 */
export function useTabData<T>(
  fetcher: () => Promise<T>,
  active: boolean,
  intervalMs = 60_000,
): { data: T | null; error: EngineApiError | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<EngineApiError | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const fetcherRef = useRef(fetcher)

  // Keep the latest fetcher without restarting the loop: the polling effect
  // below must only depend on activity/interval so a changed closure (e.g.
  // new usage date filters) is picked up on the next tick or refresh.
  useEffect(() => {
    fetcherRef.current = fetcher
  }, [fetcher])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      try {
        const result = await fetcherRef.current()
        if (cancelled) return
        setData(result)
        setError(null)
      } catch (cause) {
        if (cancelled) return
        setError(
          cause instanceof EngineApiError
            ? cause
            : new EngineApiError(0, cause instanceof Error ? cause.message : String(cause)),
        )
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), intervalMs)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [active, intervalMs, refreshKey])

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), [])
  return { data, error, refresh }
}
