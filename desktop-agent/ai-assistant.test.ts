// Checks for the local AI orchestration core: disabled-by-default config,
// safe-action validation (never invent, never bypass, never submit), bounded
// retries that degrade to human review, and metadata-only usage tracking.

import test from "node:test"
import assert from "node:assert/strict"
import {
  aiUsageSnapshot,
  buildDiagnosticPrompt,
  GatewayProvider,
  loadAiAssistConfig,
  providerFromConfig,
  requestAiProposal,
  resetAiUsageForTests,
  validateAiProposal,
  type AssistanceContext,
  type AiProvider,
} from "./src/ai-assistant.ts"

const CTX: AssistanceContext = {
  marketplace: "Meesho",
  claimId: 42,
  knownTicketId: "SYN-TICKET-1",
  step: "submit",
  errorSignature: "claim button not found",
}

test("AI assistance is off until the operator opts in", () => {
  const clean = loadAiAssistConfig({} as NodeJS.ProcessEnv)
  assert.equal(clean.enabled, false)
  assert.equal(clean.maxCallsPerJob, 2)
  assert.equal(clean.timeoutMs, 20000)
  assert.equal(providerFromConfig(clean), null)
})

test("gateway provider needs an explicit URL and token", () => {
  const configured = loadAiAssistConfig({
    AI_ASSIST_ENABLED: "1",
    AI_GATEWAY_URL: "https://gateway.example",
    AI_GATEWAY_TOKEN: "syn-token",
    AI_MODEL_NAME: "syn-model",
    AI_MAX_CALLS_PER_JOB: "3",
    AI_TIMEOUT_MS: "5000",
  } as NodeJS.ProcessEnv)
  assert.equal(configured.enabled, true)
  assert.equal(configured.maxCallsPerJob, 3)
  assert.ok(providerFromConfig(configured) instanceof GatewayProvider)
  assert.throws(() => new GatewayProvider("", "token", "model", 1000), /AI_GATEWAY_URL/)
  assert.throws(() => new GatewayProvider("https://x.example", "", "model", 1000), /AI_GATEWAY_TOKEN/)
})

test("only safe, evidence-grounded proposals validate", () => {
  assert.equal(
    validateAiProposal({ kind: "suggest_selector", summary: "SYN-Try the secondary submit button." }, CTX),
    true,
  )
  // Sending, submitting, auth bypass, and code changes are never safe.
  for (const kind of ["submit_claim", "send_response", "bypass_captcha", "edit_source", "run_sql", ""]) {
    assert.equal(validateAiProposal({ kind, summary: "SYN-Do it." }, CTX), false, kind || "(blank)")
  }
  // The model must never invent a ticket reference.
  assert.equal(
    validateAiProposal(
      { kind: "draft_response", summary: "SYN-Draft.", ticketRef: "SYN-TICKET-9" },
      CTX,
    ),
    false,
  )
  assert.equal(
    validateAiProposal(
      { kind: "draft_response", summary: "SYN-Draft.", ticketRef: "SYN-TICKET-1" },
      CTX,
    ),
    true,
  )
  assert.equal(validateAiProposal({ kind: "retry_step", summary: "  " }, CTX), false)
  assert.equal(validateAiProposal({ kind: "retry_step", summary: "x".repeat(2001) }, CTX), false)
})

test("no provider means no call and no throw", async () => {
  resetAiUsageForTests()
  assert.equal(await requestAiProposal(null, { prompt: "SYN-Hello" }, 2), null)
  assert.equal(aiUsageSnapshot().calls, 0)
})

test("retries are bounded and failures degrade to human review", async () => {
  resetAiUsageForTests()
  let calls = 0
  const failing: AiProvider = {
    generateText: async () => {
      calls += 1
      throw new Error("SYN-Gateway down")
    },
  }
  assert.equal(await requestAiProposal(failing, { prompt: "SYN-Hello" }, 2), null)
  assert.equal(calls, 2)
  assert.equal(aiUsageSnapshot().failures, 2)
})

test("attempts never exceed the cap even when asked for more", async () => {
  resetAiUsageForTests()
  let calls = 0
  const failing: AiProvider = {
    generateText: async () => {
      calls += 1
      throw new Error("SYN-Still down")
    },
  }
  assert.equal(await requestAiProposal(failing, { prompt: "SYN-Hello" }, 99), null)
  assert.equal(calls, 3)
})

test("a recovery on retry returns the text", async () => {
  resetAiUsageForTests()
  let calls = 0
  const flaky: AiProvider = {
    generateText: async () => {
      calls += 1
      if (calls === 1) throw new Error("SYN-Blip")
      return { text: "SYN-Try the secondary selector." }
    },
  }
  assert.equal(await requestAiProposal(flaky, { prompt: "SYN-Hello" }, 2), "SYN-Try the secondary selector.")
})

test("diagnostic prompts carry context, never credentials", () => {
  const prompt = buildDiagnosticPrompt(CTX, "SYN-Extra note here.")
  assert.match(prompt, /Meesho/)
  assert.match(prompt, /SYN-TICKET-1/)
  assert.match(prompt, /claim button not found/)
  assert.match(prompt, /SYN-Extra note here/)
  assert.doesNotMatch(prompt, /token/i)
})
