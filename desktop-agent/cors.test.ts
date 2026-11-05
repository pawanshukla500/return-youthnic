// CORS allowlist unit tests: the packaged renderer origin and the dev Vite
// origins are allowed, ENGINE_CORS_ORIGINS adds exact origins (parsed
// leniently), and nothing else — never a wildcard, never a reflected origin.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { corsAllowedOrigin, corsHeadersFor, DESKTOP_RENDERER_ORIGIN } from "./src/cors.js"

const DEV = { dev: true }
const PROD = { dev: false }

describe("corsAllowedOrigin: packaged renderer origin", () => {
  it("allows returnapp://desktop in production", () => {
    assert.equal(corsAllowedOrigin("returnapp://desktop", PROD), "returnapp://desktop")
  })

  it("allows returnapp://desktop in development", () => {
    assert.equal(corsAllowedOrigin("returnapp://desktop", DEV), "returnapp://desktop")
  })

  it("never answers '*' for the packaged origin", () => {
    assert.notEqual(corsAllowedOrigin(DESKTOP_RENDERER_ORIGIN, PROD), "*")
  })
})

describe("corsAllowedOrigin: dev origins", () => {
  it("allows the Vite dev origins only when dev is true", () => {
    assert.equal(corsAllowedOrigin("http://localhost:5180", DEV), "http://localhost:5180")
    assert.equal(corsAllowedOrigin("http://127.0.0.1:5180", DEV), "http://127.0.0.1:5180")
    assert.equal(corsAllowedOrigin("http://localhost:5180", PROD), null)
    assert.equal(corsAllowedOrigin("http://127.0.0.1:5180", PROD), null)
  })

  it("does not allow lookalike dev origins", () => {
    assert.equal(corsAllowedOrigin("http://localhost:5181", DEV), null)
    assert.equal(corsAllowedOrigin("http://localhost:5180.evil.example", DEV), null)
    assert.equal(corsAllowedOrigin("http://127.0.0.1:5180@evil.example", DEV), null)
    assert.equal(corsAllowedOrigin("http://user:pass@localhost:5180", DEV), null)
    assert.equal(corsAllowedOrigin("https://localhost:5180", DEV), null)
  })
})

describe("corsAllowedOrigin: ENGINE_CORS_ORIGINS extras", () => {
  it("allows exact extra origins from a comma-separated string", () => {
    const opts = { extraOrigins: "https://ops.example, https://panel.example:8443", dev: false }
    assert.equal(corsAllowedOrigin("https://ops.example", opts), "https://ops.example")
    assert.equal(corsAllowedOrigin("https://panel.example:8443", opts), "https://panel.example:8443")
    assert.equal(corsAllowedOrigin("https://other.example", opts), null)
  })

  it("accepts an already-split list as well", () => {
    const opts = { extraOrigins: ["https://ops.example"], dev: false }
    assert.equal(corsAllowedOrigin("https://ops.example", opts), "https://ops.example")
    assert.equal(corsAllowedOrigin("https://nope.example", opts), null)
  })

  it("parses leniently: trims, skips empties, normalizes a trailing slash", () => {
    const opts = { extraOrigins: "  , https://ops.example/ ,, ", dev: false }
    assert.equal(corsAllowedOrigin("https://ops.example", opts), "https://ops.example")
  })

  it("ignores junk entries without disabling the good ones", () => {
    const opts = { extraOrigins: "not a url, ://broken, https://ok.example", dev: false }
    assert.equal(corsAllowedOrigin("https://ok.example", opts), "https://ok.example")
    assert.equal(corsAllowedOrigin("not a url", opts), null)
  })

  it("never honours a '*' entry", () => {
    const opts = { extraOrigins: "*", dev: false }
    assert.equal(corsAllowedOrigin("https://evil.example", opts), null)
    assert.equal(corsAllowedOrigin("http://localhost:5180", opts), null)
  })

  it("rejects extra entries that carry a path, query or non-http scheme", () => {
    const opts = { extraOrigins: "https://ok.example/path, https://q.example/?x=1, file:///tmp, returnapp://other", dev: false }
    assert.equal(corsAllowedOrigin("https://ok.example", opts), null)
    assert.equal(corsAllowedOrigin("https://q.example", opts), null)
    assert.equal(corsAllowedOrigin("file://", opts), null)
    assert.equal(corsAllowedOrigin("returnapp://other", opts), null)
  })
})

describe("corsAllowedOrigin: deny and null cases", () => {
  it("denies arbitrary origins, even on an open engine", () => {
    assert.equal(corsAllowedOrigin("https://evil.example", DEV), null)
    assert.equal(corsAllowedOrigin("http://127.0.0.1:3005", DEV), null)
    assert.equal(corsAllowedOrigin("null", DEV), null)
    assert.equal(corsAllowedOrigin("*", DEV), null)
  })

  it("returns null for a missing or empty origin so non-CORS requests stay untouched", () => {
    assert.equal(corsAllowedOrigin(null, DEV), null)
    assert.equal(corsAllowedOrigin("", DEV), null)
    assert.equal(corsAllowedOrigin("   ", DEV), null)
  })

  it("never reflects the request origin when it is not allowed", () => {
    const origin = "https://spoofed-returnapp.example"
    const result = corsAllowedOrigin(origin, DEV)
    assert.equal(result, null)
    assert.notEqual(result, origin)
  })
})

describe("corsHeadersFor", () => {
  it("emits exactly the pinned headers for the allowed origin", () => {
    assert.deepEqual(corsHeadersFor("returnapp://desktop"), {
      "Access-Control-Allow-Origin": "returnapp://desktop",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "false",
      "Vary": "Origin",
    })
  })

  it("never emits '*'", () => {
    for (const value of Object.values(corsHeadersFor("returnapp://desktop"))) {
      assert.notEqual(value, "*")
    }
  })
})
