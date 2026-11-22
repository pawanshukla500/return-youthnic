import { resolveBrowserAdapterKind } from "./browser-adapter.js"
import { profileDirFor, readSessionSavedAt, supplierSessionDir } from "./supplier-session.js"

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
  | "prepared"
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
  reloginRequired: boolean
  activeJobId: number | null
  consecutiveErrors: number
  lastResult: string | null
  lastResultAt: string | null
}

/** How long a panel cools down after 3 straight failures before it takes queued jobs again. */
export const PANEL_COOLDOWN_MS = 30 * 60_000

const runtime = new Map<string, { state: PanelRuntimeState; reloginRequired: boolean; activeJobId: number | null; consecutiveErrors: number; cooldownUntil: number; lastResult: string | null; lastResultAt: string | null }>()

function runtimeFor(key: string) {
  let r = runtime.get(key)
  if (!r) {
    r = { state: "idle", reloginRequired: false, activeJobId: null, consecutiveErrors: 0, cooldownUntil: 0, lastResult: null, lastResultAt: null }
    runtime.set(key, r)
  }
  // A cooled-down panel's queued jobs are skipped when polling, so no success
  // can end the cooldown: it ends on its own. The error count stays, so the
  // next job is a single probe: a success resets it, a failure cools again.
  if (r.state === "cooldown" && Date.now() >= r.cooldownUntil) r.state = "idle"
  return r
}

/** Mark a panel busy with a job. Called when the worker leases a job for that panel. */
export function markPanelBusy(panelKey: string, jobId: number, stage: string): void {
  const r = runtimeFor(panelKey)
  r.activeJobId = jobId
  r.reloginRequired = false
  r.state = stage === "submitting" ? "submitting" : "preparing"
}

/** Record the outcome of a finished job so the dashboard shows per-panel progress. */
export function markPanelResult(
  panelKey: string,
  outcome: "completed" | "prepared" | "manual_action" | "not_eligible" | "claim_manual" | "failed",
  detail?: string,
  options?: { loginRequired?: boolean },
): void {
  const r = runtimeFor(panelKey)
  r.activeJobId = null
  r.lastResultAt = new Date().toISOString()
  if (outcome === "completed" || outcome === "not_eligible" || outcome === "claim_manual") {
    r.consecutiveErrors = 0
    r.reloginRequired = false
    r.state = "idle"
    r.lastResult = detail || outcome
  } else if (outcome === "prepared") {
    r.consecutiveErrors = 0
    r.reloginRequired = false
    // Prepared claims wait for operator review and approval on this specific
    // panel without blocking other panels from filing round-robin.
    r.state = "prepared"
    r.lastResult = detail || "Prepared on the supplier panel. Waiting for approval."
  } else if (outcome === "manual_action") {
    r.consecutiveErrors = 0
    r.reloginRequired = Boolean(options?.loginRequired)
    r.state = "manual_action"
    r.lastResult = detail || "Waiting for operator in the supplier browser."
  } else {
    r.consecutiveErrors += 1
    r.reloginRequired = false
    // After 3 straight failures the panel cools down for PANEL_COOLDOWN_MS so a
    // broken portal layout does not spin the worker or spend every queued job's
    // attempts; other panels keep filing.
    if (r.consecutiveErrors >= 3) {
      r.state = "cooldown"
      r.cooldownUntil = Date.now() + PANEL_COOLDOWN_MS
    } else {
      r.state = "idle"
    }
    r.lastResult = detail || "failed"
  }
}

/** Operator resolved the manual step or approved/cleared the claim — the panel rejoins the rotation. */
export function clearPanelHold(panelKey: string): void {
  const r = runtimeFor(panelKey)
  if (r.state === "manual_action" || r.state === "cooldown" || r.state === "prepared") {
    r.state = "idle"
    // Rejoin starts the count again, or one more failure would cool the panel down at once.
    r.consecutiveErrors = 0
  }
  r.reloginRequired = false
  r.activeJobId = null
}

export function isPanelWaitingRelogin(panelKey: string): boolean {
  const r = runtimeFor(panelKey)
  return r.state === "manual_action" && r.reloginRequired
}

/** True when the panel is held waiting for operator action or approval. */
export function isPanelHeld(panelKey: string): boolean {
  const r = runtimeFor(panelKey)
  return r.state === "prepared" || r.state === "manual_action"
}

/**
 * Marketplace names whose panel must not take a new filing job: held for the
 * operator (prepared, manual_action) or cooling down after repeated failures
 * (for PANEL_COOLDOWN_MS, or until Rejoin rotation).
 * Sent with every job poll so the server leaves those queued jobs alone instead
 * of leasing one (and spending one of its attempts) that the engine would drop.
 */
export function marketplacesToSkip(): string[] {
  return CLAIM_PANELS.filter((p) => {
    const state = runtimeFor(p.key).state
    return state === "prepared" || state === "manual_action" || state === "cooldown"
  }).map((p) => p.name)
}

/** The engine's job poll: asks the backend for work, skipping held and cooling-down panels. */
export function pollJobSkippingHeldPanels<T>(client: { pollJob(skipMarketplaces: readonly string[]): Promise<T> }): Promise<T> {
  return client.pollJob(marketplacesToSkip())
}

/** Current runtime state for a panel. */
export function getPanelRuntimeState(panelKey: string): PanelRuntimeState {
  return runtimeFor(panelKey).state
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
    const sessionDir = supplierSessionDir(userDataDir, p.name, resolveBrowserAdapterKind())
    let sessionSavedAt: string | null = null
    try {
      sessionSavedAt = readSessionSavedAt(sessionDir)
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
      reloginRequired: r.state === "manual_action" && r.reloginRequired,
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
