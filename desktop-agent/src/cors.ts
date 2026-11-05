/**
 * CORS allowlist for the engine HTTP API.
 *
 * The packaged desktop renderer is a cross-origin client: it runs at
 * `returnapp://desktop` and calls the engine at http://127.0.0.1:3005 with
 * fetch/EventSource, so the engine must answer preflights and echo an allowed
 * origin on responses. The rules are deliberately narrow:
 *
 *   - Only `returnapp://desktop` is ever allowed in production.
 *   - In development the Vite dev server origins join the list.
 *   - ENGINE_CORS_ORIGINS may add exact origins (comma-separated), parsed
 *     leniently: junk entries are skipped, `*` is never honoured, and entries
 *     are normalized to their URL origin so a trailing slash still matches.
 *   - Anything else, a missing Origin, or a null origin gets no CORS headers
 *     at all: the request proceeds exactly as it did before CORS existed.
 *
 * The allow-origin is never `*` and never reflects an arbitrary request
 * origin, so a hostile website cannot read engine responses from a browser.
 */

/** The packaged renderer's privileged custom-scheme origin. */
export const DESKTOP_RENDERER_ORIGIN = "returnapp://desktop"

/** Vite dev server origins, allowed only while dev is true. */
export const DEV_RENDERER_ORIGINS: readonly string[] = ["http://localhost:5180", "http://127.0.0.1:5180"]

export const CORS_ALLOW_METHODS = "GET,POST,DELETE,OPTIONS"
export const CORS_ALLOW_HEADERS = "Content-Type, Authorization"

export type CorsOptions = {
  /**
   * Extra allowed origins: either the raw ENGINE_CORS_ORIGINS value
   * (comma-separated) or an already-split list. Parsed leniently; `*` and
   * unparsable entries are skipped.
   */
  extraOrigins?: string | string[]
  /** True outside production: also allows the Vite dev server origins. */
  dev: boolean
}

function normalizeOriginEntry(entry: string): string | null {
  const trimmed = entry.trim()
  if (!trimmed || trimmed === "*") return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  // Only genuine http(s) origins can reach the engine API. Non-special
  // schemes (returnapp://, file:, ...) do not get a real origin from the
  // WHATWG URL parser, so this also rejects opaque-origin entries.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  if (parsed.origin === "null") return null
  // An origin has no path, query or fragment; reject entries that carry any.
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null
  return parsed.origin
}

function splitExtraOrigins(extraOrigins: string | string[] | undefined): string[] {
  const raw = Array.isArray(extraOrigins) ? extraOrigins : extraOrigins ? extraOrigins.split(",") : []
  const allowed: string[] = []
  for (const entry of raw) {
    const normalized = normalizeOriginEntry(entry)
    if (normalized && !allowed.includes(normalized)) allowed.push(normalized)
  }
  return allowed
}

/**
 * Returns the single origin allowed to read this response, or null when the
 * request origin is not on the allowlist (including a null/empty origin,
 * which means "not a CORS request" and must receive no CORS headers).
 */
export function corsAllowedOrigin(requestOrigin: string | null, opts: CorsOptions): string | null {
  const origin = (requestOrigin || "").trim()
  if (!origin) return null
  if (origin === DESKTOP_RENDERER_ORIGIN) return origin
  if (opts.dev && DEV_RENDERER_ORIGINS.includes(origin)) return origin
  if (splitExtraOrigins(opts.extraOrigins).includes(origin)) return origin
  return null
}

/**
 * The CORS headers set on every engine response when (and only when) the
 * request origin is allowed. Credentials are never shared cross-origin and
 * the allowlist is single-origin, so `Access-Control-Allow-Credentials` stays
 * false and `Vary: Origin` keeps caches honest about it.
 */
export function corsHeadersFor(allowedOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Allow-Credentials": "false",
    "Vary": "Origin",
  }
}
