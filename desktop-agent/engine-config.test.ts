import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_ENGINE_HOST,
  DEFAULT_ENGINE_PORT,
  MIN_ENGINE_TOKEN_LENGTH,
  bearerTokenFromHeader,
  engineTokenMatches,
  isInsecureRemoteUrl,
  isLoopbackHost,
  isSameOrigin,
  localEngineUrl,
  parseEnginePort,
  resolveEngineBind,
} from "./src/engine-config.js"

describe("engine bind and remote-access policy", () => {
  it("defaults to a loopback, token-free local engine", () => {
    const bind = resolveEngineBind({})
    assert.equal(bind.host, DEFAULT_ENGINE_HOST)
    assert.equal(bind.port, DEFAULT_ENGINE_PORT)
    assert.equal(bind.mode, "local")
    assert.equal(bind.remoteAccess, false)
    assert.equal(bind.authToken, "")
  })

  it("treats every loopback spelling as local", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "  LOCALHOST  "]) {
      assert.equal(isLoopbackHost(host), true, `${host} should be loopback`)
      const bind = resolveEngineBind({ ENGINE_HOST: host })
      assert.equal(bind.mode, "local")
      assert.equal(bind.authToken, "")
    }
  })

  it("refuses to start on a reachable host without a strong token", () => {
    assert.throws(() => resolveEngineBind({ ENGINE_HOST: "0.0.0.0" }), /ENGINE_TOKEN/)
    assert.throws(() => resolveEngineBind({ ENGINE_HOST: "10.0.0.5", ENGINE_TOKEN: "short" }), /ENGINE_TOKEN/)
    const tooShort = "a".repeat(MIN_ENGINE_TOKEN_LENGTH - 1)
    assert.throws(() => resolveEngineBind({ ENGINE_HOST: "0.0.0.0", ENGINE_TOKEN: tooShort }), /ENGINE_TOKEN/)
  })

  it("enables remote mode once a long enough token is supplied", () => {
    const token = "x".repeat(MIN_ENGINE_TOKEN_LENGTH)
    const bind = resolveEngineBind({ ENGINE_HOST: "0.0.0.0", ENGINE_PORT: "3100", ENGINE_TOKEN: token })
    assert.equal(bind.host, "0.0.0.0")
    assert.equal(bind.port, 3100)
    assert.equal(bind.mode, "remote")
    assert.equal(bind.remoteAccess, true)
    assert.equal(bind.authToken, token)
  })

  it("validates the port instead of guessing", () => {
    assert.equal(parseEnginePort(undefined), DEFAULT_ENGINE_PORT)
    assert.equal(parseEnginePort(""), DEFAULT_ENGINE_PORT)
    assert.equal(parseEnginePort("8080"), 8080)
    assert.throws(() => parseEnginePort("0"), /ENGINE_PORT/)
    assert.throws(() => parseEnginePort("70000"), /ENGINE_PORT/)
    assert.throws(() => parseEnginePort("abc"), /ENGINE_PORT/)
    assert.throws(() => parseEnginePort("3005.5"), /ENGINE_PORT/)
  })

  it("compares tokens without leaking length, and treats empty as no-auth", () => {
    assert.equal(engineTokenMatches(null, ""), true)
    assert.equal(engineTokenMatches("anything", ""), true)
    assert.equal(engineTokenMatches(null, "secret"), false)
    assert.equal(engineTokenMatches("secret", "secret"), true)
    assert.equal(engineTokenMatches("secre", "secret"), false)
    assert.equal(engineTokenMatches("secrez", "secret"), false)
  })

  it("reads a bearer token from the authorization header only", () => {
    assert.equal(bearerTokenFromHeader("Bearer abc123"), "abc123")
    assert.equal(bearerTokenFromHeader("bearer   abc123  "), "abc123")
    assert.equal(bearerTokenFromHeader("Basic abc123"), null)
    assert.equal(bearerTokenFromHeader(undefined), null)
    assert.equal(bearerTokenFromHeader(""), null)
  })

  it("builds a client URL from the real bind host, including IPv6", () => {
    assert.equal(localEngineUrl({ host: "127.0.0.1", port: 3005 }), "http://127.0.0.1:3005/")
    assert.equal(localEngineUrl({ host: "localhost", port: 3100 }), "http://localhost:3100/")
    // ::1 must be bracketed, or the URL is invalid and the dashboard is refused.
    assert.equal(localEngineUrl({ host: "::1", port: 3005 }), "http://[::1]:3005/")
  })

  it("refuses a plain-http remote target so the engine token never crosses the wire in clear text", () => {
    // Loopback over http is fine: the bytes never leave the machine (SSH tunnel).
    assert.equal(isInsecureRemoteUrl("http://127.0.0.1:3005/"), false)
    assert.equal(isInsecureRemoteUrl("http://localhost:3005/"), false)
    assert.equal(isInsecureRemoteUrl("http://[::1]:3005/"), false)
    // https is always fine.
    assert.equal(isInsecureRemoteUrl("https://claims.example.com/"), false)
    assert.equal(isInsecureRemoteUrl("https://10.0.0.5:3005/"), false)
    // Plain http to anything else would leak the bearer token.
    assert.equal(isInsecureRemoteUrl("http://claims.example.com/"), true)
    assert.equal(isInsecureRemoteUrl("http://10.0.0.5:3005/"), true)
    assert.equal(isInsecureRemoteUrl("http://203.0.113.7/"), true)
  })

  it("keeps the window on the engine origin with an exact-origin test", () => {
    const origin = "http://127.0.0.1:3005"
    assert.equal(isSameOrigin("http://127.0.0.1:3005/", origin), true)
    assert.equal(isSameOrigin("http://127.0.0.1:3005/dashboard?tab=logs", origin), true)
    // A prefix test would wrongly accept every one of these.
    assert.equal(isSameOrigin("http://127.0.0.1:3005.evil.com/", origin), false)
    assert.equal(isSameOrigin("http://127.0.0.1:30051/", origin), false)
    assert.equal(isSameOrigin("http://127.0.0.1:3005@evil.com/", origin), false)
    assert.equal(isSameOrigin("https://127.0.0.1:3005/", origin), false)
    assert.equal(isSameOrigin("http://evil.com/?x=http://127.0.0.1:3005", origin), false)
    assert.equal(isSameOrigin("not a url", origin), false)
  })
})
