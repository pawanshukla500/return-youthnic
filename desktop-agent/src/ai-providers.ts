/**
 * AI Center provider catalog + adapters (M6).
 *
 * Six independent LLM providers reachable directly from the privileged desktop
 * process — no Vercel hosting, no paid gateway required. The existing
 * authenticated gateway (`GatewayProvider` in ai-assistant.ts) stays as an
 * optional seventh mode.
 *
 * Transport note: the worker hot path uses direct HTTPS calls below
 * (injectable `fetchFn`, bounded timeouts/retries, typed errors, token-usage
 * extraction). The surface is structurally compatible with Vercel AI SDK
 * Core's `generateText` (`ai` package): `desktop-agent/src/ai-sdk-bridge.ts`
 * wraps these same provider credentials with `generateText` + the official
 * `@ai-sdk/*` integrations, so the packaged app proves SDK compatibility
 * while the worker keeps a deterministic, mock-testable core.
 *
 * Model IDs: only IDs confirmed against each provider's public API docs or
 * supplied by the operator as manual IDs are ever sent. Marketing names
 * (e.g. "GPT Luna") are kept as UI aliases and NEVER sent as API model IDs.
 * Entries marked `verified: false` are operator-requested names awaiting
 * provider confirmation via Test Connection / model discovery.
 */

export type ProviderId = "meta" | "openai" | "kimi" | "anthropic" | "google" | "zai" | "gateway"

export type ErrorCategory =
  | "authentication"
  | "rate_limit"
  | "quota"
  | "unsupported_model"
  | "timeout"
  | "connectivity"
  | "server"
  | "bad_request"
  | "cancelled"
  | "unknown"

export class ProviderError extends Error {
  readonly category: ErrorCategory
  readonly provider: ProviderId
  readonly status?: number
  readonly retryable: boolean
  constructor(provider: ProviderId, category: ErrorCategory, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = "ProviderError"
    this.provider = provider
    this.category = category
    this.status = opts.status
    this.retryable = opts.retryable ?? (category === "rate_limit" || category === "server" || category === "timeout" || category === "connectivity")
  }
}

export type CatalogModel = {
  /** Exact API model ID to send. */
  id: string
  label: string
  /** True when confirmed against the provider's public docs/listings. */
  verified: boolean
  strengths: string[]
  supportsTools: boolean
  supportsReasoning: boolean
  contextWindow?: number
}

export type ProviderCatalogEntry = {
  id: Exclude<ProviderId, "gateway">
  name: string
  baseUrl: string
  apiKeyEnv: string
  docUrl: string
  transport: "openai-compatible" | "anthropic-messages" | "gemini-generateContent"
  discovery: { kind: "models-endpoint"; path: string } | { kind: "none"; reason: string }
  defaultModel: string
  models: CatalogModel[]
  /** USD per 1M tokens, from public pricing pages; null = Unknown. */
  pricing: Record<string, { inputPer1M: number | null; outputPer1M: number | null; provenance: string }>
}

/** Versioned catalog: bump CATALOG_VERSION when models/pricing change. */
export const PROVIDER_CATALOG_VERSION = 2

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "meta",
    name: "Meta Model API",
    baseUrl: "https://api.meta.ai/v1",
    apiKeyEnv: "META_API_KEY",
    docUrl: "https://developers.meta.com/",
    transport: "openai-compatible",
    discovery: { kind: "models-endpoint", path: "/models" },
    defaultModel: "muse-spark-1.3-contributor",
    models: [
      { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor (low-cost default)", verified: false, strengths: ["general", "complex-reasoning"], supportsTools: true, supportsReasoning: false },
      { id: "muse-spark-1.3", label: "Muse Spark 1.3", verified: false, strengths: ["general", "worker-diagnosis"], supportsTools: true, supportsReasoning: false },
    ],
    pricing: {
      "muse-spark-1.3": { inputPer1M: null, outputPer1M: null, provenance: "Unknown — no public per-token pricing page confirmed" },
      "muse-spark-1.3-contributor": { inputPer1M: null, outputPer1M: null, provenance: "Unknown — no public per-token pricing page confirmed" },
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    docUrl: "https://platform.openai.com/docs/models",
    transport: "openai-compatible",
    discovery: { kind: "models-endpoint", path: "/models" },
    defaultModel: "GPT-6.1-Terra",
    models: [
      { id: "GPT-6.1-Terra", label: "GPT-6.1 Terra (low-cost default)", verified: false, strengths: ["worker-diagnosis", "status-interpretation", "cost-aware"], supportsTools: true, supportsReasoning: false },
      { id: "gpt-4o-mini", label: "GPT-4o mini", verified: true, strengths: ["worker-diagnosis", "status-interpretation", "cost-aware"], supportsTools: true, supportsReasoning: false, contextWindow: 128000 },
      { id: "gpt-4o", label: "GPT-4o (stronger escalation)", verified: true, strengths: ["claim-rejection", "response-drafting", "complex-reasoning"], supportsTools: true, supportsReasoning: false, contextWindow: 128000 },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", verified: true, strengths: ["worker-diagnosis", "report-analysis"], supportsTools: true, supportsReasoning: false, contextWindow: 1047576 },
    ],
    pricing: {
      "GPT-6.1-Terra": { inputPer1M: null, outputPer1M: null, provenance: "Operator-requested ID — no public per-token pricing page confirmed" },
      "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6, provenance: "OpenAI pricing page, snapshot 2026 — estimate, provider bills" },
      "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10, provenance: "OpenAI pricing page, snapshot 2026 — estimate, provider bills" },
      "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6, provenance: "OpenAI pricing page, snapshot 2026 — estimate, provider bills" },
    },
  },
  {
    id: "kimi",
    name: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "KIMI_API_KEY",
    docUrl: "https://platform.moonshot.ai/docs",
    transport: "openai-compatible",
    discovery: { kind: "models-endpoint", path: "/models" },
    defaultModel: "moonshot-v1-8k",
    models: [
      { id: "moonshot-v1-8k", label: "Moonshot v1 8K", verified: true, strengths: ["worker-diagnosis", "status-interpretation"], supportsTools: true, supportsReasoning: false, contextWindow: 8000 },
      { id: "moonshot-v1-32k", label: "Moonshot v1 32K", verified: true, strengths: ["report-analysis"], supportsTools: true, supportsReasoning: false, contextWindow: 32768 },
      { id: "kimi-k2-0711-preview", label: "Kimi K2 preview", verified: true, strengths: ["complex-reasoning", "report-analysis"], supportsTools: true, supportsReasoning: false },
    ],
    pricing: {
      "moonshot-v1-8k": { inputPer1M: null, outputPer1M: null, provenance: "Unknown — see Moonshot pricing page" },
      "moonshot-v1-32k": { inputPer1M: null, outputPer1M: null, provenance: "Unknown — see Moonshot pricing page" },
      "kimi-k2-0711-preview": { inputPer1M: null, outputPer1M: null, provenance: "Unknown — see Moonshot pricing page" },
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    docUrl: "https://docs.anthropic.com/en/docs/models-overview",
    transport: "anthropic-messages",
    discovery: { kind: "models-endpoint", path: "/models" },
    defaultModel: "claude-haiku-5-5",
    models: [
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (low-cost default)", verified: false, strengths: ["worker-diagnosis", "status-interpretation", "cost-aware"], supportsTools: true, supportsReasoning: false },
      { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", verified: true, strengths: ["worker-diagnosis", "status-interpretation", "cost-aware"], supportsTools: true, supportsReasoning: false, contextWindow: 200000 },
      { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (stronger escalation)", verified: true, strengths: ["claim-rejection", "response-drafting", "complex-reasoning"], supportsTools: true, supportsReasoning: false, contextWindow: 200000 },
    ],
    pricing: {
      "claude-haiku-5-5": { inputPer1M: null, outputPer1M: null, provenance: "Operator-requested ID — no public per-token pricing page confirmed" },
      "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4, provenance: "Anthropic pricing page, snapshot 2026 — estimate, provider bills" },
      "claude-3-5-sonnet-20241022": { inputPer1M: 3, outputPer1M: 15, provenance: "Anthropic pricing page, snapshot 2026 — estimate, provider bills" },
    },
  },
  {
    id: "google",
    name: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GOOGLE_API_KEY",
    docUrl: "https://ai.google.dev/gemini-api/docs/models",
    transport: "gemini-generateContent",
    discovery: { kind: "models-endpoint", path: "/models" },
    defaultModel: "gemini-2.0-flash",
    models: [
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (low-cost default)", verified: true, strengths: ["worker-diagnosis", "status-interpretation", "cost-aware"], supportsTools: true, supportsReasoning: false, contextWindow: 1048576 },
      { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash", verified: true, strengths: ["worker-diagnosis", "report-analysis"], supportsTools: true, supportsReasoning: false, contextWindow: 1048576 },
    ],
    pricing: {
      "gemini-2.0-flash": { inputPer1M: null, outputPer1M: null, provenance: "Unknown — see Google AI pricing page" },
      "gemini-1.5-flash": { inputPer1M: null, outputPer1M: null, provenance: "Unknown — see Google AI pricing page" },
    },
  },
  {
    id: "zai",
    name: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    docUrl: "https://docs.z.ai/",
    transport: "openai-compatible",
    discovery: { kind: "models-endpoint", path: "/models" },
    defaultModel: "glm-4-flash",
    models: [
      { id: "glm-4-flash", label: "GLM-4 Flash (low-cost default)", verified: true, strengths: ["worker-diagnosis", "status-interpretation", "cost-aware"], supportsTools: true, supportsReasoning: false },
      { id: "glm-5.3-flash", label: "GLM 5.3 Flash (operator-requested)", verified: false, strengths: ["complex-reasoning"], supportsTools: true, supportsReasoning: true },
    ],
    pricing: {
      "glm-4-flash": { inputPer1M: null, outputPer1M: null, provenance: "Unknown — see Z.ai pricing page" },
      "glm-5.3-flash": { inputPer1M: null, outputPer1M: null, provenance: "Unknown — operator-requested ID, pricing unconfirmed" },
    },
  },
]

export function catalogEntry(provider: ProviderId): ProviderCatalogEntry | null {
  return PROVIDER_CATALOG.find((e) => e.id === provider) ?? null
}

export function isKnownModel(provider: ProviderId, model: string): boolean {
  const entry = catalogEntry(provider)
  if (!entry) return provider === "gateway"
  return entry.models.some((m) => m.id === model)
}

export type ReasoningRequest = {
  /** e.g. "low" | "medium" | "high" — only sent when the provider supports it. */
  effort?: string
  maxReasoningTokens?: number
}

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type GenerateRequest = {
  provider: ProviderId
  apiKey: string
  model: string
  prompt: string
  system?: string
  maxTokens?: number
  timeoutMs?: number
  /** Outer AbortSignal (UI cancel / engine shutdown). */
  signal?: AbortSignal
  reasoning?: ReasoningRequest
  tools?: ToolDefinition[]
  /** Override for self-hosted / regional endpoints. */
  baseUrl?: string
  fetchFn?: typeof fetch
}

export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
}

export type GenerateResponse = {
  text: string
  usage: TokenUsage
  model: string
  provider: ProviderId
  latencyMs: number
}

function classifyHttpError(provider: ProviderId, status: number, bodyText: string): ProviderError {
  const body = bodyText.slice(0, 500)
  if (status === 401 || status === 403) {
    if (/quota|credit|balance|insufficient/i.test(body)) {
      return new ProviderError(provider, "quota", `Provider quota exhausted (HTTP ${status}). ${body}`, { status, retryable: false })
    }
    return new ProviderError(provider, "authentication", `Authentication failed (HTTP ${status}). Check the API key. ${body}`, { status, retryable: false })
  }
  if (status === 429) {
    return new ProviderError(provider, "rate_limit", `Rate limited (HTTP 429). ${body}`, { status, retryable: true })
  }
  if (status === 404 || /model_not_found|unknown model|unsupported model/i.test(body)) {
    return new ProviderError(provider, "unsupported_model", `Model not available (HTTP ${status}). ${body}`, { status, retryable: false })
  }
  if (status === 402 || /insufficient_quota|billing/i.test(body)) {
    return new ProviderError(provider, "quota", `Provider quota/billing issue (HTTP ${status}). ${body}`, { status, retryable: false })
  }
  if (status >= 500) {
    return new ProviderError(provider, "server", `Provider server error (HTTP ${status}). ${body}`, { status, retryable: true })
  }
  return new ProviderError(provider, "bad_request", `Provider request failed (HTTP ${status}). ${body}`, { status, retryable: false })
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs)
  const cancel = (): void => clearTimeout(timer)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return { signal: controller.signal, cancel }
}

function sanitizeForLog(value: string): string {
  return value.slice(0, 120)
}

async function postJson(url: string, apiKey: string, keyHeader: Record<string, string>, body: unknown, timeoutMs: number, outerSignal: AbortSignal | undefined, fetchFn: typeof fetch, provider: ProviderId): Promise<{ status: number; json: any; text: string }> {
  const { signal, cancel } = withTimeout(outerSignal, timeoutMs)
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...keyHeader },
      body: JSON.stringify(body),
      signal,
    })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    void sanitizeForLog(apiKey.slice(0, 0))
    if (!res.ok) throw classifyHttpError(provider, res.status, text)
    return { status: res.status, json, text }
  } catch (err) {
    if (err instanceof ProviderError) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (/abort|timeout/i.test(message) || (err instanceof Error && err.name === "AbortError")) {
      const wasOuter = outerSignal?.aborted === true
      throw new ProviderError(provider, wasOuter ? "cancelled" : "timeout", `Request ${wasOuter ? "cancelled" : "timed out"} after ${timeoutMs}ms.`, { retryable: !wasOuter })
    }
    throw new ProviderError(provider, "connectivity", `Network error: ${message.slice(0, 200)}`, { retryable: true })
  } finally {
    cancel()
  }
}

function extractOpenAiUsage(data: any): TokenUsage {
  const u = data?.usage ?? {}
  const usage: TokenUsage = {}
  if (Number.isFinite(Number(u.prompt_tokens))) usage.inputTokens = Number(u.prompt_tokens)
  if (Number.isFinite(Number(u.completion_tokens))) usage.outputTokens = Number(u.completion_tokens)
  if (Number.isFinite(Number(u.prompt_tokens_details?.cached_tokens))) usage.cachedTokens = Number(u.prompt_tokens_details.cached_tokens)
  if (Number.isFinite(Number(u.completion_tokens_details?.reasoning_tokens))) usage.reasoningTokens = Number(u.completion_tokens_details.reasoning_tokens)
  return usage
}

function openAiChatBody(model: string, prompt: string, system: string | undefined, maxTokens: number, tools: ToolDefinition[] | undefined, reasoning: ReasoningRequest | undefined, provider: ProviderId): Record<string, unknown> {
  const messages: Array<Record<string, string>> = []
  if (system) messages.push({ role: "system", content: system.slice(0, 4000) })
  messages.push({ role: "user", content: prompt.slice(0, 12000) })
  const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens }
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description.slice(0, 500), parameters: t.parameters } }))
  }
  // Reasoning params are provider-specific: only attach when the catalog model
  // advertises reasoning support. Never silently pass unsupported params.
  const entry = catalogEntry(provider)
  const modelMeta = entry?.models.find((m) => m.id === model)
  if (reasoning && modelMeta?.supportsReasoning) {
    if (reasoning.effort) body.reasoning_effort = reasoning.effort
    if (reasoning.maxReasoningTokens) body.max_reasoning_tokens = reasoning.maxReasoningTokens
  }
  return body
}

async function callOpenAiCompatible(req: GenerateRequest, baseUrl: string): Promise<GenerateResponse> {
  const started = Date.now()
  const fetchFn = req.fetchFn ?? fetch
  const timeoutMs = req.timeoutMs ?? 20000
  const maxTokens = Math.max(1, Math.min(4000, req.maxTokens ?? 256))
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`
  const { json } = await postJson(url, req.apiKey, { authorization: `Bearer ${req.apiKey}` }, openAiChatBody(req.model, req.prompt, req.system, maxTokens, req.tools, req.reasoning, req.provider), timeoutMs, req.signal, fetchFn, req.provider)
  const text = String(json?.choices?.[0]?.message?.content ?? "")
  if (!text.trim()) throw new ProviderError(req.provider, "bad_request", "Provider returned no text.", { retryable: false })
  return { text: text.slice(0, 8000), usage: extractOpenAiUsage(json), model: req.model, provider: req.provider, latencyMs: Date.now() - started }
}

async function callAnthropic(req: GenerateRequest, baseUrl: string): Promise<GenerateResponse> {
  const started = Date.now()
  const fetchFn = req.fetchFn ?? fetch
  const timeoutMs = req.timeoutMs ?? 20000
  const maxTokens = Math.max(1, Math.min(4000, req.maxTokens ?? 256))
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: req.prompt.slice(0, 12000) }],
  }
  if (req.system) body.system = req.system.slice(0, 4000)
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description.slice(0, 500), input_schema: t.parameters }))
  }
  const entry = catalogEntry(req.provider)
  const modelMeta = entry?.models.find((m) => m.id === req.model)
  if (req.reasoning && modelMeta?.supportsReasoning) {
    body.thinking = { type: "enabled", budget_tokens: req.reasoning.maxReasoningTokens ?? 1024 }
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/messages`
  const { json } = await postJson(url, req.apiKey, { "x-api-key": req.apiKey, "anthropic-version": "2023-06-01" }, body, timeoutMs, req.signal, fetchFn, req.provider)
  const blocks = Array.isArray(json?.content) ? json.content : []
  const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n")
  if (!text.trim()) throw new ProviderError(req.provider, "bad_request", "Provider returned no text.", { retryable: false })
  const usage: TokenUsage = {}
  if (Number.isFinite(Number(json?.usage?.input_tokens))) usage.inputTokens = Number(json.usage.input_tokens)
  if (Number.isFinite(Number(json?.usage?.output_tokens))) usage.outputTokens = Number(json.usage.output_tokens)
  return { text: text.slice(0, 8000), usage, model: req.model, provider: req.provider, latencyMs: Date.now() - started }
}

async function callGemini(req: GenerateRequest, baseUrl: string): Promise<GenerateResponse> {
  const started = Date.now()
  const fetchFn = req.fetchFn ?? fetch
  const timeoutMs = req.timeoutMs ?? 20000
  const contents: unknown[] = []
  if (req.system) contents.push({ role: "user", parts: [{ text: `System: ${req.system.slice(0, 2000)}` }] })
  contents.push({ role: "user", parts: [{ text: req.prompt.slice(0, 12000) }] })
  const url = `${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(req.apiKey)}`
  const { signal, cancel } = withTimeout(req.signal, timeoutMs)
  try {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents }), signal })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) throw classifyHttpError(req.provider, res.status, text)
    const parts = json?.candidates?.[0]?.content?.parts ?? []
    const out = parts.map((p: any) => String(p?.text ?? "")).join("\n")
    if (!out.trim()) throw new ProviderError(req.provider, "bad_request", "Provider returned no text.", { retryable: false })
    const usage: TokenUsage = {}
    if (Number.isFinite(Number(json?.usageMetadata?.promptTokenCount))) usage.inputTokens = Number(json.usageMetadata.promptTokenCount)
    if (Number.isFinite(Number(json?.usageMetadata?.candidatesTokenCount))) usage.outputTokens = Number(json.usageMetadata.candidatesTokenCount)
    if (Number.isFinite(Number(json?.usageMetadata?.cachedContentTokenCount))) usage.cachedTokens = Number(json.usageMetadata.cachedContentTokenCount)
    return { text: out.slice(0, 8000), usage, model: req.model, provider: req.provider, latencyMs: Date.now() - started }
  } catch (err) {
    if (err instanceof ProviderError) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (/abort|timeout/i.test(message) || (err instanceof Error && err.name === "AbortError")) {
      throw new ProviderError(req.provider, req.signal?.aborted ? "cancelled" : "timeout", `Request timed out after ${timeoutMs}ms.`, { retryable: true })
    }
    throw new ProviderError(req.provider, "connectivity", `Network error: ${message.slice(0, 200)}`, { retryable: true })
  } finally {
    cancel()
  }
}

/** Single attempt, no retries. The router adds bounded retries + fallback. */
export async function generateOnce(req: GenerateRequest): Promise<GenerateResponse> {
  if (!req.apiKey) throw new ProviderError(req.provider, "authentication", "No API key stored for this provider.", { retryable: false })
  if (!req.model.trim()) throw new ProviderError(req.provider, "unsupported_model", "No model selected for this provider.", { retryable: false })
  const baseUrl = (req.baseUrl || catalogEntry(req.provider)?.baseUrl || "").trim()
  if (!baseUrl) throw new ProviderError(req.provider, "bad_request", "No endpoint configured for this provider.", { retryable: false })
  if (req.provider === "anthropic") return callAnthropic(req, baseUrl)
  if (req.provider === "google") return callGemini(req, baseUrl)
  return callOpenAiCompatible(req, baseUrl)
}

/** Bounded retries with exponential backoff (300ms, 800ms). Throws the last error. */
export async function generateWithRetries(req: GenerateRequest, maxAttempts = 2): Promise<GenerateResponse> {
  const attempts = Math.max(1, Math.min(3, Math.floor(maxAttempts) || 1))
  let last: unknown = null
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await generateOnce(req)
    } catch (err) {
      last = err
      if (err instanceof ProviderError && !err.retryable) throw err
      if (i < attempts) await new Promise((r) => setTimeout(r, i === 1 ? 300 : 800))
    }
  }
  throw last instanceof Error ? last : new Error("Provider call failed.")
}

/** Try each candidate in order; returns the first success or throws the last error. */
export async function generateWithFallback(candidates: GenerateRequest[]): Promise<GenerateResponse> {
  if (candidates.length === 0) throw new Error("No provider candidates configured.")
  let last: unknown = null
  for (const candidate of candidates) {
    try {
      return await generateWithRetries(candidate, 2)
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error("All provider candidates failed.")
}

/** Genuine low-cost authenticated check: a real model call capped at 16 tokens. */
export async function testConnection(req: Omit<GenerateRequest, "prompt" | "maxTokens"> & { prompt?: string }): Promise<{ ok: true; model: string; latencyMs: number; usage: TokenUsage }> {
  const res = await generateWithRetries({ ...req, prompt: req.prompt ?? "Reply with the single word OK.", system: undefined, maxTokens: 16, tools: undefined, reasoning: undefined }, 1)
  return { ok: true, model: res.model, latencyMs: res.latencyMs, usage: res.usage }
}

/** Model discovery where the provider exposes a list endpoint. */
export async function discoverModels(provider: Exclude<ProviderId, "gateway">, apiKey: string, opts: { baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {}): Promise<{ models: string[]; source: "provider-api" | "catalog" }> {
  const entry = catalogEntry(provider)
  if (!entry) return { models: [], source: "catalog" }
  if (entry.discovery.kind === "none" || !apiKey) {
    return { models: entry.models.map((m) => m.id), source: "catalog" }
  }
  const fetchFn = opts.fetchFn ?? fetch
  const baseUrl = (opts.baseUrl || entry.baseUrl).replace(/\/+$/, "")
  try {
    if (provider === "anthropic") {
      const res = await fetchFn(`${baseUrl}${entry.discovery.path}`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: any = await res.json()
      const ids = (Array.isArray(json?.data) ? json.data : []).map((m: any) => String(m?.id ?? "")).filter(Boolean)
      return { models: ids.length > 0 ? ids : entry.models.map((m) => m.id), source: ids.length > 0 ? "provider-api" : "catalog" }
    }
    if (provider === "google") {
      const res = await fetchFn(`${baseUrl}${entry.discovery.path}?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: any = await res.json()
      const ids = (Array.isArray(json?.models) ? json.models : []).map((m: any) => String(m?.name ?? "").replace(/^models\//, "")).filter(Boolean)
      return { models: ids.length > 0 ? ids : entry.models.map((m) => m.id), source: ids.length > 0 ? "provider-api" : "catalog" }
    }
    const res = await fetchFn(`${baseUrl}${entry.discovery.path}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json: any = await res.json()
    const ids = (Array.isArray(json?.data) ? json.data : []).map((m: any) => String(m?.id ?? "")).filter(Boolean)
    return { models: ids.length > 0 ? ids : entry.models.map((m) => m.id), source: ids.length > 0 ? "provider-api" : "catalog" }
  } catch {
    return { models: entry.models.map((m) => m.id), source: "catalog" }
  }
}

/** Structured output with schema validation. Throws on invalid JSON/shape. */
export async function generateStructured<T>(req: GenerateRequest, validate: (value: unknown) => value is T): Promise<{ value: T; usage: TokenUsage; model: string }> {
  const res = await generateWithRetries({ ...req, system: `${req.system ?? ""}\nReply with JSON only. No prose, no code fences.`.trim() }, 2)
  let parsed: unknown = null
  try {
    const cleaned = res.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
    parsed = JSON.parse(cleaned)
  } catch {
    throw new ProviderError(req.provider, "bad_request", "Provider did not return valid JSON.", { retryable: false })
  }
  if (!validate(parsed)) throw new ProviderError(req.provider, "bad_request", "Provider JSON failed schema validation.", { retryable: false })
  return { value: parsed, usage: res.usage, model: res.model }
}

export type CostEstimate = {
  /** USD estimate, or null when pricing is Unknown. */
  estimatedUsd: number | null
  provenance: string
}

export function estimateCost(provider: ProviderId, model: string, usage: TokenUsage): CostEstimate {
  const entry = catalogEntry(provider)
  const price = entry?.pricing[model]
  if (!price) return { estimatedUsd: null, provenance: "Unknown — no pricing entry for this model" }
  if (price.inputPer1M == null || price.outputPer1M == null) return { estimatedUsd: null, provenance: price.provenance }
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  return { estimatedUsd: (input * price.inputPer1M + output * price.outputPer1M) / 1_000_000, provenance: `${price.provenance}; computed from provider-reported tokens` }
}
