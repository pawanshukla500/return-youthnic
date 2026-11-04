import type { EngineErrorBody } from '../types/engine'

/**
 * Typed fetch client for the claim engine HTTP API.
 *
 * Base URL: the shell's preload bridge answers `getEngineTarget()` with the
 * engine the Electron main process started (local `http://127.0.0.1:3005`) or
 * a remote target. The resolved base is cached for the renderer's lifetime;
 * plain-browser dev falls back to the local engine URL.
 *
 * REMOTE AUTH: for a remote (non-loopback) engine the Electron shell injects
 * `Authorization: Bearer <ENGINE_TOKEN>` through its webRequest hook before
 * the request leaves the app. The token intentionally never reaches this
 * renderer — do not add an Authorization header here, and never accept a
 * token from renderer-visible state.
 */

const LOCAL_ENGINE_BASE = 'http://127.0.0.1:3005'

let cachedBase: Promise<string> | null = null

export function resolveEngineBase(): Promise<string> {
  if (!cachedBase) {
    cachedBase = (async () => {
      try {
        const target = await window.desktopApp?.getEngineTarget()
        const url = target?.url?.trim()
        if (url) return url.replace(/\/+$/, '')
      } catch {
        // Bridge missing or shell busy: fall back to the local engine below.
      }
      return LOCAL_ENGINE_BASE
    })()
  }
  return cachedBase
}

/** Re-resolve the base (e.g. after the shell retargets the engine). */
export function invalidateEngineBase(): void {
  cachedBase = null
}

export class EngineApiError extends Error {
  readonly status: number
  readonly body: EngineErrorBody | null

  constructor(status: number, message: string, body: EngineErrorBody | null = null) {
    super(message)
    this.name = 'EngineApiError'
    this.status = status
    this.body = body
  }
}

/** True when the engine answered 401 — the operator must sign in again. */
export function isSessionError(error: unknown): error is EngineApiError {
  return error instanceof EngineApiError && error.status === 401
}

/** True when the engine could not be reached at all (connection refused, DNS, offline). */
export function isNetworkError(error: unknown): error is EngineApiError {
  return error instanceof EngineApiError && error.status === 0
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!path.startsWith('/')) path = `/${path}`
  const base = await resolveEngineBase()
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (cause) {
    // Fetch rejected (ECONNREFUSED, unreachable host, ...): the engine is down.
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new EngineApiError(0, `Cannot reach the claim engine at ${base} (${message}).`, null)
  }
  if (!res.ok) {
    let parsed: EngineErrorBody | null = null
    try {
      parsed = (await res.json()) as EngineErrorBody
    } catch {
      parsed = null
    }
    throw new EngineApiError(res.status, parsed?.error || `The engine answered HTTP ${res.status}.`, parsed)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path)
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body ?? {})
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path)
}
