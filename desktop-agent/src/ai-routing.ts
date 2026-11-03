/**
 * AI Center model routing (M6).
 *
 * One configured provider is enough: automatic cost-aware routing picks the
 * cheapest healthy provider for a task; the operator may pin primary/fallback
 * models per task. Escalation to a stronger model happens only inside the
 * operator's spending budget and data-sharing policy.
 *
 * Reasoning settings follow the selected provider's catalog entry: effort
 * params are attached only when the model advertises reasoning support
 * (enforced in ai-providers.ts) — never silently passed through.
 */

import type { ProviderId } from "./ai-providers.js"

export const AI_TASKS = [
  "worker_diagnosis",
  "rejection_analysis",
  "response_drafting",
  "status_interpretation",
  "report_analysis",
  "complex_reasoning",
] as const

export type AiTaskKind = (typeof AI_TASKS)[number]

export const AI_TASK_LABELS: Record<AiTaskKind, string> = {
  worker_diagnosis: "Worker error diagnosis",
  rejection_analysis: "Claim rejection analysis",
  response_drafting: "Claim response drafting",
  status_interpretation: "Marketplace status interpretation",
  report_analysis: "Report analysis",
  complex_reasoning: "Complex problem-solving",
}

export type TaskRoute = {
  mode: "auto" | "manual"
  primary: { provider: ProviderId; model: string }
  fallback: { provider: ProviderId; model: string } | null
  reasoningEffort?: string
  maxTokens?: number
  maxCalls?: number
  timeoutMs?: number
}

export type RoutingConfig = {
  version: 1
  auto: boolean
  monthlyBudgetUsd: number | null
  defaultTimeoutMs: number
  tasks: Record<AiTaskKind, TaskRoute>
  updatedAt: string
}

export const LOW_COST_DEFAULT: { provider: ProviderId; model: string } = { provider: "openai", model: "gpt-4o-mini" }
export const STRONG_DEFAULT: { provider: ProviderId; model: string } = { provider: "anthropic", model: "claude-3-5-sonnet-20241022" }

export function defaultRouting(): RoutingConfig {
  const tasks = {} as Record<AiTaskKind, TaskRoute>
  for (const task of AI_TASKS) {
    const strong = task === "complex_reasoning" || task === "rejection_analysis" || task === "response_drafting"
    tasks[task] = {
      mode: "auto",
      primary: strong ? { ...STRONG_DEFAULT } : { ...LOW_COST_DEFAULT },
      fallback: strong ? { ...LOW_COST_DEFAULT } : null,
      maxTokens: 400,
      maxCalls: 2,
      timeoutMs: 20000,
    }
  }
  return { version: 1, auto: true, monthlyBudgetUsd: null, defaultTimeoutMs: 20000, tasks, updatedAt: new Date(0).toISOString() }
}

export function normalizeRouting(raw: unknown): RoutingConfig {
  const fallback = defaultRouting()
  if (!raw || typeof raw !== "object") return { ...fallback, updatedAt: new Date().toISOString() }
  const input = raw as Partial<RoutingConfig>
  const tasks = { ...fallback.tasks }
  if (input.tasks && typeof input.tasks === "object") {
    for (const task of AI_TASKS) {
      const t = (input.tasks as Record<string, unknown>)[task] as Partial<TaskRoute> | undefined
      if (t && typeof t === "object" && t.primary && typeof t.primary === "object") {
        const primary = t.primary as { provider?: unknown; model?: unknown }
        if (typeof primary.provider === "string" && typeof primary.model === "string" && primary.model.trim()) {
          tasks[task] = {
            mode: t.mode === "manual" ? "manual" : "auto",
            primary: { provider: primary.provider as ProviderId, model: primary.model.trim() },
            fallback:
              t.fallback && typeof t.fallback === "object" && typeof (t.fallback as { model?: unknown }).model === "string" && ((t.fallback as { model: string }).model as string).trim()
                ? { provider: ((t.fallback as { provider: ProviderId }).provider as ProviderId) || "openai", model: ((t.fallback as { model: string }).model as string).trim() }
                : null,
            reasoningEffort: typeof t.reasoningEffort === "string" ? t.reasoningEffort.slice(0, 20) : undefined,
            maxTokens: Number.isFinite(Number(t.maxTokens)) ? Math.max(16, Math.min(4000, Math.floor(Number(t.maxTokens)))) : 400,
            maxCalls: Number.isFinite(Number(t.maxCalls)) ? Math.max(1, Math.min(3, Math.floor(Number(t.maxCalls)))) : 2,
            timeoutMs: Number.isFinite(Number(t.timeoutMs)) ? Math.max(2000, Math.min(120000, Math.floor(Number(t.timeoutMs)))) : 20000,
          }
        }
      }
    }
  }
  return {
    version: 1,
    auto: input.auto !== false,
    monthlyBudgetUsd: Number.isFinite(Number(input.monthlyBudgetUsd)) && Number(input.monthlyBudgetUsd) > 0 ? Number(input.monthlyBudgetUsd) : null,
    defaultTimeoutMs: Number.isFinite(Number(input.defaultTimeoutMs)) ? Math.max(2000, Math.min(120000, Math.floor(Number(input.defaultTimeoutMs)))) : 20000,
    tasks,
    updatedAt: new Date().toISOString(),
  }
}

export type HealthyProvider = { provider: ProviderId; model: string; hasKey: boolean; lastErrorCategory: string | null }

export type RouteDecision =
  | { kind: "routed"; candidates: Array<{ provider: ProviderId; model: string }>; reason: string }
  | { kind: "blocked"; reason: string }

/**
 * Pure routing decision for tests + worker.
 * - `spentUsdThisMonth` vs budget gates escalation (deterministic path never blocked).
 * - Unknown/unchanged outcomes never reach here (caller returns no-action first).
 */
export function decideRoute(input: {
  task: AiTaskKind
  config: RoutingConfig
  healthy: HealthyProvider[]
  spentUsdThisMonth: number | null
  escalate: boolean
}): RouteDecision {
  const route = input.config.tasks[input.task]
  if (!route) return { kind: "blocked", reason: "No route configured for this task." }
  const usable = (p: { provider: ProviderId; model: string }): boolean =>
    input.healthy.some((h) => h.provider === p.provider && h.hasKey && h.lastErrorCategory !== "authentication")
  if (input.config.monthlyBudgetUsd != null && input.spentUsdThisMonth != null && input.spentUsdThisMonth >= input.config.monthlyBudgetUsd) {
    return { kind: "blocked", reason: `Monthly AI budget of $${input.config.monthlyBudgetUsd} reached; deterministic processing continues.` }
  }
  if (route.mode === "manual") {
    const candidates: Array<{ provider: ProviderId; model: string }> = []
    if (usable(route.primary)) candidates.push(route.primary)
    if (route.fallback && usable(route.fallback)) candidates.push(route.fallback)
    const autoFallback = input.healthy.filter((h) => h.hasKey && !h.lastErrorCategory).slice(0, 1).map((h) => ({ provider: h.provider, model: h.model }))
    for (const c of autoFallback) {
      if (!candidates.some((e) => e.provider === c.provider && e.model === c.model)) candidates.push(c)
    }
    if (candidates.length === 0) return { kind: "blocked", reason: "No configured provider has a stored key." }
    return { kind: "routed", candidates, reason: "manual route" }
  }
  // auto: cheapest usable first. A provider whose key failed authentication is
  // skipped outright (a wrong key never recovers on its own); transient
  // errors (rate limit, timeout, connectivity) stay routable with retries.
  const eligible = input.healthy.filter((h) => h.hasKey && h.lastErrorCategory !== "authentication")
  if (eligible.length === 0) return { kind: "blocked", reason: "No provider has a usable stored key." }
  const order: Array<{ provider: ProviderId; model: string }> = []
  const cheap = eligible.find((h) => !h.lastErrorCategory)
  if (cheap) order.push({ provider: cheap.provider, model: cheap.model })
  for (const h of eligible) {
    if (!order.some((o) => o.provider === h.provider)) order.push({ provider: h.provider, model: h.model })
  }
  if (input.escalate && usable(STRONG_DEFAULT) && !order.some((o) => o.provider === STRONG_DEFAULT.provider)) {
    order.push({ ...STRONG_DEFAULT })
  }
  return { kind: "routed", candidates: order.slice(0, 3), reason: input.escalate ? "auto cost-aware + escalation" : "auto cost-aware" }
}
