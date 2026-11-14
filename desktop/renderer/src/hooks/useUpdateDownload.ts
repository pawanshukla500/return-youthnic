import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateDownloadProgress } from '../types/global'

/**
 * Shared "download the update installer" flow for the banner (App.tsx) and the
 * Updates page. The main process streams the installer to Downloads and pushes
 * progress over the bridge; this hook owns the busy/success/error state machine
 * so both surfaces behave identically:
 *
 *   idle --click--> downloading --ok--> done --double-click-confirm--> launching
 *                     |                 |
 *                     !ok               !ok (launch refused) -> done + error
 *                     v
 *                   error --Retry--> downloading
 *
 * The "run installer" step is a double-click confirm (first click arms, second
 * click within a short window launches), never window.confirm.
 */

export type UpdateDownloadPhase = 'idle' | 'downloading' | 'done' | 'error' | 'launching'

export type UpdateDownloadState = {
  phase: UpdateDownloadPhase
  progress: UpdateDownloadProgress | null
  fileName: string | null
  savePath: string | null
  error: string | null
  /** True between the first and second click of the run-confirm pattern. */
  runArmed: boolean
}

const RUN_CONFIRM_WINDOW_MS = 5_000

export function formatDownloadedBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

/** "12.3 MB of 127.0 MB (10%)" when the total is known, else an indeterminate "12.3 MB downloaded". */
export function formatDownloadProgress(progress: UpdateDownloadProgress): string {
  const received = formatDownloadedBytes(progress.receivedBytes)
  if (progress.totalBytes && progress.totalBytes > 0) {
    const percent = Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
    return `${received} of ${formatDownloadedBytes(progress.totalBytes)} (${percent}%)`
  }
  return `${received} downloaded`
}

export function useUpdateDownload(): {
  state: UpdateDownloadState
  bridgeAvailable: boolean
  start: (url: string) => void
  retry: (url: string) => void
  requestRun: () => void
} {
  const [bridgeAvailable] = useState(
    () => typeof window !== 'undefined' && Boolean(window.desktopApp?.downloadUpdate && window.desktopApp?.runUpdateInstaller),
  )
  const [state, setState] = useState<UpdateDownloadState>({
    phase: 'idle',
    progress: null,
    fileName: null,
    savePath: null,
    error: null,
    runArmed: false,
  })
  const stateRef = useRef(state)
  const mountedRef = useRef(true)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const disarmTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      if (disarmTimerRef.current !== undefined) window.clearTimeout(disarmTimerRef.current)
    }
  }, [])

  const stopProgress = useCallback(() => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
  }, [])

  const clearDisarmTimer = useCallback(() => {
    if (disarmTimerRef.current !== undefined) {
      window.clearTimeout(disarmTimerRef.current)
      disarmTimerRef.current = undefined
    }
  }, [])

  const start = useCallback(
    (url: string) => {
      if (!bridgeAvailable) return
      stopProgress()
      clearDisarmTimer()
      const next: UpdateDownloadState = { phase: 'downloading', progress: null, fileName: null, savePath: null, error: null, runArmed: false }
      stateRef.current = next
      setState(next)
      unsubscribeRef.current = window.desktopApp?.onDownloadProgress((progress) => {
        if (!mountedRef.current) return
        setState((prev) => ({ ...prev, progress }))
      }) ?? null
      void window.desktopApp
        ?.downloadUpdate(url)
        .then((result) => {
          stopProgress()
          if (!mountedRef.current) return
          const finished: UpdateDownloadState = result.ok
            ? { phase: 'done', progress: null, fileName: result.fileName ?? null, savePath: result.savePath ?? null, error: null, runArmed: false }
            : { phase: 'error', progress: null, fileName: null, savePath: null, error: result.error ?? 'The download failed.', runArmed: false }
          stateRef.current = finished
          setState(finished)
        })
        .catch((cause: unknown) => {
          stopProgress()
          if (!mountedRef.current) return
          const failed: UpdateDownloadState = {
            phase: 'error',
            progress: null,
            fileName: null,
            savePath: null,
            error: cause instanceof Error ? cause.message : String(cause),
            runArmed: false,
          }
          stateRef.current = failed
          setState(failed)
        })
    },
    [bridgeAvailable, stopProgress, clearDisarmTimer],
  )

  const retry = useCallback((url: string) => start(url), [start])

  const requestRun = useCallback(() => {
    const prev = stateRef.current
    if (prev.phase !== 'done' || !prev.savePath) return
    if (!prev.runArmed) {
      // First click: arm the confirm; it disarms itself after a short window.
      clearDisarmTimer()
      disarmTimerRef.current = window.setTimeout(() => {
        disarmTimerRef.current = undefined
        if (!mountedRef.current) return
        setState((current) => (current.phase === 'done' && current.runArmed ? { ...current, runArmed: false } : current))
      }, RUN_CONFIRM_WINDOW_MS)
      const armed: UpdateDownloadState = { ...prev, runArmed: true }
      stateRef.current = armed
      setState(armed)
      return
    }
    // Second click: the app is about to quit; the main process launches the installer.
    clearDisarmTimer()
    const launching: UpdateDownloadState = { ...prev, phase: 'launching', runArmed: false }
    stateRef.current = launching
    setState(launching)
    const { savePath, fileName } = prev
    void window.desktopApp?.runUpdateInstaller(savePath).then((result) => {
      if (!mountedRef.current || result.ok) return
      // The launch was refused (bad path): the app stays open, so show why.
      const restored: UpdateDownloadState = {
        phase: 'done',
        progress: null,
        fileName,
        savePath,
        error: result.error ?? 'The installer could not be launched.',
        runArmed: false,
      }
      stateRef.current = restored
      setState(restored)
    })
  }, [clearDisarmTimer])

  return { state, bridgeAvailable, start, retry, requestRun }
}
