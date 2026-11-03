/**
 * AI Center local state (M6) — additive alongside `ai-memory.json`.
 *
 * Preserves the existing `ai-memory.json` format exactly; new files:
 * - `ai-routing.json` — per-task model routing + budgets (operator prefs).
 * - `ai-activity.jsonl` — agent execution ledger (start/end, memory vs model,
 *   result, fallback, human-approval state). Survives restarts; unfinished
 *   entries (started, no end) are reported as `interrupted` after a restart.
 * - `ai-pending-sync.json` — pending sync records queued for Postgres/RTDB.
 */

import fs from "node:fs"
import path from "node:path"
import { ensureAgentDataDir } from "./paths.js"
import { defaultRouting, normalizeRouting, type RoutingConfig } from "./ai-routing.js"

export const ROUTING_FILE = "ai-routing.json"
export const ACTIVITY_FILE = "ai-activity.jsonl"
export const PENDING_SYNC_FILE = "ai-pending-sync.json"

export type ActivityEntry = {
  id: string
  at: string
  endAt: string | null
  claimId: number
  marketplace: string
  agentFunction: string
  provider: string
  model: string
  stage: string
  memoryHit: boolean
  result: string
  errorCategory: string | null
  fallback: boolean
  approval: "none-required" | "pending" | "approved" | "rejected"
}

export function loadRoutingConfig(dir: string): RoutingConfig {
  try {
    const raw = fs.readFileSync(path.join(dir, ROUTING_FILE), "utf8")
    return normalizeRouting(JSON.parse(raw))
  } catch {
    return { ...defaultRouting(), updatedAt: new Date().toISOString() }
  }
}

export function saveRoutingConfig(dir: string, config: unknown): RoutingConfig {
  const normalized = normalizeRouting(config)
  ensureAgentDataDir()
  const file = path.join(dir, ROUTING_FILE)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(normalized))
  fs.renameSync(tmp, file)
  return normalized
}

export function appendActivity(dir: string, entry: ActivityEntry): void {
  ensureAgentDataDir()
  fs.appendFileSync(path.join(dir, ACTIVITY_FILE), `${JSON.stringify(entry)}\n`, "utf8")
}

export function readActivity(dir: string, limit = 100): ActivityEntry[] {
  let raw = ""
  try {
    raw = fs.readFileSync(path.join(dir, ACTIVITY_FILE), "utf8")
  } catch {
    return []
  }
  const out: ActivityEntry[] = []
  for (const line of raw.split("\n").filter((l) => l.trim())) {
    try {
      const parsed = JSON.parse(line) as ActivityEntry
      if (parsed && typeof parsed.id === "string") out.push(parsed)
    } catch {
      // skip corrupt lines
    }
  }
  return out.slice(Math.max(0, out.length - limit)).reverse()
}

/** Mark entries that started but never ended (crash/restart) as interrupted. */
export function recoverInterruptedActivity(dir: string): number {
  const file = path.join(dir, ACTIVITY_FILE)
  let raw = ""
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return 0
  }
  const lines = raw.split("\n").filter((l) => l.trim())
  let changed = 0
  const next = lines.map((line) => {
    try {
      const parsed = JSON.parse(line) as ActivityEntry
      if (parsed && !parsed.endAt && parsed.stage !== "interrupted") {
        changed += 1
        return JSON.stringify({ ...parsed, endAt: new Date().toISOString(), stage: "interrupted", result: "Interrupted by application restart; safe to retry." })
      }
    } catch {
      // keep line as-is
    }
    return line
  })
  if (changed > 0) fs.writeFileSync(file, `${next.join("\n")}\n`, "utf8")
  return changed
}

export type PendingSync = { queuedAt: string; kind: string; ref: string }[]

export function readPendingSync(dir: string): PendingSync {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, PENDING_SYNC_FILE), "utf8")) as PendingSync
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function queuePendingSync(dir: string, kind: string, ref: string): void {
  ensureAgentDataDir()
  const pending = readPendingSync(dir)
  pending.push({ queuedAt: new Date().toISOString(), kind: String(kind).slice(0, 40), ref: String(ref).slice(0, 80) })
  fs.writeFileSync(path.join(dir, PENDING_SYNC_FILE), JSON.stringify(pending.slice(-200)))
}
