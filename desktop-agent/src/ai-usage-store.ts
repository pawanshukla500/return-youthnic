/**
 * Durable AI usage ledger (M6).
 *
 * Append-only JSONL at `AGENT_DATA_DIR/ai-usage.jsonl`: one line per model
 * request with provider-reported token counts, latency, and an estimated
 * cost that always carries its pricing provenance. Aggregates support the
 * Usage & Costs dashboard (daily/monthly filtering, cost by
 * provider/model/task). API keys are never written here.
 */

import fs from "node:fs"
import path from "node:path"
import { ensureAgentDataDir } from "./paths.js"
import type { ProviderId } from "./ai-providers.js"

export const USAGE_FILE = "ai-usage.jsonl"

export type UsageRecord = {
  at: string
  provider: ProviderId
  model: string
  task: string
  ok: boolean
  errorCategory: string | null
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  reasoningTokens: number | null
  latencyMs: number
  /** USD estimate, or null when pricing is Unknown. */
  estimatedUsd: number | null
  pricingProvenance: string
}

export function usageFilePath(dir: string): string {
  return path.join(dir, USAGE_FILE)
}

export function recordUsage(dir: string, record: UsageRecord): void {
  ensureAgentDataDir()
  fs.appendFileSync(usageFilePath(dir), `${JSON.stringify(record)}\n`, "utf8")
}

export function readUsage(dir: string, limit = 500): UsageRecord[] {
  let raw = ""
  try {
    raw = fs.readFileSync(usageFilePath(dir), "utf8")
  } catch {
    return []
  }
  const lines = raw.split("\n").filter((l) => l.trim())
  const records: UsageRecord[] = []
  for (const line of lines.slice(Math.max(0, lines.length - limit))) {
    try {
      const parsed = JSON.parse(line) as UsageRecord
      if (parsed && typeof parsed.at === "string" && typeof parsed.provider === "string") records.push(parsed)
    } catch {
      // Skip corrupt lines; the ledger stays readable.
    }
  }
  return records
}

export type UsageSummary = {
  total: number
  successful: number
  failed: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  estimatedUsd: number
  unknownPricing: number
  avgLatencyMs: number | null
  byProvider: Record<string, { calls: number; estimatedUsd: number }>
  byModel: Record<string, { calls: number; estimatedUsd: number }>
  byTask: Record<string, { calls: number; estimatedUsd: number }>
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const summary: UsageSummary = {
    total: records.length,
    successful: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    estimatedUsd: 0,
    unknownPricing: 0,
    avgLatencyMs: null,
    byProvider: {},
    byModel: {},
    byTask: {},
  }
  let latencyTotal = 0
  for (const r of records) {
    if (r.ok) summary.successful += 1
    else summary.failed += 1
    if (typeof r.inputTokens === "number") summary.inputTokens += r.inputTokens
    if (typeof r.outputTokens === "number") summary.outputTokens += r.outputTokens
    if (typeof r.cachedTokens === "number") summary.cachedTokens += r.cachedTokens
    if (typeof r.reasoningTokens === "number") summary.reasoningTokens += r.reasoningTokens
    if (typeof r.estimatedUsd === "number") summary.estimatedUsd += r.estimatedUsd
    else summary.unknownPricing += 1
    latencyTotal += r.latencyMs || 0
    for (const [bucket, key] of [["byProvider", r.provider], ["byModel", r.model], ["byTask", r.task]] as const) {
      const entry = summary[bucket][key] ?? { calls: 0, estimatedUsd: 0 }
      entry.calls += 1
      if (typeof r.estimatedUsd === "number") entry.estimatedUsd += r.estimatedUsd
      summary[bucket][key] = entry
    }
  }
  summary.avgLatencyMs = records.length > 0 ? Math.round(latencyTotal / records.length) : null
  summary.estimatedUsd = Math.round(summary.estimatedUsd * 10000) / 10000
  return summary
}

/** Sum of estimated USD for records in the current calendar month (UTC). */
export function spentThisMonthUsd(records: UsageRecord[], nowMs = Date.now()): number | null {
  const now = new Date(nowMs)
  let total = 0
  let counted = false
  for (const r of records) {
    const at = Date.parse(r.at)
    if (!Number.isFinite(at)) continue
    const d = new Date(at)
    if (d.getUTCFullYear() !== now.getUTCFullYear() || d.getUTCMonth() !== now.getUTCMonth()) continue
    if (typeof r.estimatedUsd === "number") {
      total += r.estimatedUsd
      counted = true
    }
  }
  return counted ? total : null
}
