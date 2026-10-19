import { profileDirFor, readSessionSavedAt } from "./portal-login.js"

/**
 * Panel-wise continuous claim queue.
 *
 * Each marketplace panel (Meesho, Flipkart, Amazon, Myntra VB, Myntra EJ, Ajio)
 * keeps its own isolated browser profile, its own login cookies, and its own
 * runtime state. The worker polls panels round-robin so one slow/stuck panel
 * never blocks the others — filing continues panel-wise without stopping.
 */

export const CLAIM_PANELS = [
  { key: "meesho", name: "Meesho", portalUrl: "https://supplier.meesho.com/panel/v3/new/root/login", automated: true },
  { key: "flipkart", name: "Flipkart", portalUrl: "https://seller.flipkart.com/index.html#dashboard/returns-v2", automated: false },
  { key: "amazon", name: "Amazon", portalUrl: "https://sellercentral.amazon.in/", automated: false },
  { key: "myntra_vb", name: "Myntra VB", portalUrl: "https://partners.myntra.com/returns", automated: false },
  { key: "myntra_ej", name: "Myntra EJ", portalUrl: "https://partners.myntra.com/returns", automated: false },
  { key: "ajio", name: "Ajio", portalUrl: "https://supplier.ajio.com/returns", automated: false },
] as const

export type ClaimPanelKey = (typeof CLAIM_PANELS)[number]["key"]

export type PanelRuntimeState =
  | "idle"
  | "preparing"
  | "submitting"
  | "manual_action"
  | "cooldown"
  | "disabled"

export type PanelStatus = {
  key: string
  name: string
  portalUrl: string
  automated: boolean
  profileDir: string
  sessionSavedAt: string | null
  state: PanelRuntimeState
  activeJobId: number | null
  consecutiveErrors: number
  lastResult: string | null
  lastResultAt: string | null
}

const runtime = new Map<string, { state: PanelRuntimeState; activeJobId: number | null; consecutiveErrors: number; lastResult: string | null; lastResultAt: string | null }>()

function runtimeFor(key: string) {
  let r = runtime.get(key)
  if (!r) {
    r = { state: "idle", activeJobId: null, consecutiveErrors: 0, lastResult: null, lastResultAt: null }
    runtime.set(key, r)
  }
  return r
}

/** Mark a panel busy with a job. Called when the worker leases a job for that panel. */
export function markPanelBusy(panelKey: string, jobId: number, stage: string): void {
  const r = runtimeFor(panelKey)
  r.activeJobId = jobId
  r.state = stage === "submitting" ? "submitting" : "preparing"
}

/** Record the outcome of a finished job so the dashboard shows per-panel progress. */
export function markPanelResult(panelKey: string, outcome: "completed" | "prepared" | "manual_action" | "not_eligible" | "failed", detail?: string): void {
  const r = runtimeFor(panelKey)
  r.activeJobId = null
  r.lastResultAt = new Date().toISOString()
  if (outcome === "completed" || outcome === "prepared" || outcome === "not_eligible") {
    r.consecutiveErrors = 0
    r.state = "idle"
    r.lastResult = detail || outcome
  } else if (outcome === "manual_action") {
    r.consecutiveErrors = 0
    r.state = "manual_action"
    r.lastResult = detail || "Waiting for operator in the supplier browser."
  } else {
    r.consecutiveErrors += 1
    // After 3 straight failures the panel cools down so a broken portal
    // layout does not spin the worker forever; other panels keep filing.
    r.state = r.consecutiveErrors >= 3 ? "cooldown" : "idle"
    r.lastResult = detail || "failed"
  }
}

/** Operator resolved the manual step — the panel rejoins the rotation. */
export function clearPanelHold(panelKey: string): void {
  const r = runtimeFor(panelKey)
  if (r.state === "manual_action" || r.state === "cooldown") r.state = "idle"
  r.activeJobId = null
}

/** Normalize a marketplace/account label from a job to a panel key. */
export function panelKeyForMarketplace(marketplace: string): string {
  const norm = (marketplace || "").toLowerCase()
  if (norm.includes("myntra") && norm.includes("ej")) return "myntra_ej"
  if (norm.includes("myntra")) return "myntra_vb"
  if (norm.includes("meesho")) return "meesho"
  if (norm.includes("flipkart")) return "flipkart"
  if (norm.includes("amazon")) return "amazon"
  if (norm.includes("ajio")) return "ajio"
  return norm.replace(/[^a-z0-9]/g, "_") || "unknown"
}

/**
 * Round-robin order for the next poll cycle. Busy, held, cooling-down, and
 * unknown panels are skipped so filing continues on the panels that are
 * ready. The cursor rotates so every ready panel gets its turn.
 */
let cursor = 0

export function nextReadyPanels(count = 6): string[] {
  const ready = CLAIM_PANELS.filter((p) => {
    const r = runtimeFor(p.key)
    return r.state === "idle"
  }).map((p) => p.key)
  if (ready.length === 0) return []
  const out: string[] = []
  for (let i = 0; i < ready.length && out.length < count; i++) {
    out.push(ready[(cursor + i) % ready.length])
  }
  cursor = (cursor + 1) % ready.length
  return out
}

/** Full per-panel status for GET /api/panels (dashboard + tray). */
export function getPanelStatuses(userDataDir: string): PanelStatus[] {
  return CLAIM_PANELS.map((p) => {
    const r = runtimeFor(p.key)
    const profileDir = profileDirFor(userDataDir, p.name)
    let sessionSavedAt: string | null = null
    try {
      sessionSavedAt = readSessionSavedAt(profileDir)
    } catch {
      sessionSavedAt = null
    }
    return {
      key: p.key,
      name: p.name,
      portalUrl: p.portalUrl,
      automated: p.automated,
      profileDir,
      sessionSavedAt,
      state: r.state,
      activeJobId: r.activeJobId,
      consecutiveErrors: r.consecutiveErrors,
      lastResult: r.lastResult,
      lastResultAt: r.lastResultAt,
    }
  })
}

/** Reset in-memory runtime (tests only). */
export function resetPanelRuntime(): void {
  runtime.clear()
  cursor = 0
}
