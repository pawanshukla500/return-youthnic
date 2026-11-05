/**
 * AI Center engine HTTP surface (M6).
 *
 * All routes require an operator sign-in (the engine dashboard gate) and run
 * in the privileged desktop process, so provider keys never cross a process
 * boundary and never appear in renderer state beyond the immediate submission.
 * Responses carry `hasKey` booleans and error categories — never key material.
 */

import type http from "node:http"
import { PROVIDER_CATALOG, PROVIDER_CATALOG_VERSION, discoverModels, type ProviderId } from "./ai-providers.js"
import {
  hasProviderKey,
  readProviderPrefs,
  recordProviderError,
  recordProviderSuccess,
  removeProviderKey,
  revealProviderKey,
  saveProviderKey,
  writeProviderPrefs,
} from "./ai-provider-store.js"
import { testProviderConnection } from "./ai-center-assist.js"
import { loadRoutingConfig, readActivity, saveRoutingConfig } from "./ai-center-store.js"
import { readUsage, summarizeUsage } from "./ai-usage-store.js"
import { loadRtdbConfig } from "./ai-firebase.js"
import { localEncryptionAvailable } from "./local-secrets.js"
import { AI_TASK_LABELS, AI_TASKS } from "./ai-routing.js"

export type AiCenterRouteCtx = {
  operatorSignedIn: boolean
  dir: string
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void
  readJson: (req: http.IncomingMessage) => Promise<Record<string, unknown>>
}

const PROVIDER_IDS = PROVIDER_CATALOG.map((e) => e.id)

function isProviderId(value: string): value is Exclude<ProviderId, "gateway"> {
  return (PROVIDER_IDS as string[]).includes(value)
}

export async function handleAiCenterRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: AiCenterRouteCtx,
): Promise<boolean> {
  const path = url.pathname
  if (!path.startsWith("/api/v1/ai-center")) return false
  if (!ctx.operatorSignedIn) {
    ctx.sendJson(res, 401, { error: "Sign in before using the AI Center." })
    return true
  }
  const dir = ctx.dir

  if (path === "/api/v1/ai-center/catalog" && req.method === "GET") {
    ctx.sendJson(res, 200, {
      version: PROVIDER_CATALOG_VERSION,
      tasks: AI_TASKS.map((t) => ({ id: t, label: AI_TASK_LABELS[t] })),
      providers: PROVIDER_CATALOG.map((e) => ({
        id: e.id,
        name: e.name,
        docUrl: e.docUrl,
        transport: e.transport,
        defaultModel: e.defaultModel,
        models: e.models,
        pricing: e.pricing,
      })),
    })
    return true
  }

  if (path === "/api/v1/ai-center/providers" && req.method === "GET") {
    ctx.sendJson(res, 200, {
      encryptionAvailable: localEncryptionAvailable(),
      rtdbConfigured: loadRtdbConfig() !== null,
      providers: PROVIDER_CATALOG.map((e) => {
        const prefs = readProviderPrefs(dir, e.id)
        return {
          id: e.id,
          name: e.name,
          hasKey: hasProviderKey(dir, e.id),
          defaultModel: prefs.defaultModel || e.defaultModel,
          baseUrlOverride: prefs.baseUrlOverride,
          lastSuccessAt: prefs.lastSuccessAt,
          lastError: prefs.lastError,
          lastErrorCategory: prefs.lastErrorCategory,
        }
      }),
    })
    return true
  }

  const providerMatch = path.match(/^\/api\/v1\/ai-center\/providers\/([a-z]+)(?:\/(key|test|models|prefs))?$/)
  if (providerMatch) {
    const provider = providerMatch[1]
    const action = providerMatch[2] ?? ""
    if (!isProviderId(provider)) {
      ctx.sendJson(res, 404, { error: "Unknown provider." })
      return true
    }
    if (action === "key" && req.method === "POST") {
      try {
        const body = await ctx.readJson(req)
        const key = String(body.key || "")
        if (!key) {
          ctx.sendJson(res, 400, { error: "An API key is required." })
          return true
        }
        const saved = saveProviderKey(dir, provider, key)
        // Clear the submitted value from memory as soon as it is stored.
        body.key = ""
        ctx.sendJson(res, 200, { ok: true, hasKey: true, encrypted: saved.encrypted })
      } catch (error) {
        ctx.sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not save the key." })
      }
      return true
    }
    if (action === "key" && req.method === "DELETE") {
      const removed = removeProviderKey(dir, provider)
      ctx.sendJson(res, 200, { ok: true, removed: removed.removed, hasKey: false })
      return true
    }
    if (action === "test" && req.method === "POST") {
      const body = (await ctx.readJson(req).catch(() => ({}))) as Record<string, unknown>
      const prefs = readProviderPrefs(dir, provider)
      const model = String(body.model || prefs.defaultModel || "").trim()
      if (String(body.mode || "") === "sdk") {
        // Vercel AI SDK Core path: proves the packaged app runs the official
        // generateText + @ai-sdk/* integrations against the real provider API.
        const { generateTextViaSdk } = await import("./ai-sdk-bridge.js")
        const apiKey = revealProviderKey(dir, provider)
        if (!apiKey) {
          ctx.sendJson(res, 400, { ok: false, category: "authentication", error: "No API key stored for this provider." })
          return true
        }
        try {
          const sdkRes = await generateTextViaSdk({ provider, apiKey, model, prompt: "Reply with the single word OK.", maxTokens: 16, baseUrl: prefs.baseUrlOverride || undefined })
          recordProviderSuccess(dir, provider)
          ctx.sendJson(res, 200, { ok: true, mode: "sdk", model, text: sdkRes.text })
        } catch (err) {
          const category = (err as { category?: string })?.category ?? "unknown"
          const message = err instanceof Error ? err.message : String(err)
          recordProviderError(dir, provider, message, category)
          ctx.sendJson(res, 400, { ok: false, mode: "sdk", category, error: message.slice(0, 300) })
        }
        return true
      }
      const result = await testProviderConnection(dir, provider, model)
      body.model = ""
      if (result.ok) ctx.sendJson(res, 200, { ok: true, latencyMs: result.latencyMs, usage: result.usage })
      else ctx.sendJson(res, 400, { ok: false, category: result.category, error: result.message })
      return true
    }
    if (action === "models" && req.method === "GET") {
      const apiKey = revealProviderKey(dir, provider)
      const prefs = readProviderPrefs(dir, provider)
      const found = await discoverModels(provider, apiKey ?? "", { baseUrl: prefs.baseUrlOverride || undefined })
      ctx.sendJson(res, 200, { models: found.models, source: found.source })
      return true
    }
    if (action === "prefs" && req.method === "POST") {
      try {
        const body = await ctx.readJson(req)
        writeProviderPrefs(dir, provider, {
          defaultModel: String(body.defaultModel || "").slice(0, 120),
          baseUrlOverride: String(body.baseUrlOverride || "").slice(0, 300),
        })
        ctx.sendJson(res, 200, { ok: true })
      } catch (error) {
        ctx.sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not save preferences." })
      }
      return true
    }
    ctx.sendJson(res, 404, { error: "Unknown AI Center provider action." })
    return true
  }

  if (path === "/api/v1/ai-center/routing" && req.method === "GET") {
    ctx.sendJson(res, 200, { routing: loadRoutingConfig(dir) })
    return true
  }

  if (path === "/api/v1/ai-center/routing" && req.method === "POST") {
    try {
      const body = await ctx.readJson(req)
      const routing = saveRoutingConfig(dir, body.routing ?? body)
      ctx.sendJson(res, 200, { ok: true, routing })
    } catch (error) {
      ctx.sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not save routing." })
    }
    return true
  }

  if (path === "/api/v1/ai-center/usage" && req.method === "GET") {
    const from = url.searchParams.get("from") || undefined
    const to = url.searchParams.get("to") || undefined
    let records = readUsage(dir, 2000)
    if (from) records = records.filter((r) => r.at >= from)
    if (to) {
      const toBound = to.length === 10 ? `${to}T23:59:59.999Z` : to
      records = records.filter((r) => r.at <= toBound)
    }
    ctx.sendJson(res, 200, { summary: summarizeUsage(records), records: records.slice(-200).reverse() })
    return true
  }

  if (path === "/api/v1/ai-center/activity" && req.method === "GET") {
    ctx.sendJson(res, 200, { activity: readActivity(dir, 100) })
    return true
  }

  ctx.sendJson(res, 404, { error: "Unknown AI Center route." })
  return true
}
