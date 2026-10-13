import { test } from "node:test"
import assert from "node:assert/strict"
import {
  hashToken,
  generateToken,
  parseDeviceName,
  parseCookies,
  DEFAULT_SESSION_CONFIG,
  SESSION_COOKIE_NAME,
} from "../auth.js"

test("generateToken produces a high-entropy 64-character hex string", () => {
  const token1 = generateToken()
  const token2 = generateToken()
  assert.equal(typeof token1, "string")
  assert.equal(token1.length, 64)
  assert.match(token1, /^[0-9a-f]{64}$/)
  assert.notEqual(token1, token2)
})

test("hashToken generates consistent SHA-256 hex digest", () => {
  const token = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
  const hash1 = hashToken(token)
  const hash2 = hashToken(token)
  assert.equal(hash1, hash2)
  assert.equal(hash1.length, 64)
  assert.match(hash1, /^[0-9a-f]{64}$/)
})

test("parseDeviceName identifies OS and browser correctly", () => {
  assert.equal(
    parseDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Edg/120.0"),
    "Edge on Windows PC",
  )
  assert.equal(
    parseDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"),
    "Chrome on Windows PC",
  )
  assert.equal(
    parseDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"),
    "Safari on Mac",
  )
  assert.equal(
    parseDeviceName("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Chrome/110.0 Mobile Safari/537.36"),
    "Chrome on Android Device",
  )
  assert.equal(
    parseDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 Version/16.5 Mobile/15E148 Safari/604.1"),
    "Safari on iOS Device",
  )
  assert.equal(parseDeviceName(""), "Warehouse Terminal")
})

test("parseCookies extracts individual cookies properly", () => {
  const header = `return_session=abc123token; return_token=legacyToken; other_val=something%20else`
  const cookies = parseCookies(header)
  assert.equal(cookies[SESSION_COOKIE_NAME], "abc123token")
  assert.equal(cookies.return_token, "legacyToken")
  assert.equal(cookies.other_val, "something else")
  assert.equal(parseCookies("")[SESSION_COOKIE_NAME], undefined)
})

test("DEFAULT_SESSION_CONFIG adheres to warehouse device specifications", () => {
  assert.equal(DEFAULT_SESSION_CONFIG.rememberDurationDays, 30)
  assert.equal(DEFAULT_SESSION_CONFIG.rememberIdleDays, 7)
  assert.equal(DEFAULT_SESSION_CONFIG.standardDurationHours, 24)
  assert.equal(DEFAULT_SESSION_CONFIG.standardIdleHours, 4)
})
