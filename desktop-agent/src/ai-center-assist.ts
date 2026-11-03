/**
 * AI Center routed assistance (M6) — extends runFollowUpAssist, never replaces it.
 *
 * Execution order: deterministic workflow → approved memory → low-cost model
 * → stronger reasoning model if justified → human review.
 *
 * - Unchanged follow-up statuses and known deterministic outcomes never reach
 *   here (the caller returns no-action first, as before).
 * - Every model call is sanitized (claim/marketplace/step/signature only —
 *   never credentials, tokens, cookies, or page HTML), validated through
 *   `validateAiProposal`, and advisory-only: drafts are logged/filed for
 *   operator review, never executed as marketplace actions.
 * - Budget blocks route to human review without touching deterministic claim
 *   processing. Provider outages degrade to human review, never throw.
 */

import { logger } from "./logger.js"
import {
  estimateCost,
  generateWithRetries,
  testConnection,
  type ProviderId,
} from "./ai-providers.js"
import {
  hasProviderKey,
  readProviderPrefs,
  recordProviderError,
  recordProviderSuccess,
  revealProviderKey,
} from "./ai-provider-store.js"
import { decideRoute, type AiTaskKind } from "./ai-routing.js"
import { loadRoutingConfig } from "./ai-center-store.js"
import { appendActivity } from "./ai-center-store.js"
import { recordUsage, spentThisMonthUsd, readUsage } from "./ai-usage-store.js"
import { loadRtdbConfig, pushSignal } from "./ai-firebase.js"
import {
  buildDiagnosticPrompt,
  requestAiProposal,
  validateAiProposal,
  type AssistanceContext,
} from "./ai-assistant.js"
import { PROVIDER_CATALOG } from "./ai-providers.js"

export type RoutedAssistInput = {
  dir: string
  task: AiTaskKind
  agentFunction: string
  ctx: AssistanceContext
  note: string
  claimId: number
  marketplace: string
  /** True when escalation to a stronger model is justified. */
  escalate: boolean
  fileTask: (kind: "tracking_failure" | "operator_action", title: string, note: string) => Promise<number | null>
  reportToServer?: (row: {
    claimId: number
    marketplace: string
    agentFunction: string
    provider: string
    model: string
    stage: string
    memoryHit: boolean
    result: string
    errorCategory: string
    fallback: boolean
    approval: string
  }) => Promise<void>
}

export type RoutedAssistResult =
  | { handled: true; outcome: "ai_proposal" | "human_review" | "blocked_budget"; summary: string }
  | { handled: false }

function newActivityId(): string {
  return `act-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

export async function runRoutedAssist(input: RoutedAssistInput): Promise<RoutedAssistResult> {
  const startedAt = new Date().toISOString()
  const activityId = newActivityId()
  try {
    const config = loadRoutingConfig(input.dir)
    const route = config.tasks[input.task]
    const healthy = PROVIDER_CATALOG.map((entry) => {
      const prefs = readProviderPrefs(input.dir, entry.id)
      return {
        provider: entry.id,
        model: prefs.defaultModel || route.primary.model || entry.defaultModel,
        hasKey: hasProviderKey(input.dir, entry.id),
        lastErrorCategory: prefs.lastErrorCategory,
      }
    })
    const spent = spentThisMonthUsd(readUsage(input.dir, 2000))
    const decision = decideRoute({ task: input.task, config, healthy, spentUsdThisMonth: spent, escalate: input.escalate })
    if (decision.kind === "blocked") {
      appendActivity(input.dir, {
        id: activityId, at: startedAt, endAt: new Date().toISOString(),
        claimId: input.claimId, marketplace: input.marketplace, agentFunction: input.agentFunction,
        provider: "", model: "", stage: "blocked", memoryHit: false,
        result: decision.reason.slice(0, 200), errorCategory: "budget", fallback: false, approval: "pending",
      })
      return { handled: true, outcome: "blocked_budget", summary: decision.reason }
    }
    let lastError = ""
    let lastCategory: ProviderId | null = null
    for (const [index, candidate] of decision.candidates.entries()) {
      const apiKey = revealProviderKey(input.dir, candidate.provider)
      if (!apiKey) continue
      const prefs = readProviderPrefs(input.dir, candidate.provider)
      const t0 = Date.now()
      try {
        const maxTokens = route.maxTokens ?? 400
        const text = await requestAiProposal(
          {
            generateText: async (gen) =>
              generateWithRetries({
                provider: candidate.provider,
                apiKey,
                model: candidate.model,
                prompt: gen.prompt,
                system: gen.system,
                maxTokens: gen.maxTokens ?? maxTokens,
                baseUrl: prefs.baseUrlOverride || undefined,
              }).then((r) => ({ text: r.text, usage: r.usage })),
          },
          { prompt: buildDiagnosticPrompt(input.ctx, input.note), system: input.ctx.step, maxTokens },
          route.maxCalls ?? 2,
        )
        const latencyMs = Date.now() - t0
        const proposal = text ? { kind: "draft_response", summary: text, ticketRef: input.ctx.knownTicketId } : null
        if (proposal && validateAiProposal(proposal, input.ctx)) {
          recordProviderSuccess(input.dir, candidate.provider)
          const cost = estimateCost(candidate.provider, candidate.model, {})
          recordUsage(input.dir, {
            at: new Date().toISOString(), provider: candidate.provider, model: candidate.model, task: input.task,
            ok: true, errorCategory: null, inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null,
            latencyMs, estimatedUsd: cost.estimatedUsd, pricingProvenance: cost.provenance,
          })
          appendActivity(input.dir, {
            id: activityId, at: startedAt, endAt: new Date().toISOString(),
            claimId: input.claimId, marketplace: input.marketplace, agentFunction: input.agentFunction,
            provider: candidate.provider, model: candidate.model, stage: "model-invocation", memoryHit: false,
            result: proposal.summary.slice(0, 200), errorCategory: null, fallback: index > 0, approval: "pending",
          })
          await input.reportToServer?.({
            claimId: input.claimId, marketplace: input.marketplace, agentFunction: input.agentFunction,
            provider: candidate.provider, model: candidate.model, stage: "model-invocation",
            memoryHit: false, result: proposal.summary.slice(0, 200), errorCategory: "", fallback: index > 0, approval: "pending",
          })
          await pushSignal(loadRtdbConfig(), { type: "agent_status", at: new Date().toISOString(), ref: String(input.claimId), detail: `${input.marketplace}: AI draft ready for review` }).catch(() => false)
          return { handled: true, outcome: "ai_proposal", summary: `${input.marketplace}: AI draft ready for review` }
        }
        lastError = "AI proposal failed validation"
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const category = (err as { category?: string })?.category ?? "unknown"
        lastError = message.slice(0, 200)
        lastCategory = candidate.provider
        recordProviderError(input.dir, candidate.provider, message, category)
        recordUsage(input.dir, {
          at: new Date().toISOString(), provider: candidate.provider, model: candidate.model, task: input.task,
          ok: false, errorCategory: category, inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null,
          latencyMs: Date.now() - t0, estimatedUsd: null, pricingProvenance: "Unknown — failed request",
        })
      }
    }
    void lastCategory
    appendActivity(input.dir, {
      id: activityId, at: startedAt, endAt: new Date().toISOString(),
      claimId: input.claimId, marketplace: input.marketplace, agentFunction: input.agentFunction,
      provider: "", model: "", stage: "human-review", memoryHit: false,
      result: (lastError || "No provider available").slice(0, 200), errorCategory: "unknown", fallback: decision.candidates.length > 1, approval: "pending",
    })
    await input.fileTask("tracking_failure", `${input.marketplace}: needs operator review`, (lastError || "All providers unavailable").slice(0, 500))
    return { handled: true, outcome: "human_review", summary: `${input.marketplace}: needs operator review` }
  } catch (err) {
    logger.warn(`Routed assist skipped (${err instanceof Error ? err.message : err}).`)
    return { handled: false }
  }
}

/** UI Test Connection path: genuine low-cost model call, error categorized. */
export async function testProviderConnection(dir: string, provider: ProviderId, model: string): Promise<{ ok: true; latencyMs: number } | { ok: false; category: string; message: string }> {
  const apiKey = revealProviderKey(dir, provider)
  if (!apiKey) return { ok: false, category: "authentication", message: "No API key stored for this provider." }
  const prefs = readProviderPrefs(dir, provider)
  try {
    const res = await testConnection({ provider, apiKey, model: model || prefs.defaultModel, baseUrl: prefs.baseUrlOverride || undefined })
    recordProviderSuccess(dir, provider)
    return { ok: true, latencyMs: res.latencyMs }
  } catch (err) {
    const category = (err as { category?: string })?.category ?? "unknown"
    const message = err instanceof Error ? err.message : String(err)
    recordProviderError(dir, provider, message, category)
    return { ok: false, category, message: message.slice(0, 300) }
  }
}
