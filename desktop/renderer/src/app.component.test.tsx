/**
 * Component tests for the Wave A desktop renderer shell (node:test +
 * @testing-library/react against the happy-dom registered in
 * test-setup/register-dom.ts).
 *
 * Every rendered state below is produced by the real App/components talking
 * to a stubbed global fetch — no mocked component state, no fake data.
 * `window.desktopApp` stays undefined in every test, which is the
 * plain-browser path: the engine client falls back to http://127.0.0.1:3005.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
// Registers happy-dom + the React global BEFORE React/Testing Library and the
// App modules evaluate, so this file also runs under the plain
// `node --import tsx --test` invocation used by the repo `npm test` script
// (no --import for the setup file). Importing it again via --import is a no-op.
import '../test-setup/register-dom'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from './App'
import { MarketplaceBadge } from './components/ui/MarketplaceBadge'
import { Modal } from './components/ui/Modal'
import { SessionProvider } from './state/SessionContext'
import { ThemeProvider } from './state/ThemeProvider'
import type { OperatorProfile, StatusSnapshot, UpdateCheckResult } from './types/engine'

const OPERATOR: OperatorProfile = { name: 'Test Operator', email: 'ops@example.com', role: 'Admin' }

/** Minimal-but-complete StatusSnapshot for the shell's worker pill. */
function makeStatus(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    isRunning: false,
    isCurrentlyProcessing: false,
    activeJobInfo: null,
    activeSummary: null,
    nextPollCountdown: 0,
    lastHeartbeatTime: '',
    lastPollTime: '',
    lastFollowUpCheckTime: '',
    followUpChecksRun: 0,
    lastFollowUpResult: '',
    backendUrl: 'https://return.example.test',
    agentUuid: 'SYN-agent',
    agentName: 'SYN agent',
    signedIn: false,
    ...overrides,
  }
}

const NO_UPDATE: UpdateCheckResult = {
  ok: true,
  currentVersion: '0.0.0',
  latestTag: null,
  downloadUrl: null,
  downloads: [],
  updateAvailable: false,
}

/** Engine routes the real pages poll once the shell is signed in. */
function shellPageRoutes(method: string, pathname: string): StubReply | null {
  if (method === 'GET' && pathname === '/api/jobs') return { body: [] }
  if (method === 'GET' && pathname === '/api/panels') return { body: { panels: [] } }
  if (method === 'GET' && pathname === '/api/follow-ups') {
    return { body: { rows: [], total: 0, summary: { active: 0, due: 0, resolved: 0, withErrors: 0 } } }
  }
  if (method === 'GET' && pathname === '/api/updates/check') return { body: NO_UPDATE }
  return null
}

type StubReply = { status?: number; body?: unknown }

type FetchCall = { method: string; pathname: string; body: unknown }

let fetchCalls: FetchCall[] = []
const nativeFetch = globalThis.fetch

/** Restores the real (happy-dom) fetch and clears the call log. */
function restoreFetch(): void {
  globalThis.fetch = nativeFetch
  fetchCalls = []
}

/**
 * Routes every fetch through `handler`. Unstubbed routes get a JSON 404 so a
 * component asking for an endpoint the test does not model fails loudly in
 * the render instead of being mistaken for engine data.
 */
function installFetchStub(handler: (method: string, pathname: string, body: unknown) => StubReply): void {
  fetchCalls = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const { pathname } = new URL(raw, 'http://127.0.0.1:3005')
    fetchCalls.push({ method, pathname, body })
    const reply = handler(method, pathname, body)
    const status = reply.status ?? 200
    if (status === 204) return new Response(null, { status: 204 })
    return new Response(JSON.stringify(reply.body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/** Engine-down behaviour: every request rejects like an unreachable socket. */
function installOfflineFetch(): void {
  fetchCalls = []
  globalThis.fetch = async (): Promise<Response> => {
    throw new TypeError('fetch failed')
  }
}

function renderApp() {
  return render(
    <ThemeProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ThemeProvider>,
  )
}

afterEach(() => {
  cleanup()
  restoreFetch()
})

/* ------------------------------------------------------------------ */
/* 1. Offline / connecting state (mission acceptance #1/#2)            */
/* ------------------------------------------------------------------ */

describe('App shell with the engine offline', () => {
  it('renders the connecting state and a retry button when the engine is down', async () => {
    // No preload bridge: this is the plain-browser/dev fallback path.
    assert.equal(window.desktopApp, undefined)
    installOfflineFetch()

    renderApp()

    const status = await screen.findByRole('status', { name: 'Connecting to the claim engine' })
    assert.match(status.textContent ?? '', /Connecting to the claim engine/)

    assert.ok(screen.getByRole('button', { name: /retry now/i }), 'a retry button is offered')

    // The engine is unreachable: the shell must say so, not fake a dashboard.
    const alert = await screen.findByRole('alert')
    assert.match(alert.textContent ?? '', /No answer from the engine yet/)
    assert.match(alert.textContent ?? '', /fetch failed/)
  })
})

/* ------------------------------------------------------------------ */
/* 2. Login gate                                                       */
/* ------------------------------------------------------------------ */

describe('login gate', () => {
  it('shows the sign-in form when no operator session exists and enters the shell after login', async () => {
    installFetchStub((method, pathname) => {
      if (method === 'GET' && pathname === '/api/operator/session') {
        return { body: { signedIn: false, user: null } }
      }
      if (method === 'GET' && pathname === '/api/status') return { body: makeStatus() }
      if (method === 'POST' && pathname === '/api/operator/login') return { body: { ok: true, user: OPERATOR } }
      const pageReply = shellPageRoutes(method, pathname)
      if (pageReply) return pageReply
      return { status: 404, body: { error: `unstubbed ${method} ${pathname}` } }
    })

    renderApp()

    const email = await screen.findByLabelText('Email or login ID')
    const password = screen.getByLabelText('Password')
    const submit = screen.getByRole('button', { name: /sign in and run the bot/i })
    assert.ok(email)
    assert.ok(password)
    assert.ok(submit)

    fireEvent.change(email, { target: { value: 'ops@example.com' } })
    fireEvent.change(password, { target: { value: 'correct horse battery staple' } })
    const form = document.querySelector('form')
    assert.ok(form)
    fireEvent.submit(form)

    // The gate leaves once POST /api/operator/login resolves { ok, user }.
    await screen.findByText('Claim bot desktop')
    assert.equal(screen.queryByLabelText('Email or login ID'), null, 'login form is gone')

    // Proof the sign-in went through the real engine API, with the form data.
    const loginCall = fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/operator/login')
    assert.ok(loginCall, 'POST /api/operator/login was called')
    assert.deepEqual(loginCall.body, { email: 'ops@example.com', password: 'correct horse battery staple' })
  })
})

/* ------------------------------------------------------------------ */
/* 3. Shell navigation                                                 */
/* ------------------------------------------------------------------ */

describe('shell navigation', () => {
  it('renders all seven sidebar entries and switches pages by hash', async () => {
    installFetchStub((method, pathname) => {
      if (method === 'GET' && pathname === '/api/operator/session') {
        return { body: { signedIn: true, user: OPERATOR } }
      }
      if (method === 'GET' && pathname === '/api/status') return { body: makeStatus({ signedIn: true }) }
      const pageReply = shellPageRoutes(method, pathname)
      if (pageReply) return pageReply
      return { status: 404, body: { error: `unstubbed ${method} ${pathname}` } }
    })

    renderApp()

    await screen.findByText('Claim bot desktop')

    for (const label of ['Dashboard', 'Claims', 'Browsers', 'Follow-ups', 'AI Center', 'Settings', 'Updates']) {
      assert.ok(screen.getByRole('button', { name: label }), `sidebar entry renders: ${label}`)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Follow-ups' }))

    // The Follow-ups page reads GET /api/follow-ups (stubbed empty above) and
    // renders its own heading — the shell's job is to mount it via the hash.
    // The empty-state line arrives with the fetch, so wait for it rather than
    // asserting synchronously after the heading.
    const heading = await screen.findByRole('heading', { name: /ticket follow-ups/i })
    assert.equal(heading.tagName, 'H1', 'page heading switches to Ticket follow-ups')
    assert.ok(
      await screen.findByText('No followed-up tickets yet.'),
      'follow-ups page content is mounted (empty engine state)',
    )
  })
})

/* ------------------------------------------------------------------ */
/* 4. MarketplaceBadge logo fallback                                   */
/* ------------------------------------------------------------------ */

describe('MarketplaceBadge', () => {
  it('falls back to the letter avatar when the logo fails to load', async () => {
    const { container } = render(<MarketplaceBadge marketplace="Myntra VB" size={24} />)

    const img = container.querySelector('img')
    assert.ok(img, 'logo img renders for a known marketplace')
    assert.equal(img.getAttribute('src'), '/logos/myntra.png')

    fireEvent.error(img)

    assert.equal(container.querySelector('img'), null, 'broken logo is removed')
    assert.ok(screen.getByText('M'), 'letter fallback is visible')
    assert.ok(screen.getByText('Myntra VB'), 'marketplace name stays readable')
  })
})

/* ------------------------------------------------------------------ */
/* 5. Modal: open, Esc close, focus return                             */
/* ------------------------------------------------------------------ */

describe('Modal', () => {
  it('opens, closes on Escape and returns focus to the trigger', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          {open ? (
            <Modal title="Evidence viewer" onClose={() => setOpen(false)}>
              <p>Claim evidence</p>
            </Modal>
          ) : null}
        </div>
      )
    }

    render(<Harness />)

    const trigger = screen.getByRole('button', { name: 'Open dialog' })
    trigger.focus()
    assert.equal(document.activeElement, trigger)

    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Evidence viewer' })
    assert.ok(dialog)
    const closeButton = screen.getByRole('button', { name: 'Close dialog' })
    assert.equal(document.activeElement, closeButton, 'initial focus moves inside the dialog')

    fireEvent.keyDown(document, { key: 'Escape' })

    assert.equal(screen.queryByRole('dialog'), null, 'Escape closes the dialog')
    assert.equal(document.activeElement, trigger, 'focus returns to the trigger')
  })
})
