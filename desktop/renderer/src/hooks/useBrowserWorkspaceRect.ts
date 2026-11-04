import { useEffect, type RefObject } from 'react'
import type { BrowserWorkspaceRect } from '../types/global'

const REPORT_THROTTLE_MS = 100

/**
 * Reports the placeholder div's bounding rect (device-independent pixels) to
 * the Electron shell so the native supplier WebContentsView fills exactly that
 * area and never covers the sidebar or toolbar. Replaces the old dashboard's
 * reportBrowserWorkspace semantics.
 *
 * - Observes the element with ResizeObserver plus window resize/scroll,
 *   throttled to ~100ms.
 * - Sends `null` whenever `active` is false or the element unmounts, so the
 *   native view hides instead of defaulting to full-window.
 * - No-ops in a plain browser (the bridge is absent).
 */
export function useBrowserWorkspaceRect(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const bridge = window.desktopApp
    if (!bridge?.setBrowserWorkspaceRect) return

    if (!active) {
      bridge.setBrowserWorkspaceRect(null)
      return
    }

    const el = ref.current
    if (!el) {
      bridge.setBrowserWorkspaceRect(null)
      return
    }

    let throttleTimer: number | undefined
    let lastRect: BrowserWorkspaceRect | null = null

    const report = () => {
      const rect = el.getBoundingClientRect()
      const next: BrowserWorkspaceRect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
      if (
        lastRect &&
        next.x === lastRect.x &&
        next.y === lastRect.y &&
        next.width === lastRect.width &&
        next.height === lastRect.height
      ) {
        return
      }
      lastRect = next
      bridge.setBrowserWorkspaceRect(next)
    }

    const schedule = () => {
      if (throttleTimer !== undefined) return
      throttleTimer = window.setTimeout(() => {
        throttleTimer = undefined
        report()
      }, REPORT_THROTTLE_MS)
    }

    report()

    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (throttleTimer !== undefined) window.clearTimeout(throttleTimer)
      bridge.setBrowserWorkspaceRect(null)
    }
  }, [ref, active])
}
