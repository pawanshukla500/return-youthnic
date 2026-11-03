import fs from "node:fs"
import path from "node:path"
import { ensureAgentDataDir, writeSecretFile } from "./paths.js"
import { localEncryptionAvailable, protectSecret, revealSecret } from "./local-secrets.js"
import type { ProviderId } from "./ai-providers.js"

/**
 * AI Center provider credential + preference store (M6).
 *
 * - Credentials: one DPAPI-encrypted entry per provider in
 *   `AGENT_DATA_DIR/ai-providers.json` ({ provider: "dpapi:..." }).
 * - Preferences (default model, base-URL override): separate file
 *   `AGENT_DATA_DIR/ai-provider-prefs.json` — never mixed with secrets.
 * - The UI only learns `hasKey`; raw keys never leave this module except
 *   to the provider HTTPS call itself. Keys are never logged, never put in
 *   query strings, never synced to Firebase.
 * - Fail-closed: saving refuses plaintext when the OS store is unavailable
 *   unless `AI_CENTER_ALLOW_PLAINTEXT=1` (dev/test only).
 */

export const PROVIDER_STORE_FILE = "ai-providers.json"
export const PROVIDER_PREFS_FILE = "ai-provider-prefs.json"

export type ProviderStatus = {
  provider: ProviderId
  hasKey: boolean
  defaultModel: string
  baseUrlOverride: string
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorCategory: string | null
}

function storePath(dir: string): string {
  return path.join(dir, PROVIDER_STORE_FILE)
}

function prefsPath(dir: string): string {
  return path.join(dir, PROVIDER_PREFS_FILE)
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function plaintextAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.AI_CENTER_ALLOW_PLAINTEXT || "").trim() === "1"
}

export function saveProviderKey(dir: string, provider: ProviderId, apiKey: string, env: NodeJS.ProcessEnv = process.env): { ok: true; encrypted: boolean } {
  const key = String(apiKey || "")
  if (!key) throw new Error("An API key is required.")
  if (!localEncryptionAvailable() && !plaintextAllowed(env)) {
    throw new Error("Secure credential storage is unavailable on this machine, so the key was not saved. Sign in from the packaged Windows app where DPAPI is available.")
  }
  ensureAgentDataDir()
  const file = storePath(dir)
  const current = readJson(file)
  current[provider] = protectSecret(key)
  writeSecretFile(file, JSON.stringify(current))
  return { ok: true as const, encrypted: String(current[provider]).startsWith("dpapi:") }
}

export function removeProviderKey(dir: string, provider: ProviderId): { ok: true; removed: boolean } {
  const file = storePath(dir)
  const current = readJson(file)
  const existed = typeof current[provider] === "string" && String(current[provider]).length > 0
  delete current[provider]
  ensureAgentDataDir()
  writeSecretFile(file, JSON.stringify(current))
  return { ok: true as const, removed: existed }
}

/** Raw key for provider HTTPS calls. Null when missing or undecryptable. */
export function revealProviderKey(dir: string, provider: ProviderId): string | null {
  const stored = readJson(storePath(dir))[provider]
  if (typeof stored !== "string" || !stored) return null
  return revealSecret(stored)
}

export function hasProviderKey(dir: string, provider: ProviderId): boolean {
  return revealProviderKey(dir, provider) !== null
}

export type ProviderPrefs = {
  defaultModel: string
  baseUrlOverride: string
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorCategory: string | null
}

export function readProviderPrefs(dir: string, provider: ProviderId): ProviderPrefs {
  const all = readJson(prefsPath(dir))[provider] as Partial<ProviderPrefs> | undefined
  return {
    defaultModel: typeof all?.defaultModel === "string" ? all.defaultModel : "",
    baseUrlOverride: typeof all?.baseUrlOverride === "string" ? all.baseUrlOverride : "",
    lastSuccessAt: typeof all?.lastSuccessAt === "string" ? all.lastSuccessAt : null,
    lastError: typeof all?.lastError === "string" ? all.lastError : null,
    lastErrorCategory: typeof all?.lastErrorCategory === "string" ? all.lastErrorCategory : null,
  }
}

export function writeProviderPrefs(dir: string, provider: ProviderId, prefs: Partial<ProviderPrefs>): void {
  ensureAgentDataDir()
  const all = readJson(prefsPath(dir))
  all[provider] = { ...readProviderPrefs(dir, provider), ...prefs }
  fs.writeFileSync(prefsPath(dir), JSON.stringify(all))
}

export function recordProviderSuccess(dir: string, provider: ProviderId): void {
  writeProviderPrefs(dir, provider, { lastSuccessAt: new Date().toISOString(), lastError: null, lastErrorCategory: null })
}

export function recordProviderError(dir: string, provider: ProviderId, message: string, category: string): void {
  writeProviderPrefs(dir, provider, { lastError: String(message || "").slice(0, 300), lastErrorCategory: String(category || "unknown").slice(0, 40) })
}
