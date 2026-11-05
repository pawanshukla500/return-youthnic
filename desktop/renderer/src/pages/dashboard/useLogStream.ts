import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogStreamEvent } from '../../types/engine'
import { resolveEngineBase } from '../../services/engineApi'

/**
 * Live engine log tail over SSE (GET /api/logs/stream, `{timestamp, level,
 * message}` lines). Keeps the newest `limit` entries, reconnects 5s after an
 * error, and gives up quietly after MAX_RETRIES — the caller renders the
 * `unavailable` status as a note, never a hard failure. The EventSource is
 * always closed on unmount (and before each manual reconnect).
 */

export type LogStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'unavailable'

const MAX_RETRIES = 5
const RETRY_DELAY_MS = 5000

export function useLogStream(limit: number): {
  entries: LogStreamEvent[]
  status: LogStreamStatus
  clear: () => void
} {
  const [entries, setEntries] = useState<LogStreamEvent[]>([])
  const [status, setStatus] = useState<LogStreamStatus>('connecting')
  const limitRef = useRef(limit)

  useEffect(() => {
    limitRef.current = limit
  }, [limit])

  useEffect(() => {
    let cancelled = false
    let source: EventSource | null = null
    let retryTimer: number | undefined
    let retries = 0

    const connect = async () => {
      let base: string
      try {
        base = await resolveEngineBase()
      } catch {
        if (!cancelled) setStatus('unavailable')
        return
      }
      if (cancelled) return

      const nextSource = new EventSource(`${base}/api/logs/stream`)
      source = nextSource

      nextSource.onopen = () => {
        if (cancelled) return
        retries = 0
        setStatus('live')
      }

      nextSource.onmessage = (event) => {
        if (cancelled) return
        try {
          const parsed = JSON.parse(event.data) as LogStreamEvent
          setEntries((previous) => [parsed, ...previous].slice(0, limitRef.current))
        } catch {
          // Ignore malformed lines rather than killing the stream.
        }
      }

      nextSource.onerror = () => {
        if (cancelled) return
        nextSource.close()
        retries += 1
        if (retries >= MAX_RETRIES) {
          setStatus('unavailable')
          return
        }
        setStatus('reconnecting')
        retryTimer = window.setTimeout(() => {
          void connect()
        }, RETRY_DELAY_MS)
      }
    }

    void connect()

    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      source?.close()
    }
  }, [])

  const clear = useCallback(() => setEntries([]), [])

  return { entries, status, clear }
}
