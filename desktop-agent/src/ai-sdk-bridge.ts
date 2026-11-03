/**
 * Vercel AI SDK Core bridge (M6).
 *
 * Proves the packaged Electron app runs the official SDK path:
 * `generateText` from `ai` with `@ai-sdk/openai` (OpenAI + every
 * OpenAI-compatible endpoint: Meta, Kimi/Moonshot, Z.ai), `@ai-sdk/anthropic`
 * (native messages), and `@ai-sdk/google` (native Gemini).
 *
 * The worker hot path keeps using `ai-providers.ts` direct transport
 * (injectable fetch, deterministic tests). This bridge is used for
 * SDK-path verification (provider Test Connection `sdk` mode and the
 * packaged-app import test), so both routes hit the real provider API.
 */

import { generateText } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { catalogEntry, type ProviderId, type TokenUsage } from "./ai-providers.js"

export type SdkGenerateInput = {
  provider: ProviderId
  apiKey: string
  model: string
  prompt: string
  system?: string
  maxTokens?: number
  baseUrl?: string
}

export type SdkGenerateResult = {
  text: string
  usage: TokenUsage
}

export function sdkModelFor(input: SdkGenerateInput): unknown {
  const baseUrl = (input.baseUrl || catalogEntry(input.provider)?.baseUrl || "").trim()
  if (input.provider === "anthropic") {
    return createAnthropic({ apiKey: input.apiKey })(input.model)
  }
  if (input.provider === "google") {
    return createGoogleGenerativeAI({ apiKey: input.apiKey })(input.model)
  }
  if (input.provider === "gateway") {
    throw new Error("The authenticated gateway has no AI SDK model; use its HTTP endpoint.")
  }
  return createOpenAI({ apiKey: input.apiKey, baseURL: `${baseUrl}/chat/completions` })(input.model)
}

export async function generateTextViaSdk(input: SdkGenerateInput): Promise<SdkGenerateResult> {
  if (!input.apiKey) throw new Error("No API key stored for this provider.")
  if (!input.model.trim()) throw new Error("No model selected for this provider.")
  const model = sdkModelFor(input) as Parameters<typeof generateText>[0]["model"]
  const result = await generateText({
    model,
    system: input.system,
    prompt: input.prompt.slice(0, 12000),
    maxOutputTokens: Math.max(1, Math.min(4000, input.maxTokens ?? 256)),
  })
  return {
    text: String(result.text ?? "").slice(0, 8000),
    usage: {
      inputTokens: typeof result.usage?.inputTokens === "number" ? result.usage.inputTokens : undefined,
      outputTokens: typeof result.usage?.outputTokens === "number" ? result.usage.outputTokens : undefined,
      reasoningTokens: typeof result.usage?.reasoningTokens === "number" ? result.usage.reasoningTokens : undefined,
      cachedTokens: typeof result.usage?.cachedInputTokens === "number" ? result.usage.cachedInputTokens : undefined,
    },
  }
}
