# AI Center (M6): operator-owned multi-provider AI in the desktop engine

Status: implemented on `feature/windows-ai-center-m6`, awaiting review/merge.
Rule 12 (APK sync) untouched: no mobile or scanning behavior changed.

## What it is

The engine dashboard gains an **AI Center** section (Providers, Routing,
Agents, Usage & Costs, Learning & Memory). The operator stores their own
LLM keys (six providers), tests them with a real low-cost call, assigns
models per task, and watches tokens/costs. The claim worker uses AI only as
`deterministic → approved memory → low-cost model → stronger model → human
review`, advisory-only, never blocking claim processing.

## Provider catalog (versioned)

`desktop-agent/src/ai-providers.ts`, `PROVIDER_CATALOG_VERSION = 1`.
Only confirmed API model IDs are sent; marketing names are UI aliases only.
`verified: false` entries (`muse-spark-1.3`, `muse-spark-1.3-contributor`,
`glm-5.3-flash`) are operator-requested names awaiting provider confirmation
via Test Connection / model discovery. Pricing shows "Unknown" where no
public per-token page was confirmed — never fabricated.

- Direct HTTPS from the privileged desktop process (injectable `fetchFn`,
  bounded timeouts/retries, typed `ProviderError` categories, token-usage
  extraction, cost estimates with provenance, fallback).
- Vercel AI SDK Core (`ai` + `@ai-sdk/openai|anthropic|google`) is a
  dependency and is wired: `ai-sdk-bridge.ts` (`generateTextViaSdk`) backs
  the Test Connection `sdk` mode, and the esbuild desktop bundle includes it
  (desktop/dist/main.cjs ≈ 2.1 MB with the SDK, ≈ 0.3 MB without).
- Reasoning params attach only for models advertising support.

## Secure keys

`ai-provider-store.ts`: keys in `AGENT_DATA_DIR/ai-providers.json` encrypted
with `protectSecret` (DPAPI in the packaged app); prefs (default model,
base-URL override, last success/error) in `ai-provider-prefs.json`.
UI sees `hasKey` booleans only; keys never log, never touch query strings,
marketplace pages, or Firebase. Save without OS encryption fails closed
unless `AI_CENTER_ALLOW_PLAINTEXT=1` (dev/tests).

## Worker wiring

`runRoutedAssist()` (`ai-center-assist.ts`) is tried first in
`runFollowUpAssist()` when the decider says `ai-needed`; the legacy
`AI_GATEWAY_*` provider remains as fallback, then human review. Every model
draft passes `validateAiProposal`; usage + activity are recorded locally and
reported to Postgres (`reportAgentRun`/`reportUsage`, best-effort); Firebase
RTDB gets a `{type, at, ref, detail}` hint only.

## Memory: local, Postgres, Firebase

- Local: existing `ai-memory.json` untouched; new `ai-routing.json`,
  `ai-activity.jsonl`, `ai-pending-sync.json`, `ai-usage.jsonl` in
  `AGENT_DATA_DIR`. Restart marks unfinished activity `interrupted`.
  SQLite evaluated: rejected — JSONL + atomic JSON writes already cover the
  volumes and survive packaging without native modules.
- Postgres (`schema-ai-center.sql`, additive): `ai_provider_usage`,
  `ai_agent_runs`, plus `version`/`confidence`/`last_verified_at` columns on
  `ai_memory_procedures`. Outcomes adjust confidence on approved rows only;
  pending → approved still goes through the validated transition.
- Firebase RTDB (`ai-firebase.ts`): optional `PUT` of sync hints
  (`FIREBASE_RTDB_URL` + `FIREBASE_RTDB_AUTH`); offline/unconfigured =
  silent false, Postgres stays authoritative.

## Verification

- `npm run typecheck` (3 projects), desktop esbuild bundle.
- New suites in `npm test`: `ai-providers` (mocked 6-provider contract),
  `ai-center` (routing/usage/store/firebase/sdk/security),
  `ai-center-ui` (dashboard ↔ route contract), `ai-center-assist`
  (Scenarios A–I subset), `ai-providers-live` (NOT EXECUTED without keys),
  `server/tests/ai-center-store` (SQL shapes + migration guards).
- Live inference, Firebase sync, and installer runs need operator keys /
  hardware and are marked accordingly in the PR.
