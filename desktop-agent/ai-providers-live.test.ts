// Live provider checks (Phase 7, real API).
// Runs ONLY when the matching env key exists; otherwise the provider is
// labelled NOT EXECUTED and the test passes without network. Never prints
// credentials, never gates unrelated suites, bounded to one 16-token call.

import test from "node:test"
import { testConnection, type ProviderId } from "../desktop-agent/src/ai-providers.ts"

const LIVE: Array<{ provider: ProviderId; env: string; model: string }> = [
  { provider: "meta", env: "META_API_KEY", model: process.env.META_TEST_MODEL || "muse-spark-1.3" },
  { provider: "openai", env: "OPENAI_API_KEY", model: process.env.OPENAI_TEST_MODEL || "gpt-4o-mini" },
  { provider: "kimi", env: "KIMI_API_KEY", model: process.env.KIMI_TEST_MODEL || "moonshot-v1-8k" },
  { provider: "anthropic", env: "ANTHROPIC_API_KEY", model: process.env.ANTHROPIC_TEST_MODEL || "claude-3-5-haiku-20241022" },
  { provider: "google", env: "GOOGLE_API_KEY", model: process.env.GOOGLE_TEST_MODEL || "gemini-2.0-flash" },
  { provider: "zai", env: "ZAI_API_KEY", model: process.env.ZAI_TEST_MODEL || "glm-4-flash" },
]

for (const { provider, env, model } of LIVE) {
  test(`live: ${provider} (${model}) — real 16-token call or NOT EXECUTED`, async (t) => {
    const apiKey = (process.env[env] || "").trim()
    if (!apiKey) {
      t.diagnostic(`NOT EXECUTED: ${env} unset — no live call for ${provider}`)
      return
    }
    const started = Date.now()
    const res = await testConnection({ provider, apiKey, model })
    t.diagnostic(`${provider}: live OK in ${Date.now() - started}ms (model ${res.model}, tokens in=${res.usage.inputTokens ?? "?"} out=${res.usage.outputTokens ?? "?"})`)
  })
}
