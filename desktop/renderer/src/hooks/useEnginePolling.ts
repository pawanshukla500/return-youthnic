import { useEffect, useRef, useState } from 'react'
import { apiGet, EngineApiError } from '../services/engineApi'

/**
 * Generic engine polling hook. Runs `fn` immediately, then every `ms` while
 * `enabled`, serially (the next tick waits for the previous call). The latest
 * value and the last EngineApiError are returned. Non-EngineApiError throws
 * are treated as transient: they surface as an error and polling continues.
 */
export function useEnginePolling<T>(
  fn: () => Promise<T>,
  ms: number,
  enabled: boolean,
): { data: T | null; error: EngineApiError | null } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<EngineApiError | null>(null)
  const fnRef = useRef(fn)

  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      try {
        const result = await fnRef.current()
        if (cancelled) return
        setData(result)
        setError(null)
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof EngineApiError ? cause : new EngineApiError(0, cause instanceof Error ? cause.message : String(cause)))
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), ms)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [ms, enabled])

  return { data, error }
}
