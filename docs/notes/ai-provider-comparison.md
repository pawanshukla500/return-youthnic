# AI Provider Comparison — Marketplace Claim Reply Service

Status: **design only, no provider committed** (2026-10-21)

The brief asks for AI-assisted claim replies with persistent claim memory, rejection
analysis and follow-up intelligence. No LLM integration exists in this repository yet.
This note compares the realistic options and records the cost model, so the provider can
be chosen deliberately rather than by default.

---

## 1. Where the AI fits

The AI is **not** allowed to invent claim facts or evidence (`AGENTS.md` rule 11 and the
brief's own constraint). Its job is narrow and grounded:

1. **Draft a reply** to a marketplace message, using only the stored claim record:
   claim history, evidence metadata (photos/videos on file), earlier marketplace messages,
   earlier AI/human replies, rejection reason, deadlines.
2. **Classify a rejection** into a known reason and suggest the appeal path.
3. **Summarise** a long claim thread for the operator.
4. **Draft a follow-up** when a response deadline is approaching.

Everything else stays human. The default posture is **draft → human approves → send**.
Auto-send is opt-in per claim type, never global, and never for a dispute or appeal.

### Where it must live

**Server-side**, inside the existing Express backend, not inside the desktop application.
Reason: the API key is a secret, and rule 8 forbids secrets in the desktop app or its
config. The engine and the UI call the backend; the backend calls the provider.

---

## 2. Candidate providers

Prices are the public list prices as understood at the time of writing and **must be
re-verified before purchase**; they change often. The columns that matter for this
workload are input cost, output cost, and whether the provider offers a cheap
prompt-caching tier, because every request re-sends the claim's history and the
marketplace procedure text.

| Provider | Strong general model | Cheapest capable tier | Prompt caching | Notes |
|---|---|---|---|---|
| **Anthropic (Claude)** | Claude Sonnet-class | Claude Haiku-class | Yes, explicit cache breakpoints | Excellent at long, instruction-heavy document reasoning and refusal discipline ("do not invent facts"). Caching is a good fit for a repeated claim-history preamble. |
| **OpenAI (GPT)** | GPT-4-class | GPT-4o-mini / nano class | Yes, automatic | Largest ecosystem, simplest SDK, strong structured-output support. Automatic caching needs no extra work. |
| **Google (Gemini)** | Gemini Pro-class | Gemini Flash / Flash-Lite | Yes, explicit | Very cheap at the Flash tier with a large context window; useful if a claim thread plus evidence manifest grows large. |
| **Meta (Llama)** | Llama 3.x 70B via a host | Llama 3.x 8B | Host-dependent | Open weights, so no per-token fee — but you pay for GPU hosting, and quality at the small sizes is below the hosted frontier models for nuanced dispute replies. Only worth it if data residency or a hard no-third-party requirement applies. |
| **Self-hosted open model (Mistral, Qwen)** | — | — | — | Same trade-off as Llama: fixed infra cost, lower quality ceiling, full data control. |

### Cost shape (why the tier matters more than the brand)

A claim reply request is roughly:

- **Input:** ~2 000–6 000 tokens (claim history + procedure text + evidence manifest).
- **Output:** ~200–600 tokens (one reply, or a classification).

At a few hundred claims a month with a handful of messages each, the workload is on the
order of a few million input tokens and well under a million output tokens per month. At
that volume:

- a **small/fast tier** (Haiku, mini, Flash) lands in the low single-digit dollars per
  month;
- a **frontier tier** for every request would cost roughly 10–30× more for little gain,
  because the task is extraction-and-rewrite against supplied context, not open reasoning.

**Recommended cost strategy:** small/fast tier by default; escalate to a frontier tier
only for appeals and rejections the operator flags as sensitive. Enable prompt caching on
the claim-history preamble. Cap output tokens per request. Log token usage per claim so
cost is attributable.

### Recommendation

Start with **one provider behind an adapter** and make the adapter the only place a
provider name appears. Two are worth wiring first, in this order:

1. **OpenAI** — simplest integration, automatic caching, strong structured output.
2. **Anthropic** — better refusal discipline on "never invent facts", explicit caching.

Keep **Gemini Flash** as the cheap-tier alternative and **Llama/self-hosted** as the
data-residency fallback. The adapter interface below makes any of them a drop-in.

---

## 3. Provider-agnostic design (not yet implemented)

```
server/ai/
  provider.ts        // AiProvider interface + registry
  providers/
    openai.ts        // one file per provider, added when the key exists
    anthropic.ts
  claim-context.ts   // builds the grounded context from claim records
  claim-reply.ts     // draft / classify / summarise / follow-up
  prompts.ts         // versioned prompt templates
```

```ts
export type AiDraft = {
  text: string
  confidence: "low" | "medium" | "high"
  usedEvidenceIds: number[]
  requiresHumanApproval: boolean
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
}

export type AiProvider = {
  name: string
  /** Draft a grounded reply. Must never introduce a fact absent from the context. */
  draftReply(input: ClaimReplyInput): Promise<AiDraft>
  classifyRejection(input: ClaimReplyInput): Promise<RejectionClassification>
}
```

Additive schema (no drops, `SCHEMA_VERSION` unchanged):

- `claim_ai_drafts` — `id`, `claim_id`, `kind`, `draft_text`, `provider`, `model`,
  `input_tokens`, `output_tokens`, `confidence`, `requires_human_approval`,
  `approved_by`, `approved_at`, `sent_at`, `created_at`.
- `claim_ai_settings` — per-claim-type auto-send policy (default: never auto-send).

Rules the implementation must enforce:

1. The context builder only reads stored claim data. If a fact is not stored, the draft
   must not assert it.
2. Every draft is written to `claim_ai_drafts` before it can be sent. Nothing is sent
   without a row.
3. Auto-send requires an explicit per-type policy row **and** `confidence = "high"`.
   Rejections and appeals always require a human.
4. The API key is read from the server environment only, never logged, never returned by
   any route.

---

## 4. UI surface (planned)

- **AI Response Approval Center** in the claims workspace: pending drafts, the grounded
  context each draft used, edit-before-send, approve/reject.
- **Rejection analysis** panel on a claim: classified reason + suggested appeal.
- **Cost/usage** column per claim so spend is visible.

---

## 5. What is done vs. not

- **Done:** this comparison, the adapter interface sketch, the schema sketch, the
  security rules.
- **Not done:** any provider implementation, any API key wiring, any schema migration,
  any UI. No LLM call has been made from this repository.
