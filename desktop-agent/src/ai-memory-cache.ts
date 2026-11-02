import fs from "node:fs"
import path from "node:path"

/**
 * Engine-local AI memory cache.
 *
 * Holds a mirror of the server's *approved/disabled* procedures (synced down,
 * never invented locally), recent execution events for crash recovery, and AI
 * usage counters. Authoritative memory lives in PostgreSQL
 * (`ai_memory_procedures`); this file is a safe cache that may be deleted at
 * any time without losing truth. AI suggestions are never auto-promoted here:
 * `upsertProcedure` only stores statuses the server/operator assigned.
 */

export type CachedProcedure = {
  id: string
  marketplace: string
  errorSignature: string
  title: string
  steps: string[]
  status: "approved" | "disabled" | "pending"
  updatedAt: string
}

export type CachedEvent = {
  at: string
  claimId: number
  marketplace: string
  step: string
  outcome: "success" | "failure" | "ai_proposal" | "human_review" | "memory_hit"
  note: string
}

export type LocalAiMemory = {
  version: 1
  procedures: CachedProcedure[]
  events: CachedEvent[]
}

export const LOCAL_MEMORY_FILE = "ai-memory.json"
export const LOCAL_EVENT_CAP = 200
export const LOCAL_EVENT_TTL_MS = 24 * 60 * 60 * 1000

export function emptyLocalMemory(): LocalAiMemory {
  return { version: 1, procedures: [], events: [] }
}

function memoryFilePath(dir: string): string {
  return path.join(dir, LOCAL_MEMORY_FILE)
}

export function loadLocalMemory(dir: string): LocalAiMemory {
  try {
    const raw = fs.readFileSync(memoryFilePath(dir), "utf8")
    const parsed = JSON.parse(raw) as Partial<LocalAiMemory>
    if (!Array.isArray(parsed.procedures) || !Array.isArray(parsed.events)) return emptyLocalMemory()
    return {
      version: 1,
      procedures: parsed.procedures.filter(
        (p): p is CachedProcedure =>
          Boolean(p) && typeof p.id === "string" && Array.isArray(p.steps) && p.steps.length > 0,
      ),
      events: parsed.events.filter(
        (e): e is CachedEvent => Boolean(e) && typeof e.at === "string" && typeof e.step === "string",
      ),
    }
  } catch {
    return emptyLocalMemory()
  }
}

export function saveLocalMemory(dir: string, memory: LocalAiMemory): void {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${memoryFilePath(dir)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(memory))
  fs.renameSync(tmp, memoryFilePath(dir))
}

/** Memory-first lookup for the worker: approved procedures only, never pending. */
export function findApprovedProcedure(
  memory: LocalAiMemory,
  marketplace: string,
  errorSignature: string,
): CachedProcedure | null {
  const market = String(marketplace || "").trim().toLowerCase()
  const signature = String(errorSignature || "").trim().toLowerCase()
  if (!market || !signature) return null
  for (const procedure of memory.procedures) {
    if (procedure.status !== "approved") continue
    if (String(procedure.marketplace || "").trim().toLowerCase() !== market) continue
    if (String(procedure.errorSignature || "").trim().toLowerCase() !== signature) continue
    return procedure
  }
  return null
}

export function upsertCachedProcedure(memory: LocalAiMemory, procedure: CachedProcedure): LocalAiMemory {
  const rest = memory.procedures.filter((p) => p.id !== procedure.id)
  return { ...memory, procedures: [...rest, procedure] }
}

export function recordLocalEvent(memory: LocalAiMemory, event: CachedEvent): LocalAiMemory {
  return { ...memory, events: [...memory.events, event].slice(-LOCAL_EVENT_CAP) }
}

/** Drop events older than 24h (same cache discipline as evidence files). */
export function pruneLocalEvents(memory: LocalAiMemory, nowMs: number): LocalAiMemory {
  return { ...memory, events: memory.events.filter((e) => nowMs - Date.parse(e.at) <= LOCAL_EVENT_TTL_MS) }
}
