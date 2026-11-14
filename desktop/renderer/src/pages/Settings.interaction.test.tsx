/**
 * Interaction tests for the Settings supplier-login disclosure (node:test +
 * @testing-library/react against the happy-dom registered in
 * test-setup/register-dom.ts). The engine API is stubbed at global fetch; no
 * component state is mocked.
 *
 * Covers the focus-request contract: the "Fix or change a supplier login"
 * button reveals the form and focuses the marketplace select; onboarding
 * Connect re-focuses even when the form is already open (nonce-driven, not
 * keyed on the open transition); an unconfigured channel auto-opens the form
 * without stealing focus.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
// Registers happy-dom + the React global BEFORE React/Testing Library and the
// page modules evaluate (same pattern as app.component.test.tsx).
import '../../test-setup/register-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import SettingsPage from './Settings'
import { MARKETPLACES } from './Settings'
import { SessionProvider } from '../state/SessionContext'
import type { PortalChannelStatus } from '../types/engine'

function channel(name: string, partial: Partial<PortalChannelStatus> = {}): PortalChannelStatus {
  return { name, configured: true, usernameMasked: 'ab***', sessionSavedAt: '2026-11-14T00:00:00Z', ...partial }
}

const ALL_READY = MARKETPLACES.map((entry) => channel(entry.name))

type StubReply = { status?: number; body?: unknown }

let fetchCalls: Array<{ method: string; pathname: string }> = []
const nativeFetch = globalThis.fetch

function installFetchStub(channels: PortalChannelStatus[]): void {
  fetchCalls = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const { pathname } = new URL(raw, 'http://127.0.0.1:3005')
    fetchCalls.push({ method, pathname })
    if (method === 'GET' && pathname === '/api/portal-logins') {
      return new Response(JSON.stringify({ channels }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (method === 'GET' && pathname === '/api/security') {
      return new Response(JSON.stringify({ osCredentialStore: true, detail: 'SYN' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (method === 'GET' && pathname === '/api/config') {
      return new Response(JSON.stringify({ config: { backendUrl: 'https://return.example.test' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (method === 'POST' && pathname === '/api/portal-logins/test') {
      return new Response(JSON.stringify({ ok: true, message: 'SYN signed in' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: `unstubbed ${method} ${pathname}` }), { status: 404 })
  }
}

function restoreFetch(): void {
  globalThis.fetch = nativeFetch
}

function renderSettings() {
  return render(
    <SessionProvider>
      <SettingsPage />
    </SessionProvider>,
  )
}

/** happy-dom's requestAnimationFrame is timer-driven; let it fire inside act. */
async function flushFrames(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

afterEach(() => {
  cleanup()
  restoreFetch()
})

describe('Settings supplier-login disclosure', () => {
  it('keeps the credential form hidden while every panel is connected', async () => {
    installFetchStub(ALL_READY)
    renderSettings()

    const statuses = await screen.findAllByText(/cookies saved/)
    assert.ok(statuses.length >= MARKETPLACES.length, 'every panel reports connected once channels load')
    assert.ok(screen.getByRole('button', { name: 'Fix or change a supplier login' }))
    assert.equal(screen.queryByLabelText('Supplier ID'), null, 'password form stays out of the DOM')
    assert.ok(!document.body.innerHTML.includes('type="password"'))
  })

  it('the disclosure button reveals the form and focuses the marketplace select', async () => {
    installFetchStub(ALL_READY)
    renderSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Fix or change a supplier login' }))

    await screen.findByLabelText('Supplier ID')
    const select = screen.getByLabelText('Marketplace')
    await flushFrames()
    assert.equal(document.activeElement, select, 'marketplace select takes focus when the form opens')
  })

  it('auto-opens without stealing focus when a panel is unconfigured and has no session', async () => {
    const channels = ALL_READY.map((entry) =>
      entry.name === 'Meesho' ? channel('Meesho', { configured: false, usernameMasked: '', sessionSavedAt: null }) : entry,
    )
    installFetchStub(channels)
    renderSettings()

    await screen.findByLabelText('Supplier ID')
    await flushFrames()
    assert.equal(
      document.activeElement,
      document.body,
      'auto-open shows the form but must not steal focus from the operator',
    )
  })

  it('onboarding Connect re-focuses the form even when it is already open', async () => {
    // Meesho: credentials saved but no session → 'Connect' button, no auto-open.
    const channels = ALL_READY.map((entry) =>
      entry.name === 'Meesho' ? channel('Meesho', { sessionSavedAt: null }) : entry,
    )
    installFetchStub(channels)
    renderSettings()

    // Open the form via the disclosure (focus → marketplace select).
    fireEvent.click(screen.getByRole('button', { name: 'Fix or change a supplier login' }))
    await screen.findByLabelText('Supplier ID')
    const select = screen.getByLabelText('Marketplace')
    await flushFrames()
    assert.equal(document.activeElement, select)

    // Connect on the Meesho row while the form is open: must re-focus Supplier ID.
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    const username = screen.getByLabelText('Supplier ID')
    await flushFrames()
    assert.equal(document.activeElement, username, 'Connect re-focuses even when the form is already open')
  })
})
