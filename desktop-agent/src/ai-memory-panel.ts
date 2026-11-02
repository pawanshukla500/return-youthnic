import { escapeHtml } from "./html-escape.js"
import type { CachedEvent, CachedProcedure, LocalAiMemory } from "./ai-memory-cache.js"
import type { AiUsageSnapshot } from "./ai-assistant.js"

/**
 * Engine-dashboard surface for the local AI memory cache (Milestone 2).
 *
 * Read path: `buildAiMemoryPayload` shapes the cache for `GET
 * /api/v1/ai-memory` (procedures with their status, the newest events, and the
 * metadata-only AI usage ledger). Titles and signatures are HTML-escaped here
 * so the dashboard can inject them without a second pass.
 *
 * Safety path: `disableLocalProcedure` flips one cached procedure to
 * `disabled`. It is a local kill-switch only — authoritative approvals live
 * in PostgreSQL and are synced down by a later milestone; disabling here
 * stops the worker from reusing a bad procedure on this PC immediately.
 */

export type AiMemoryPayloadProcedure = {
  id: string
  marketplace: string
  errorSignature: string
  title: string
  steps: string[]
  status: string
  updatedAt: string
}

export type AiMemoryPayload = {
  procedures: AiMemoryPayloadProcedure[]
  events: CachedEvent[]
  recentEventCap: number
  usage: AiUsageSnapshot
  assistEnabled: boolean
}

export const PAYLOAD_EVENT_CAP = 20

export function buildAiMemoryPayload(
  memory: LocalAiMemory,
  usage: AiUsageSnapshot,
  assistEnabled: boolean,
): AiMemoryPayload {
  return {
    procedures: memory.procedures.map((p: CachedProcedure) => ({
      id: p.id,
      marketplace: escapeHtml(String(p.marketplace || "")),
      errorSignature: escapeHtml(String(p.errorSignature || "")),
      title: escapeHtml(String(p.title || "")),
      steps: p.steps.map((s) => escapeHtml(String(s || ""))),
      status: p.status,
      updatedAt: p.updatedAt,
    })),
    events: memory.events.slice(-PAYLOAD_EVENT_CAP),
    recentEventCap: PAYLOAD_EVENT_CAP,
    usage: { ...usage },
    assistEnabled,
  }
}

export function disableLocalProcedure(
  memory: LocalAiMemory,
  id: string,
): { memory: LocalAiMemory; found: boolean; changed: boolean } {
  const key = String(id || "").trim()
  if (!key) return { memory, found: false, changed: false }
  let found = false
  let changed = false
  const procedures = memory.procedures.map((p) => {
    if (p.id !== key) return p
    found = true
    if (p.status === "disabled") return p
    changed = true
    return { ...p, status: "disabled" as const }
  })
  return { memory: { ...memory, procedures }, found, changed }
}
