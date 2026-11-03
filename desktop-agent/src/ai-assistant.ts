/**
 * Local AI orchestration core (Milestone 1: assistance layer foundation).
 *
 * Provider-independent by design. The `AiProvider` surface is structurally
 * compatible with Vercel AI SDK Core's `generateText` (`ai` package), so an
 * installed `@ai-sdk/*` provider is a drop-in without changing the worker:
 *
 *   import { generateText } from "ai"
 *   const provider = { generateText: (input) => generateText({ model, ...input }) }
 *
 * No AI package is bundled yet on purpose: warehouse PCs run 2 cores / 4 GB
 * RAM, the worker must keep working with zero AI availability, and long-lived
 * provider credentials belong on the server behind an authenticated gateway,
 * not on the PC. The only built-in provider is `GatewayProvider`, which POSTs
 * to `AI_GATEWAY_URL` with `AI_GATEWAY_TOKEN` (both unset by default, so AI
 * is OFF until the operator opts in). Never reuse editor/coding-session tokens
 * as the gateway credential; provision a dedicated runtime token server-side.
 *
 * Execution priority everywhere this module is used:
 *   deterministic workflow -> approved recovery memory -> AI proposal -> human review.
 * The worker never blocks on AI: every call is bounded (timeout + max calls per
 * job) and degrades to `human-review` instead of throwing.
 */

export type AiGenerateInput = {
  prompt: string
  system?: string
  maxTokens?: number
}

import type { TokenUsage } from "./ai-providers.js"

export type AiGenerateResult = {
  text: string
  usage?: TokenUsage
}

/** Structurally compatible with `generateText` from Vercel AI SDK Core. */
export type AiProvider = {
  generateText(input: AiGenerateInput): Promise<AiGenerateResult>
}

export type AiAssistConfig = {
  enabled: boolean
  gatewayUrl: string
  gatewayToken: string
  modelName: string
  maxCallsPerJob: number
  timeoutMs: number
}

export function loadAiAssistConfig(env: NodeJS.ProcessEnv = process.env): AiAssistConfig {
  const positive = (value: string | undefined): boolean => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase())
  const positiveInt = (value: string | undefined, fallback: number): number => {
    const parsed = Number(String(value || "").trim())
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
  }
  return {
    enabled: positive(env.AI_ASSIST_ENABLED),
    gatewayUrl: String(env.AI_GATEWAY_URL || "").trim().replace(/\/+$/, ""),
    gatewayToken: String(env.AI_GATEWAY_TOKEN || ""),
    modelName: String(env.AI_MODEL_NAME || "meta-muse-spark-1.3").trim(),
    maxCallsPerJob: positiveInt(env.AI_MAX_CALLS_PER_JOB, 2),
    timeoutMs: positiveInt(env.AI_TIMEOUT_MS, 20000),
  }
}

/** Metadata-only ledger: counts, latencies, and the last provider-reported usage; never prompt/response text. */
export type AiUsageSnapshot = {
  calls: number
  failures: number
  lastLatencyMs: number | null
  lastModel: string
  lastUsage: TokenUsage | null
}

const usageLedger: AiUsageSnapshot = { calls: 0, failures: 0, lastLatencyMs: null, lastModel: "", lastUsage: null }

export function aiUsageSnapshot(): AiUsageSnapshot {
  return { ...usageLedger }
}

export function resetAiUsageForTests(): void {
  usageLedger.calls = 0
  usageLedger.failures = 0
  usageLedger.lastLatencyMs = null
  usageLedger.lastModel = ""
  usageLedger.lastUsage = null
}

/**
 * Authenticated, restricted gateway provider. The token travels only as an
 * `Authorization: Bearer` header, is never logged, and is never accepted from
 * a query string. Prompts stay in the request body; only metadata is logged.
 */
export class GatewayProvider implements AiProvider {
  constructor(
    private gatewayUrl: string,
    private gatewayToken: string,
    private modelName: string,
    private timeoutMs: number,
  ) {
    if (!gatewayUrl) throw new Error("AI_GATEWAY_URL is not configured.")
    if (!gatewayToken) throw new Error("AI_GATEWAY_TOKEN is not configured.")
  }

  async generateText(input: AiGenerateInput): Promise<AiGenerateResult> {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let delivered: TokenUsage | undefined
    try {
      const res = await fetch(`${this.gatewayUrl}/v1/generate-text`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.gatewayToken}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          system: input.system || "",
          prompt: input.prompt,
          maxTokens: input.maxTokens || 800,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`AI gateway answered HTTP ${res.status}.`)
      const data = (await res.json()) as { text?: unknown; usage?: AiGenerateResult["usage"] }
      if (typeof data.text !== "string" || !data.text.trim()) throw new Error("AI gateway returned no text.")
      delivered = data.usage
      return { text: data.text.slice(0, 8000), usage: data.usage }
    } finally {
      clearTimeout(timer)
      usageLedger.calls += 1
      usageLedger.lastLatencyMs = Date.now() - started
      usageLedger.lastModel = this.modelName
      if (delivered) usageLedger.lastUsage = { ...delivered }
    }
  }
}

export function providerFromConfig(config: AiAssistConfig): AiProvider | null {
  if (!config.enabled) return null
  if (!config.gatewayUrl || !config.gatewayToken) return null
  return new GatewayProvider(config.gatewayUrl, config.gatewayToken, config.modelName, config.timeoutMs)
}

/** Actions the worker may execute without a human in the loop. */
export const SAFE_ACTION_KINDS = ["suggest_selector", "retry_step", "collect_diagnostics", "draft_response"] as const

export type SafeActionKind = (typeof SAFE_ACTION_KINDS)[number]

export type AiProposal = {
  kind: string
  summary: string
  detail?: string
  /** Any ticket/claim reference the model echoed back. Must match reality. */
  ticketRef?: string
}

export type AssistanceContext = {
  marketplace: string
  claimId: number
  /** Ticket reference the worker already holds. Proposals must not invent another. */
  knownTicketId: string
  step: string
  errorSignature: string
}

export type AssistanceDecision =
  | { kind: "approved-memory"; procedureId: string; steps: string[] }
  | { kind: "ai-proposal"; proposal: AiProposal }
  | { kind: "human-review"; reason: string }

/**
 * Validate an AI proposal before the worker may act on it. Rejects:
 * - any action kind outside the safe allowlist (sending, submitting,
 *   auth bypass, code/config changes all land here),
 * - a ticket reference that does not equal the worker's known ticket
 *   (the model must never invent evidence or fabricate ticket IDs),
 * - empty or oversized proposals.
 */
export function validateAiProposal(proposal: AiProposal, ctx: AssistanceContext): proposal is AiProposal & { kind: SafeActionKind } {
  if (!(SAFE_ACTION_KINDS as readonly string[]).includes(proposal.kind)) return false
  if (!proposal.summary || !proposal.summary.trim()) return false
  if (proposal.summary.length > 2000) return false
  if (proposal.ticketRef && proposal.ticketRef.trim() && proposal.ticketRef.trim() !== ctx.knownTicketId.trim()) {
    return false
  }
  return true
}

/**
 * Ask the provider with bounded retries. Never throws: exhaustion returns null
 * so the caller degrades to human review. Counts every attempt in the ledger.
 * The returned usage is the provider-reported token counts (never null-filled
 * by this layer); callers record it instead of dropping it.
 */
export async function requestAiProposal(
  provider: AiProvider | null,
  input: AiGenerateInput,
  maxAttempts: number,
): Promise<{ text: string; usage?: TokenUsage } | null> {
  if (!provider) return null
  const attempts = Math.max(1, Math.min(3, Math.floor(maxAttempts) || 1))
  let lastError = ""
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await provider.generateText(input)
      if (result.text && result.text.trim()) {
        if (result.usage) usageLedger.lastUsage = { ...result.usage }
        return { text: result.text, usage: result.usage }
      }
      lastError = "empty response"
    } catch (err) {
      lastError = err instanceof Error ? err.message : "AI call failed"
      usageLedger.failures += 1
    }
  }
  void lastError
  return null
}

export type FollowUpMemoryHit = {
  procedureId: string
  title: string
  steps: string[]
}

export type FollowUpAssistInput = {
  outcome: string
  /** True when the ticket state differs from the previous check. */
  statusChanged: boolean
  /** Approved-procedure match from the local memory cache, if any. */
  memoryHit: FollowUpMemoryHit | null
  /** True when the operator enabled AI and a gateway is configured. */
  aiEnabled: boolean
}

export type FollowUpAssistDecision =
  | { action: "no-action"; reason: string }
  | { action: "memory-hit"; procedure: FollowUpMemoryHit }
  | { action: "ai-needed" }
  | { action: "human-review"; reason: string }

/**
 * Memory-first routing for one follow-up check. Unchanged tickets and
 * unsupported readers need nothing; an approved procedure beats a model call;
 * a model call beats an unassisted guess; anything else goes to a human.
 * Never executes an action — the caller only logs, drafts, or escalates.
 */
export function decideFollowUpAssist(input: FollowUpAssistInput): FollowUpAssistDecision {
  if (input.outcome === "status_read" && !input.statusChanged) {
    return { action: "no-action", reason: "ticket state unchanged since the previous check" }
  }
  if (input.outcome === "not_supported") {
    return { action: "no-action", reason: "marketplace has no status reader" }
  }
  if (input.memoryHit) return { action: "memory-hit", procedure: input.memoryHit }
  if (input.aiEnabled) return { action: "ai-needed" }
  return { action: "human-review", reason: "no approved procedure and AI assistance is off" }
}

/**
 * Build the safe diagnostic context sent to the model. Contains the claim,
 * marketplace, step, error signature and approved-procedure outcome — never
 * credentials, tokens, cookies, or full page HTML.
 */
export function buildDiagnosticPrompt(ctx: AssistanceContext, extraNote: string): string {
  return [
    `Marketplace: ${ctx.marketplace}`,
    `Claim id: ${ctx.claimId}`,
    `Ticket ref: ${ctx.knownTicketId || "(none yet)"}`,
    `Worker step: ${ctx.step}`,
    `Error signature: ${ctx.errorSignature}`,
    extraNote ? `Note: ${extraNote.slice(0, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}
