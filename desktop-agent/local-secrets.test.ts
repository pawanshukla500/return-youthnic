import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { localEncryptionAvailable, protectSecret, revealSecret } from "./src/local-secrets.js"

describe("local secret protection", () => {
  it("round-trips a token without OS encryption (source-run fallback)", () => {
    // Under plain Node there is no Electron safeStorage, so the value is
    // kept readable and revealSecret returns it unchanged.
    if (localEncryptionAvailable()) return
    const token = "SYN-test-token-123"
    assert.equal(revealSecret(protectSecret(token)), token)
  })

  it("reads legacy plaintext files and empty values safely", () => {
    assert.equal(revealSecret("SYN-legacy-plaintext"), "SYN-legacy-plaintext")
    assert.equal(revealSecret(""), null)
    assert.equal(protectSecret(""), "")
  })

  it("an undecryptable dpapi value is unusable, never thrown", () => {
    if (localEncryptionAvailable()) return
    assert.equal(revealSecret("dpapi:AAAA-invalid-bytes"), null)
  })
})
