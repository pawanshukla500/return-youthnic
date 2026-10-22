import { timingSafeEqual } from "node:crypto"

/**
 * Engine bind and remote-access policy.
 *
 * The automation engine is a standalone service, so it must be safe to run in
 * three places: a warehouse PC (loopback only), a Linux server reachable over
 * the network, and a container. The rule is simple and fail-closed:
 *
 *   - Loopback bind (127.0.0.1 / ::1 / localhost) -> local mode, no token.
 *     The operating-system user boundary is the guard.
 *   - Anything else -> remote mode, and ENGINE_TOKEN is mandatory. The engine
 *     refuses to start otherwise, so a reachable engine can never be anonymous.
 *
 * The token is never logged and never written to a config file by this module.
 */

export const DEFAULT_ENGINE_HOST = "127.0.0.1"
export const DEFAULT_ENGINE_PORT = 3005
export const MIN_ENGINE_TOKEN_LENGTH = 24

export type EngineMode = "local" | "remote"

export type EngineBind = {
  host: string
  port: number
  mode: EngineMode
  /** True when the listening socket is reachable from outside this machine. */
  remoteAccess: boolean
  /** Bearer token required on every route except the health probe. Empty in local mode. */
  authToken: string
}

export function isLoopbackHost(host: string): boolean {
  const normalized = (host || "").trim().toLowerCase()
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost"
}

export function parseEnginePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_ENGINE_PORT
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`ENGINE_PORT must be an integer between 1 and 65535 (received "${value}").`)
  }
  return parsed
}

/**
 * Resolve the bind from the environment. Throws when a reachable host is
 * requested without a strong token: the process must exit rather than expose
 * the claim queue and supplier profiles unauthenticated.
 */
export function resolveEngineBind(env: Record<string, string | undefined> = process.env): EngineBind {
  const host = (env.ENGINE_HOST || DEFAULT_ENGINE_HOST).trim() || DEFAULT_ENGINE_HOST
  const port = parseEnginePort(env.ENGINE_PORT)
  const token = (env.ENGINE_TOKEN || "").trim()
  const remoteAccess = !isLoopbackHost(host)

  if (remoteAccess && token.length < MIN_ENGINE_TOKEN_LENGTH) {
    throw new Error(
      `ENGINE_HOST "${host}" is reachable from outside this machine, so ENGINE_TOKEN must be set to at least ` +
        `${MIN_ENGINE_TOKEN_LENGTH} characters. Bind to ${DEFAULT_ENGINE_HOST} for a local-only engine.`,
    )
  }

  return {
    host,
    port,
    mode: remoteAccess ? "remote" : "local",
    remoteAccess,
    authToken: remoteAccess ? token : "",
  }
}

/**
 * Constant-time token check. An empty expected token means "no auth required"
 * (local mode) and always matches.
 */
export function engineTokenMatches(provided: string | null | undefined, expected: string): boolean {
  if (!expected) return true
  if (!provided) return false
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
}

export function bearerTokenFromHeader(header: string | undefined | null): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/** Strip the brackets WHATWG URL keeps around an IPv6 hostname. */
function bareHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "")
}

/**
 * The host a client should dial for a given bind host.
 *
 * A wildcard bind means "every interface" and is not a usable destination:
 * `http://0.0.0.0:3005/` is not routable on Windows or Linux, so opening the
 * dashboard at that URL fails. Map the wildcards to the matching loopback.
 */
export function clientHostForBind(host: string): string {
  const normalized = host.trim().toLowerCase()
  if (normalized === "0.0.0.0") return "127.0.0.1"
  if (normalized === "::" || normalized === "[::]") return "::1"
  return host
}

/**
 * The URL a client uses to reach an engine bound to `bind.host`.
 *
 * The bind host is not always `127.0.0.1`: `ENGINE_HOST=::1` listens on IPv6
 * loopback only, so a client that hardcoded `127.0.0.1` would be refused. IPv6
 * literals also need brackets in a URL, and a wildcard bind has to be dialled at
 * loopback because it is not a destination. Local mode is always a loopback bind,
 * so the result never leaves this machine.
 */
export function localEngineUrl(bind: Pick<EngineBind, "host" | "port">): string {
  const host = clientHostForBind(bind.host)
  const urlHost = host.includes(":") ? `[${host}]` : host
  return `http://${urlHost}:${bind.port}/`
}

/**
 * True when this URL would carry the bearer token in clear text over a network.
 *
 * Plain `http:` to loopback is fine (the bytes never leave the machine, and it
 * is how a local engine and an SSH tunnel are reached). Plain `http:` to any
 * other host is not: the engine token is a long-lived shared secret, so the
 * shell refuses that target instead of leaking it to a network observer.
 */
export function isInsecureRemoteUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:") return false
  return !isLoopbackHost(bareHostname(parsed.hostname))
}

/**
 * Exact-origin check, for deciding whether a navigation stays inside the app.
 *
 * A prefix test against a bare origin is not enough. With an expected origin of
 * `http://127.0.0.1:3005`, both `http://127.0.0.1:3005.evil.com/` and
 * `http://127.0.0.1:30051/` start with that text while being a different host or
 * port, so a prefix check would let them load inside the Electron window with the
 * preload bridge attached. Compare the parsed origins instead.
 */
export function isSameOrigin(rawUrl: string, expectedOrigin: string): boolean {
  try {
    return new URL(rawUrl).origin === expectedOrigin
  } catch {
    return false
  }
}
