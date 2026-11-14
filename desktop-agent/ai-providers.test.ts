// Conformance tests for the six AI Center provider adapters (M6).
// Deterministic: every test injects a mocked fetch. No network, no keys.
// Live-provider checks live in ai-providers-live.test.ts (NOT EXECUTED
// without real keys) and never gate these contract tests.

import test from "node:test"
import assert from "node:assert/strict"
import {
  PROVIDER_CATALOG,
  PROVIDER_CATALOG_VERSION,
  ProviderError,
  catalogEntry,
  discoverModels,
  estimateCost,
  generateStructured,
  generateWithRetries,
  generateWithFallback,
  isKnownModel,
  testConnection,
} from "./src/ai-providers.ts"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function openAiOk(text = "SYN-OK", usage: Record<string, unknown> = { prompt_tokens: 12, completion_tokens: 5 }): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async () => jsonResponse(200, { choices: [{ message: { content: text } }], usage })
}

test("catalog is versioned, covers six providers, and marks operator-requested IDs unverified", () => {
  assert.equal(PROVIDER_CATALOG_VERSION, 2)
  assert.deepEqual(PROVIDER_CATALOG.map((e) => e.id).sort(), ["anthropic", "google", "kimi", "meta", "openai", "zai"])
  for (const entry of PROVIDER_CATALOG) {
    assert.ok(entry.baseUrl.startsWith("https://"), entry.id)
    assert.ok(entry.models.length > 0, entry.id)
    assert.equal(entry.defaultModel, entry.models[0].id, entry.id)
  }
  // Operator-requested names stay manual until a provider confirms them.
  assert.equal(catalogEntry("meta")?.defaultModel, "muse-spark-1.3-contributor")
  assert.equal(isKnownModel("meta", "muse-spark-1.3-contributor"), true)
  assert.equal(catalogEntry("meta")?.models.find((m) => m.id === "muse-spark-1.3-contributor")?.verified, false)
  assert.equal(catalogEntry("openai")?.defaultModel, "GPT-6.1-Terra")
  assert.equal(isKnownModel("openai", "GPT-6.1-Terra"), true)
  assert.equal(catalogEntry("openai")?.models.find((m) => m.id === "GPT-6.1-Terra")?.verified, false)
  assert.equal(catalogEntry("anthropic")?.defaultModel, "claude-haiku-5-5")
  assert.equal(isKnownModel("anthropic", "claude-haiku-5-5"), true)
  assert.equal(catalogEntry("anthropic")?.models.find((m) => m.id === "claude-haiku-5-5")?.verified, false)
  assert.equal(catalogEntry("zai")?.models.find((m) => m.id === "glm-5.3-flash")?.verified, false)
  // Unrequested marketing names are never API IDs.
  assert.equal(isKnownModel("openai", "GPT Luna"), false)
  assert.equal(isKnownModel("openai", "gpt-4o-mini"), true)
})

test("invalid API key maps to authentication (401) without leaking the key", async () => {
  const seen: string[] = []
  const fetchFn = (async () => {
    return jsonResponse(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } })
  }) as typeof fetch
  try {
    await generateWithRetries({ provider: "openai", apiKey: "SYN-BAD-KEY", model: "gpt-4o-mini", prompt: "SYN-Hi", fetchFn }, 1)
    assert.fail("should throw")
  } catch (err) {
    assert.ok(err instanceof ProviderError)
    assert.equal(err.category, "authentication")
    assert.equal(err.retryable, false)
    seen.push(err.message)
  }
  assert.ok(!seen.join(" ").includes("SYN-BAD-KEY"), "error must not echo the key")
})

test("rate limit, quota, unsupported model, and server errors classify distinctly", async () => {
  const cases: Array<[number, unknown, string]> = [
    [429, { error: { message: "Rate limit reached" } }, "rate_limit"],
    [402, { error: { message: "Insufficient quota" } }, "quota"],
    [404, { error: { message: "model_not_found" } }, "unsupported_model"],
    [500, "boom", "server"],
  ]
  for (const [status, body, category] of cases) {
    const fetchFn = (async () => jsonResponse(status, body)) as typeof fetch
    try {
      await generateWithRetries({ provider: "kimi", apiKey: "SYN-KEY", model: "moonshot-v1-8k", prompt: "SYN-Hi", fetchFn }, 1)
      assert.fail("should throw")
    } catch (err) {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.category, category, `HTTP ${status}`)
    }
  }
})

test("valid key returns text plus provider-reported token usage", async () => {
  const res = await generateWithRetries({
    provider: "openai", apiKey: "SYN-KEY", model: "gpt-4o-mini", prompt: "SYN-Hi",
    fetchFn: openAiOk("SYN-Reply", { prompt_tokens: 10, completion_tokens: 4 }),
  }, 1)
  assert.equal(res.text, "SYN-Reply")
  assert.equal(res.usage.inputTokens, 10)
  assert.equal(res.usage.outputTokens, 4)
  assert.equal(res.provider, "openai")
})

test("anthropic native transport parses content blocks and usage", async () => {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(url).includes("/messages"))
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.equal(body.model, "claude-3-5-haiku-20241022")
    return jsonResponse(200, {
      content: [{ type: "text", text: "SYN-Draft" }],
      usage: { input_tokens: 20, output_tokens: 8 },
    })
  }) as typeof fetch
  const res = await generateWithRetries({ provider: "anthropic", apiKey: "SYN-KEY", model: "claude-3-5-haiku-20241022", prompt: "SYN-Hi", fetchFn }, 1)
  assert.equal(res.text, "SYN-Draft")
  assert.equal(res.usage.inputTokens, 20)
  assert.equal(res.usage.outputTokens, 8)
})

test("gemini native transport uses key in query and parses usageMetadata", async () => {
  const fetchFn = (async (url: string | URL | Request) => {
    assert.ok(String(url).includes("key=SYN-KEY"))
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: "SYN-Summary" }] } }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9 },
    })
  }) as typeof fetch
  const res = await generateWithRetries({ provider: "google", apiKey: "SYN-KEY", model: "gemini-2.0-flash", prompt: "SYN-Hi", fetchFn }, 1)
  assert.equal(res.text, "SYN-Summary")
  assert.equal(res.usage.inputTokens, 30)
  assert.equal(res.usage.outputTokens, 9)
})

test("structured output validates JSON and rejects wrong shapes", async () => {
  const good = await generateStructured(
    { provider: "openai", apiKey: "SYN-KEY", model: "gpt-4o-mini", prompt: "SYN-Hi", fetchFn: openAiOk('{"kind":"draft_response","summary":"SYN-Try X"}') },
    (v): v is { kind: string; summary: string } => typeof (v as { kind?: unknown })?.kind === "string" && typeof (v as { summary?: unknown })?.summary === "string",
  )
  assert.equal(good.value.summary, "SYN-Try X")
  await assert.rejects(
    generateStructured(
      { provider: "openai", apiKey: "SYN-KEY", model: "gpt-4o-mini", prompt: "SYN-Hi", fetchFn: openAiOk('{"nope":true}') },
      (v): v is { kind: string } => typeof (v as { kind?: unknown })?.kind === "string",
    ),
    /schema validation/,
  )
  await assert.rejects(
    generateStructured(
      { provider: "openai", apiKey: "SYN-KEY", model: "gpt-4o-mini", prompt: "SYN-Hi", fetchFn: openAiOk('not json{{') },
      (v): v is { kind: string } => typeof (v as { kind?: unknown })?.kind === "string",
    ),
    /valid JSON/,
  )
})

test("unsupported reasoning params are never sent for models without support", async () => {
  let sentBody = ""
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentBody = String(init?.body)
    return jsonResponse(200, { choices: [{ message: { content: "SYN-OK" } }], usage: {} })
  }) as typeof fetch
  await generateWithRetries({
    provider: "openai", apiKey: "SYN-KEY", model: "gpt-4o-mini", prompt: "SYN-Hi",
    reasoning: { effort: "high" }, fetchFn,
  }, 1)
  assert.ok(!sentBody.includes("reasoning_effort"), "reasoning param must be dropped for unsupported models")
})

test("timeout and cancellation surface as timeout/cancelled, not generic errors", async () => {
  const hanging = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    // A pre-aborted signal never fires "abort" again — reject like real fetch does.
    if (init?.signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"))
      return
    }
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
  })) as typeof fetch
  try {
    await generateWithRetries({ provider: "zai", apiKey: "SYN-KEY", model: "glm-4-flash", prompt: "SYN-Hi", timeoutMs: 50, fetchFn: hanging }, 1)
    assert.fail("should throw")
  } catch (err) {
    assert.ok(err instanceof ProviderError)
    assert.equal(err.category, "timeout")
  }
  const controller = new AbortController()
  controller.abort()
  try {
    await generateWithRetries({ provider: "zai", apiKey: "SYN-KEY", model: "glm-4-flash", prompt: "SYN-Hi", signal: controller.signal, timeoutMs: 5000, fetchFn: hanging }, 1)
    assert.fail("should throw")
  } catch (err) {
    assert.ok(err instanceof ProviderError)
    assert.equal(err.category, "cancelled")
  }
})

test("retryable failures retry, auth failures do not", async () => {
  let calls = 0
  const flaky = (async () => {
    calls += 1
    if (calls === 1) return jsonResponse(500, "boom")
    return jsonResponse(200, { choices: [{ message: { content: "SYN-Recovered" } }], usage: {} })
  }) as typeof fetch
  const res = await generateWithRetries({ provider: "openai", apiKey: "SYN-KEY", model: "gpt-4o-mini", prompt: "SYN-Hi", fetchFn: flaky }, 2)
  assert.equal(res.text, "SYN-Recovered")
  assert.equal(calls, 2)

  let authCalls = 0
  const authFail = (async () => {
    authCalls += 1
    return jsonResponse(401, { error: { message: "bad key" } })
  }) as typeof fetch
  await assert.rejects(generateWithRetries({ provider: "openai", apiKey: "SYN-KEY", model: "gpt-4o-mini", prompt: "SYN-Hi", fetchFn: authFail }, 3), /Authentication/)
  assert.equal(authCalls, 1)
})

test("fallback tries candidates in order and throws the last error", async () => {
  const tried: string[] = []
  const fail = (provider: string) => (async () => {
    tried.push(provider)
    return jsonResponse(500, "down")
  }) as typeof fetch
  await assert.rejects(generateWithFallback([
    { provider: "openai", apiKey: "SYN-A", model: "gpt-4o-mini", prompt: "SYN-Hi", fetchFn: fail("openai") },
    { provider: "anthropic", apiKey: "SYN-B", model: "claude-3-5-haiku-20241022", prompt: "SYN-Hi", fetchFn: fail("anthropic") },
  ]), /HTTP 500/)
  // Each candidate is retried (bounded) before falling through to the next.
  assert.deepEqual(tried, ["openai", "openai", "anthropic", "anthropic"])

  const okSecond = await generateWithFallback([
    { provider: "openai", apiKey: "SYN-A", model: "gpt-4o-mini", prompt: "SYN-Hi", fetchFn: fail("openai") },
    { provider: "kimi", apiKey: "SYN-B", model: "moonshot-v1-8k", prompt: "SYN-Hi", fetchFn: openAiOk("SYN-Fallback") },
  ])
  assert.equal(okSecond.text, "SYN-Fallback")
})

test("cost estimation uses documented pricing and Unknown otherwise", () => {
  const known = estimateCost("openai", "gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 1_000_000 })
  assert.equal(known.estimatedUsd, 0.75)
  assert.match(known.provenance, /estimate/i)
  const unknown = estimateCost("meta", "muse-spark-1.3", { inputTokens: 100, outputTokens: 50 })
  assert.equal(unknown.estimatedUsd, null)
  assert.match(unknown.provenance, /Unknown/)
})

test("model discovery falls back to the catalog when the API is unreachable", async () => {
  const down = (async () => { throw new Error("offline") }) as typeof fetch
  const found = await discoverModels("openai", "SYN-KEY", { fetchFn: down })
  assert.equal(found.source, "catalog")
  assert.ok(found.models.includes("gpt-4o-mini"))
})

test("testConnection makes a genuine low-cost call capped at 16 tokens", async () => {
  let maxTokens = 0
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    maxTokens = Number((JSON.parse(String(init?.body)) as { max_tokens?: unknown }).max_tokens)
    return jsonResponse(200, { choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 8, completion_tokens: 1 } })
  }) as typeof fetch
  const res = await testConnection({ provider: "openai", apiKey: "SYN-KEY", model: "gpt-4o-mini", fetchFn })
  assert.equal(res.ok, true)
  assert.equal(maxTokens, 16)
  assert.equal(res.usage.outputTokens, 1)
})
