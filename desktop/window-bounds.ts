/**
 * Saved window bounds sanity for the desktop shell.
 *
 * Pure logic, deliberately free of Electron imports, so node:test can cover it.
 * The shell persists the main window's bounds across restarts; this module is
 * the trust boundary on restore: untrusted JSON in, a geometry that is always
 * usable out. Two failure modes are handled:
 *
 * - Degenerate sizes (a crashed write, a hand-edited file, an old driver bug
 *   such as the reported 159x27 restore) are clamped up to the window minimum.
 * - A center point that lands on no connected display (a removed second
 *   monitor, a docked-then-undocked laptop) falls back to a centered default
 *   on the primary work area instead of an off-screen window the operator
 *   cannot see or reach.
 */

export type WindowRect = { x: number; y: number; width: number; height: number }

/** The subset of Electron.Display this logic needs. */
export type DisplayWorkArea = { workArea: WindowRect }

export const WINDOW_MIN_WIDTH = 1024
export const WINDOW_MIN_HEIGHT = 680
export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 860

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Parse untrusted persisted JSON into a rect, or null when any field is unusable. */
export function parseSavedBounds(raw: unknown): WindowRect | null {
  if (typeof raw !== "object" || raw === null) return null
  const rec = raw as Record<string, unknown>
  const x = toFiniteNumber(rec.x)
  const y = toFiniteNumber(rec.y)
  const width = toFiniteNumber(rec.width)
  const height = toFiniteNumber(rec.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function rectCenterWithinWorkArea(rect: WindowRect, area: WindowRect): boolean {
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  return centerX >= area.x && centerX <= area.x + area.width && centerY >= area.y && centerY <= area.y + area.height
}

/** The fallback when saved geometry is unusable: the default size, centered on the first display's work area. */
function centeredDefault(displays: DisplayWorkArea[]): WindowRect {
  const area = displays[0]?.workArea ?? { x: 0, y: 0, width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
  const x = Math.max(area.x, area.x + Math.round((area.width - DEFAULT_WINDOW_WIDTH) / 2))
  const y = Math.max(area.y, area.y + Math.round((area.height - DEFAULT_WINDOW_HEIGHT) / 2))
  return { x, y, width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
}

/**
 * Clamp saved bounds into something the shell can open.
 *
 * Sizes below the window minimum are raised to it; if the resulting rect's
 * center is on no connected display's work area, a centered default replaces
 * it entirely. `displays` maps to `screen.getAllDisplays()` at the call site.
 */
export function clampWindowBounds(saved: WindowRect, displays: DisplayWorkArea[]): WindowRect {
  const width = Math.max(WINDOW_MIN_WIDTH, Math.round(saved.width))
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.round(saved.height))
  const clamped: WindowRect = { x: Math.round(saved.x), y: Math.round(saved.y), width, height }
  if (displays.some((display) => rectCenterWithinWorkArea(clamped, display.workArea))) return clamped
  return centeredDefault(displays)
}
