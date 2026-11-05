/**
 * Pure display helpers for the AI Center page. No JSX, no DOM, no engine
 * imports — everything here is unit-testable under node:test and shared by
 * the five sub-tab panels. Display rules intentionally mirror the old
 * engine-dashboard AI Center script (getDashboardHtml) so the React page
 * reads the same as the dashboard it replaces.
 */

import type { AiMemoryResponse, AiUsageSummary } from '../../types/engine'

/** Localised timestamp in the dashboard's en-IN 24-hour format; '—' when absent. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  try {
    return date.toLocaleString('en-IN', { hour12: false })
  } catch {
    return String(iso)
  }
}

/**
 * Honest money formatting: a missing estimate stays 'Unknown' (the engine
 * never zero-fills unknown pricing). Non-zero values render with up to six
 * decimal places, trailing zeros trimmed.
 */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Unknown'
  if (value === 0) return '$0'
  return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
}

/** Token counts render as-is; a count the provider never reported stays '?'. */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '?'
  return String(value)
}

/** The dashboard truncated with a plain slice and no ellipsis; kept identical. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** Milliseconds → whole-second timeout label for the routing table. */
export function formatTimeoutMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return `${Math.round(ms / 1000)}s`
}

/** Strict YYYY-MM-DD validation: shape plus a real calendar date. */
export function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return false
  return date.toISOString().slice(0, 10) === value
}

/**
 * Validates the two usage date-filter boxes. Empty strings are allowed (no
 * bound); otherwise the value must be a real YYYY-MM-DD date, and the lower
 * bound must not sit after the upper bound. Returns an operator-readable
 * message or null when the pair is usable.
 */
export function validateDateRange(from: string, to: string): string | null {
  if (from && !isValidYmd(from)) return 'From must be a valid date in YYYY-MM-DD form.'
  if (to && !isValidYmd(to)) return 'To must be a valid date in YYYY-MM-DD form.'
  if (from && to && from > to) return 'From must be on or before To.'
  return null
}

export type TextSegment = { t: string; strong?: boolean }

/**
 * Builds the Usage & Costs summary line as segments so the numbers can be
 * bolded without innerHTML. Mirrors the old dashboard line:
 * Requests N (ok X / failed Y) · in A / out B tokens (cached C) (reasoning D)
 * · est. cost $E (F without pricing) · avg latency G ms.
 */
export function usageSummarySegments(summary: AiUsageSummary): TextSegment[] {
  const parts: TextSegment[] = [
    { t: 'Requests ' },
    { t: String(summary.total), strong: true },
    { t: ` (ok ${summary.successful} / failed ${summary.failed}) · in ${summary.inputTokens} / out ${summary.outputTokens} tokens` },
  ]
  if (summary.cachedTokens) parts.push({ t: ` (cached ${summary.cachedTokens})` })
  if (summary.reasoningTokens) parts.push({ t: ` (reasoning ${summary.reasoningTokens})` })
  parts.push({ t: ' · est. cost ' }, { t: formatUsd(summary.estimatedUsd), strong: true })
  if (summary.unknownPricing) parts.push({ t: ` (${summary.unknownPricing} without pricing)` })
  parts.push(
    { t: ' · avg latency ' },
    { t: summary.avgLatencyMs == null ? '—' : `${summary.avgLatencyMs} ms`, strong: summary.avgLatencyMs != null },
  )
  return parts
}

export type MemoryStatusMeta = { label: string; dotClass: string; textClass: string }

/** Status dot colours from the old Approved AI memory panel. */
export function memoryStatusMeta(status: string): MemoryStatusMeta {
  switch (status) {
    case 'approved':
      return { label: 'approved', dotClass: 'bg-green', textClass: 'text-green-dark' }
    case 'pending':
      return { label: 'pending', dotClass: 'bg-orange', textClass: 'text-orange' }
    case 'disabled':
      return { label: 'disabled', dotClass: 'bg-muted', textClass: 'text-muted' }
    default:
      return { label: status || 'unknown', dotClass: 'bg-muted', textClass: 'text-muted' }
  }
}

/**
 * The Learning & Memory status line: local-mirror counts, recent-event cap,
 * AI assistance switch and the metadata-only usage ledger — the old
 * dashboard's memory line plus its AI-usage line merged into one sentence.
 */
export function memoryStatusLine(data: AiMemoryResponse): string {
  const approved = data.procedures.filter((p) => p.status === 'approved').length
  const disabled = data.procedures.filter((p) => p.status === 'disabled').length
  const parts = [
    `Local mirror: ${approved} approved, ${disabled} disabled`,
    `${data.events.length} recent events (cap ${data.recentEventCap})`,
    `AI assistance ${data.assistEnabled ? 'on' : 'off'}`,
    `model calls ${data.usage.calls}`,
    `failures ${data.usage.failures}`,
  ]
  if (data.usage.lastLatencyMs != null) parts.push(`last call ${data.usage.lastLatencyMs} ms`)
  return parts.join(' · ')
}

/** Error text for inline alerts; EngineApiError already folds the body in. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
