/**
 * Firebase Realtime Database notifier (M6) — lightweight sync signals only.
 *
 * PostgreSQL stays authoritative. RTDB carries no credentials, no claim
 * bodies, no executable procedures — only `{ type, at, ref }` hints that
 * tell other operator PCs to run an authenticated refresh against the
 * backend. When Firebase is unconfigured or unreachable, local operation
 * and Postgres sync continue silently (fail-open for sync, fail-closed
 * for secrets which never go here).
 */

export type SyncSignalType = "agent_status" | "task_changed" | "procedures_updated" | "procedure_revoked" | "memory_synced"

export type SyncSignal = {
  type: SyncSignalType
  at: string
  /** Opaque reference: claim id, task id, or procedure id — never PII. */
  ref: string
  detail: string
}

export type FirebaseRtdbConfig = {
  databaseUrl: string
  /** Device/auth token for the RTDB rules; from env, never stored in UI prefs. */
  auth: string
}

export function loadRtdbConfig(env: NodeJS.ProcessEnv = process.env): FirebaseRtdbConfig | null {
  const databaseUrl = String(env.FIREBASE_RTDB_URL || env.FIREBASE_DATABASE_URL || "").trim().replace(/\/+$/, "")
  if (!databaseUrl) return null
  return { databaseUrl, auth: String(env.FIREBASE_RTDB_AUTH || "") }
}

function signalPath(signal: SyncSignal): string {
  return `ai-center/signals/${signal.type}.json`
}

/** Best-effort push; resolves false (not throw) when unconfigured/offline. */
export async function pushSignal(
  config: FirebaseRtdbConfig | null,
  signal: SyncSignal,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<boolean> {
  if (!config) return false
  const safe: SyncSignal = {
    type: signal.type,
    at: signal.at,
    ref: String(signal.ref || "").slice(0, 80),
    detail: String(signal.detail || "").slice(0, 200),
  }
  const url = `${config.databaseUrl}/${signalPath(signal)}${config.auth ? `?auth=${encodeURIComponent(config.auth)}` : "?"}`
  try {
    const res = await fetchFn(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(safe),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

export function isSensitiveForRtdb(value: string): boolean {
  return /api[_-]?key|bearer|passwd|password|secret|token|cookie|otp|captcha/i.test(value)
}
