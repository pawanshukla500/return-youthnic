/**
 * Pure helper coverage for the engine API client. This file must stay
 * DOM-free: it runs under plain
 * `node --import tsx --test desktop/renderer/src/services/*.test.ts` WITHOUT
 * the happy-dom registration in test-setup/register-dom.ts. Do not add tests
 * here that touch `window`/`document`/`fetch` — those belong in
 * app.component.test.tsx.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EngineApiError, isNetworkError, isSessionError } from './engineApi'

describe('EngineApiError', () => {
  it('carries status, message and parsed engine error body', () => {
    const error = new EngineApiError(403, 'Forbidden', { error: 'Viewer cannot file claims' })
    assert.equal(error.name, 'EngineApiError')
    assert.ok(error instanceof Error)
    assert.equal(error.status, 403)
    assert.equal(error.message, 'Forbidden')
    assert.deepEqual(error.body, { error: 'Viewer cannot file claims' })
  })

  it('defaults body to null (network failures have no response to parse)', () => {
    const error = new EngineApiError(0, 'Cannot reach the claim engine at http://127.0.0.1:3005 (fetch failed).')
    assert.equal(error.status, 0)
    assert.equal(error.body, null)
  })
})

describe('isSessionError', () => {
  it('is true only for a 401 EngineApiError from the engine', () => {
    assert.equal(isSessionError(new EngineApiError(401, 'Operator session expired')), true)
    assert.equal(isSessionError(new EngineApiError(403, 'Forbidden')), false)
    assert.equal(isSessionError(new EngineApiError(0, 'engine offline')), false)
  })

  it('never matches foreign errors or plain shapes', () => {
    assert.equal(isSessionError(new Error('boom')), false)
    assert.equal(isSessionError(new TypeError('fetch failed')), false)
    assert.equal(isSessionError({ status: 401 }), false)
    assert.equal(isSessionError(null), false)
    assert.equal(isSessionError(undefined), false)
  })
})

describe('isNetworkError', () => {
  it('is true only for a status-0 EngineApiError', () => {
    assert.equal(isNetworkError(new EngineApiError(0, 'fetch failed')), true)
    assert.equal(isNetworkError(new EngineApiError(500, 'engine bug')), false)
    assert.equal(isNetworkError(new EngineApiError(401, 'expired')), false)
  })

  it('is false for non-EngineApiError values, even fetch-shaped ones', () => {
    // A raw TypeError('fetch failed') is what fetch throws; the client wraps
    // it before anything consumes these guards — never match it directly.
    assert.equal(isNetworkError(new TypeError('fetch failed')), false)
    assert.equal(isNetworkError(null), false)
  })
})
