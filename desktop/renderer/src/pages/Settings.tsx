import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { apiGet, apiPost, EngineApiError } from '../services/engineApi'
import { useSession } from '../state/SessionContext'
import { Spinner } from '../components/ui/Spinner'
import { ErrorState } from '../components/ui/ErrorState'
import { MarketplaceBadge } from '../components/ui/MarketplaceBadge'
import type { DesktopAppInfo, EngineTarget } from '../types/global'
import type {
  ConfigResponse,
  ConfigUpdateResponse,
  EngineConfig,
  PortalChannelStatus,
  PortalLoginsResponse,
  PortalLoginTestResult,
  SecurityStatus,
  TestConnectionResult,
} from '../types/engine'

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for the co-located tests)                     */
/* ------------------------------------------------------------------ */

/** The six claim panels, same keys as the Browsers page. Display names match
 * the engine's PORTAL_CHANNELS account names exactly — the credential routes
 * match accountName case-insensitively, so those POSTs send the name. */
export const MARKETPLACES: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'meesho', name: 'Meesho' },
  { key: 'flipkart', name: 'Flipkart' },
  { key: 'amazon', name: 'Amazon' },
  { key: 'myntra_vb', name: 'Myntra VB' },
  { key: 'myntra_ej', name: 'Myntra EJ' },
  { key: 'ajio', name: 'Ajio' },
]

/** Mirrors the engine's panelKeyForMarketplace (desktop-agent/panel-queue.ts). */
export function panelKeyForMarketplaceName(name: string): string {
  const norm = (name || '').trim().toLowerCase()
  if (norm.includes('myntra') && norm.includes('ej')) return 'myntra_ej'
  if (norm.includes('myntra')) return 'myntra_vb'
  if (norm.includes('meesho')) return 'meesho'
  if (norm.includes('flipkart')) return 'flipkart'
  if (norm.includes('amazon')) return 'amazon'
  if (norm.includes('ajio')) return 'ajio'
  return norm.replace(/[^a-z0-9]/g, '_') || 'unknown'
}

/** Onboarding row state, same thresholds as the old engine dashboard. */
export function channelStatusLabel(channel: PortalChannelStatus): string {
  if (channel.sessionSavedAt) return 'Connected — cookies saved'
  if (channel.configured) return 'ID saved'
  return 'Not connected'
}

/** One-line result for GET /api/test-connection. */
export function pingLabel(result: TestConnectionResult): string {
  return result.ok ? `✓ Connected (${result.latencyMs}ms)` : `✕ ${result.message || 'No connection'}`
}

/** Engine error → inline text. 401s return null because the shell owns those. */
function describeError(cause: unknown): string | null {
  if (cause instanceof EngineApiError) {
    // Note: not isSessionError() — its `error is` predicate would narrow the
    // remaining branch to never. Same check, written inline.
    if (cause.status === 401) return null
    return bodyMessage(cause) || cause.body?.error || cause.message
  }
  return cause instanceof Error ? cause.message : 'Something went wrong. Try again.'
}

/** Some engine error bodies carry a human `message` next to `error`. */
function bodyMessage(error: EngineApiError): string | undefined {
  const body = error.body as unknown as Record<string, unknown> | null
  return typeof body?.message === 'string' ? body.message : undefined
}

function toApiError(cause: unknown): EngineApiError {
  return cause instanceof EngineApiError
    ? cause
    : new EngineApiError(0, cause instanceof Error ? cause.message : String(cause))
}

type Notice = { tone: 'info' | 'success' | 'error'; text: string } | null

/** Inline result line that screen readers announce (aria-live). */
function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <p
      aria-live="polite"
      role={notice?.tone === 'error' ? 'alert' : 'status'}
      className={`min-h-5 text-sm ${
        notice == null
          ? 'text-muted'
          : notice.tone === 'error'
            ? 'text-red'
            : notice.tone === 'success'
              ? 'text-green-dark'
              : 'text-muted'
      }`}
    >
      {notice?.text ?? ''}
    </p>
  )
}

const PORTAL_POLL_MS = 30_000

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  const { handleAuthError, clearSession } = useSession()

  /* ------------------------- supplier panels ------------------------- */

  const [channels, setChannels] = useState<PortalChannelStatus[] | null>(null)
  const [channelsError, setChannelsError] = useState<EngineApiError | null>(null)
  const [channelsNonce, setChannelsNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const load = async () => {
      try {
        const data = await apiGet<PortalLoginsResponse>('/api/portal-logins')
        if (cancelled) return
        setChannels(data.channels)
        setChannelsError(null)
      } catch (cause) {
        if (cancelled) return
        const error = toApiError(cause)
        // A 401 means the session ended: the shell returns to the login gate.
        if (handleAuthError(error)) return
        setChannelsError(error)
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void load(), PORTAL_POLL_MS)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [channelsNonce, handleAuthError])

  const refreshChannels = useCallback(() => setChannelsNonce((nonce) => nonce + 1), [])

  /* ----------------------------- security ---------------------------- */

  const [security, setSecurity] = useState<SecurityStatus | null>(null)
  const [securityFailed, setSecurityFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await apiGet<SecurityStatus>('/api/security')
        if (!cancelled) setSecurity(data)
      } catch (cause) {
        if (cancelled) return
        if (handleAuthError(cause)) return
        setSecurityFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [handleAuthError])

  /* ------------------------------ config ----------------------------- */

  const [engineConfig, setEngineConfig] = useState<EngineConfig | null>(null)
  const [configFailed, setConfigFailed] = useState(false)

  const loadConfig = useCallback(async () => {
    try {
      const data = await apiGet<ConfigResponse>('/api/config')
      setEngineConfig(data.config)
      setConfigFailed(false)
    } catch (cause) {
      if (handleAuthError(cause)) return
      setConfigFailed(true)
    }
  }, [handleAuthError])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  /* ----------------------------- app info ---------------------------- */

  const [bridgeState, setBridgeState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null)
  const [engineTarget, setEngineTarget] = useState<EngineTarget | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const bridge = typeof window === 'undefined' ? undefined : window.desktopApp
        if (!bridge) {
          if (!cancelled) setBridgeState('unavailable')
          return
        }
        const [info, target] = await Promise.all([bridge.getAppInfo(), bridge.getEngineTarget()])
        if (cancelled) return
        setAppInfo(info)
        setEngineTarget(target)
        setBridgeState('ready')
      } catch {
        if (!cancelled) setBridgeState('unavailable')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* --------------------------- login form ---------------------------- */

  const [marketplace, setMarketplace] = useState(MARKETPLACES[0].name)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const usernameRef = useRef<HTMLInputElement>(null)
  const formSectionRef = useRef<HTMLDivElement>(null)

  // Deep link: something in the app asked us to focus the supplier login form
  // for one marketplace (e.g. a panel whose cookies expired). Consume the key
  // once: a refresh must not steal focus again.
  useEffect(() => {
    let focusMarketplace: string | null = null
    try {
      const raw = window.sessionStorage.getItem('ra-focus-login')
      if (raw) {
        window.sessionStorage.removeItem('ra-focus-login')
        focusMarketplace = raw
      }
    } catch {
      focusMarketplace = null
    }
    if (!focusMarketplace) return
    const wantedKey = panelKeyForMarketplaceName(focusMarketplace)
    const match = MARKETPLACES.find(
      (entry) =>
        panelKeyForMarketplaceName(entry.name) === wantedKey ||
        entry.name.toLowerCase() === focusMarketplace.trim().toLowerCase(),
    )
    if (!match) return
    setMarketplace(match.name)
    const frame = window.requestAnimationFrame(() => {
      formSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      usernameRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const [saveNotice, setSaveNotice] = useState<Notice>(null)
  const [testNotice, setTestNotice] = useState<Notice>(null)
  const [browserNotice, setBrowserNotice] = useState<Notice>(null)
  const [applyNotice, setApplyNotice] = useState<Notice>(null)
  const [pingNotice, setPingNotice] = useState<Notice>(null)

  const [saveBusy, setSaveBusy] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [browserBusy, setBrowserBusy] = useState(false)
  const [applyBusy, setApplyBusy] = useState(false)
  const [pingBusy, setPingBusy] = useState(false)
  const [backendUrlInput, setBackendUrlInput] = useState('')

  const connectedCount = channels?.filter((channel) => channel.sessionSavedAt).length ?? 0
  const totalCount = channels?.length ?? MARKETPLACES.length

  const saveLogin = async (event: FormEvent) => {
    event.preventDefault()
    if (saveBusy || testBusy) return
    setSaveBusy(true)
    setSaveNotice({ tone: 'info', text: 'Saving the supplier login…' })
    try {
      await apiPost<{ ok: boolean }>('/api/portal-logins', {
        marketplace,
        username: username.trim(),
        password,
      })
      // Never keep the password in the form once the engine accepted it.
      setPassword('')
      setSaveNotice({ tone: 'success', text: 'Supplier login saved. Test it, then run the waiting claim.' })
      refreshChannels()
    } catch (cause) {
      if (handleAuthError(cause)) return
      setSaveNotice({ tone: 'error', text: describeError(cause) ?? 'Could not save the supplier login.' })
    } finally {
      setSaveBusy(false)
    }
  }

  /** POST /api/portal-logins/test — opens the real supplier browser for
   * OTP/CAPTCHA and can take about a minute. Blank ID/password let the engine
   * use the login already saved on the server (the Reconnect flow). */
  const runLoginTest = useCallback(
    async (channelName: string, idValue: string, secret: string) => {
      if (testBusy) return
      setTestBusy(true)
      setTestNotice({
        tone: 'info',
        text: 'A supplier window opens inside this app; complete OTP or CAPTCHA there. This can take about a minute.',
      })
      try {
        const result = await apiPost<PortalLoginTestResult>('/api/portal-logins/test', {
          marketplace: channelName,
          username: idValue,
          password: secret,
        })
        setTestNotice({ tone: 'success', text: result.message || 'Supplier sign-in finished; cookies are saved on this PC.' })
        refreshChannels()
      } catch (cause) {
        if (handleAuthError(cause)) return
        if (cause instanceof EngineApiError && cause.status === 409) {
          setTestNotice({ tone: 'error', text: 'Worker is busy — pause the bot first.' })
          return
        }
        setTestNotice({
          tone: 'error',
          text: describeError(cause) ?? 'Could not open the supplier login.',
        })
      } finally {
        setTestBusy(false)
      }
    },
    [testBusy, handleAuthError, refreshChannels],
  )

  const testLogin = () => {
    void runLoginTest(marketplace, username.trim(), password)
  }

  /** Onboarding row button — parity with the old dashboard wizard: an
   * unconfigured panel focuses the form; a configured one re-opens the
   * supplier browser right away to refresh the saved cookies. */
  const connectChannel = (channel: PortalChannelStatus) => {
    setMarketplace(channel.name)
    formSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    usernameRef.current?.focus()
    if (channel.configured) {
      void runLoginTest(channel.name, '', '')
    }
  }

  /* --------------------------- backend URL --------------------------- */

  const applyBackendUrl = async () => {
    const url = backendUrlInput.trim()
    if (!url || applyBusy) return
    setApplyBusy(true)
    setApplyNotice({ tone: 'info', text: 'Changing the backend server…' })
    try {
      const result = await apiPost<ConfigUpdateResponse>('/api/config', { backendUrl: url })
      const next = result.config?.backendUrl
      if (next) {
        setEngineConfig((previous) => (previous ? { ...previous, backendUrl: next } : previous))
        setBackendUrlInput('')
      }
      if (result.signedOut) {
        // The engine signs the operator out on a backend change on purpose —
        // hand the shell back to the login gate.
        setApplyNotice({ tone: 'success', text: 'Backend server changed. You have been signed out — sign in again.' })
        clearSession()
        return
      }
      setApplyNotice({ tone: 'success', text: 'Backend server updated.' })
    } catch (cause) {
      if (handleAuthError(cause)) return
      setApplyNotice({ tone: 'error', text: describeError(cause) ?? 'Server was not changed.' })
    } finally {
      setApplyBusy(false)
    }
  }

  const pingBackend = async () => {
    if (pingBusy) return
    setPingBusy(true)
    setPingNotice({ tone: 'info', text: 'Pinging…' })
    try {
      const result = await apiGet<TestConnectionResult>('/api/test-connection')
      setPingNotice({ tone: result.ok ? 'success' : 'error', text: pingLabel(result) })
    } catch (cause) {
      if (handleAuthError(cause)) return
      setPingNotice({ tone: 'error', text: `✕ ${describeError(cause) ?? 'Connection failed'}` })
    } finally {
      setPingBusy(false)
    }
  }

  /* ------------------------- supplier browser ------------------------ */

  const showSupplierBrowser = async () => {
    if (browserBusy) return
    setBrowserBusy(true)
    setBrowserNotice({ tone: 'info', text: `Opening the ${marketplace} supplier browser…` })
    try {
      const result = await apiPost<{ ok: boolean; visible?: boolean }>('/api/portal-browser/show', {
        panelKey: panelKeyForMarketplaceName(marketplace),
      })
      setBrowserNotice({
        tone: 'success',
        text:
          result.visible === false
            ? 'The tab is open with its saved session, but this engine has no window to show it in.'
            : 'Supplier browser is open inside this window.',
      })
    } catch (cause) {
      if (handleAuthError(cause)) return
      setBrowserNotice({ tone: 'error', text: describeError(cause) ?? 'No open supplier browser for that marketplace.' })
    } finally {
      setBrowserBusy(false)
    }
  }

  const hideSupplierBrowser = async () => {
    if (browserBusy) return
    setBrowserBusy(true)
    setBrowserNotice({ tone: 'info', text: 'Hiding the supplier browser…' })
    try {
      const result = await apiPost<{ ok: boolean; hidden?: string[] }>('/api/portal-browser/hide')
      setBrowserNotice({
        tone: 'success',
        text: (result.hidden?.length ?? 0) > 0 ? 'Supplier browser hidden; the session stays saved.' : 'No supplier browser is open.',
      })
    } catch (cause) {
      if (handleAuthError(cause)) return
      setBrowserNotice({ tone: 'error', text: describeError(cause) ?? 'Could not hide the supplier browser.' })
    } finally {
      setBrowserBusy(false)
    }
  }

  /* ------------------------------ render ----------------------------- */

  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-3xl">
      <h1 id="page-title" className="font-display text-xl font-bold text-ink">
        Settings
      </h1>

      {/* 1 — first-time setup, one row per claim panel */}
      <div className="mt-4 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h2 className="font-display text-sm font-bold text-ink">Connect each supplier panel</h2>
        <p className="mt-1 text-xs text-muted">
          Connect all six marketplaces so claims can file on every panel. ({connectedCount} of {totalCount} connected)
        </p>
        <div className="mt-3">
          {channelsError ? (
            <ErrorState
              title="Supplier login status is unavailable"
              message={channelsError.message}
              onRetry={refreshChannels}
            />
          ) : channels === null ? (
            <Spinner label="Loading supplier panels" />
          ) : (
            <ul className="flex flex-col gap-2">
              {channels.map((channel) => {
                const ready = Boolean(channel.sessionSavedAt)
                return (
                  <li
                    key={channel.name}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2"
                  >
                    <span className="min-w-36">
                      <MarketplaceBadge marketplace={channel.name} />
                    </span>
                    <span
                      className={`flex-1 text-xs ${
                        ready ? 'text-green-dark' : channel.configured ? 'text-orange' : 'text-muted'
                      }`}
                    >
                      {channelStatusLabel(channel)}
                      {channel.usernameMasked ? ` · ${channel.usernameMasked}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => connectChannel(channel)}
                      disabled={testBusy}
                      title={testBusy ? 'A supplier sign-in test is already in progress.' : undefined}
                      className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
                    >
                      {ready ? 'Reconnect' : 'Connect'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* 2 — supplier login form */}
      <div ref={formSectionRef} className="mt-4 scroll-mt-4 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h2 className="font-display text-sm font-bold text-ink">Supplier login</h2>
        <p className="mt-1 text-xs text-muted">
          Do one marketplace at a time. Leave the ID and password blank to use the login already saved on the server. The
          password is sent to the engine once and is never shown again.
        </p>
        <form onSubmit={saveLogin} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-ink">
            Marketplace
            <select
              id="portal-marketplace"
              value={marketplace}
              onChange={(event) => setMarketplace(event.target.value)}
              className="mt-1 block min-w-36 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-blue"
            >
              {MARKETPLACES.map((entry) => (
                <option key={entry.key} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-ink">
            Supplier ID
            <input
              id="portal-username"
              ref={usernameRef}
              type="text"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-1 block min-w-48 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-blue"
            />
          </label>
          <label className="text-xs font-semibold text-ink">
            Password
            <input
              id="portal-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 block min-w-48 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-blue"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saveBusy || testBusy}
              className="rounded-lg bg-green px-4 py-2 text-sm font-semibold text-white hover:bg-green-dark"
            >
              {saveBusy ? 'Saving…' : 'Save login'}
            </button>
            <button
              type="button"
              onClick={testLogin}
              disabled={saveBusy || testBusy}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2"
            >
              {testBusy ? 'Opening…' : 'Sign in and save cookies'}
            </button>
          </div>
        </form>
        <div className="mt-2 flex flex-col gap-1">
          <NoticeLine notice={saveNotice} />
          <NoticeLine notice={testNotice} />
        </div>
      </div>

      {/* 3 — backend server */}
      <div className="mt-4 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h2 className="font-display text-sm font-bold text-ink">Backend server</h2>
        <p className="mt-1 text-xs text-muted">Claims are fetched from and filed to this server.</p>
        <dl className="mt-3 text-sm">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Current server</dt>
          <dd className="mt-0.5 break-all font-mono text-ink">
            {engineConfig ? engineConfig.backendUrl : configFailed ? 'Unavailable' : 'Loading…'}
          </dd>
        </dl>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-56 flex-1 text-xs font-semibold text-ink">
            New server URL
            <input
              id="backend-url-input"
              type="url"
              value={backendUrlInput}
              onChange={(event) => setBackendUrlInput(event.target.value)}
              placeholder="https://return.example.com"
              className="mt-1 block w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-blue"
            />
          </label>
          <button
            type="button"
            onClick={() => void applyBackendUrl()}
            disabled={applyBusy || !backendUrlInput.trim()}
            title={
              applyBusy
                ? 'Changing the backend server…'
                : !backendUrlInput.trim()
                  ? 'Enter a new server URL first.'
                  : undefined
            }
            className="rounded-lg bg-green px-4 py-2 text-sm font-semibold text-white hover:bg-green-dark"
          >
            {applyBusy ? 'Applying…' : 'Apply'}
          </button>
          <button
            type="button"
            onClick={() => void pingBackend()}
            disabled={pingBusy}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2"
          >
            {pingBusy ? 'Pinging…' : 'Test Ping'}
          </button>
        </div>
        <p className="mt-2 text-xs text-orange">
          Applying a new server signs you out on purpose — you sign in again to the new server.
        </p>
        <div className="mt-1 flex flex-col gap-1">
          <NoticeLine notice={applyNotice} />
          <NoticeLine notice={pingNotice} />
        </div>
      </div>

      {/* 4 + 5 — security and app info */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
          <h2 className="font-display text-sm font-bold text-ink">Security</h2>
          {security ? (
            <p className={`mt-2 text-sm ${security.osCredentialStore ? 'text-green-dark' : 'text-orange'}`}>
              {security.osCredentialStore
                ? '🔒 Credentials encrypted (OS store).'
                : '⚠️ Credentials in local files (OS store unavailable).'}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">{securityFailed ? 'Security status is unavailable.' : 'Loading…'}</p>
          )}
          {security?.detail ? <p className="mt-1 break-all text-xs text-muted">{security.detail}</p> : null}
        </div>

        <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
          <h2 className="font-display text-sm font-bold text-ink">App info</h2>
          {bridgeState === 'ready' && appInfo ? (
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Version</dt>
                <dd className="text-ink">{appInfo.version}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Platform</dt>
                <dd className="text-ink">{appInfo.platform}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Packaged</dt>
                <dd className="text-ink">{appInfo.isPackaged ? 'Yes' : 'No (development)'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Engine</dt>
                <dd className="text-ink">{engineTarget ? `${engineTarget.kind} · ${engineTarget.url}` : 'Unknown'}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-muted">
              {bridgeState === 'unavailable'
                ? 'Desktop bridge unavailable — this screen is running in a plain browser.'
                : 'Loading…'}
            </p>
          )}
        </div>
      </div>

      {/* 6 — supplier browser visibility */}
      <div className="mt-4 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h2 className="font-display text-sm font-bold text-ink">Supplier browser</h2>
        <p className="mt-1 text-xs text-muted">
          The supplier browser workspace lives in the Browsers tab — open it there for tabs, navigation and detach. These
          buttons only show or hide the window inside this app; the sign-in session stays saved either way.
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void showSupplierBrowser()}
            disabled={browserBusy}
            title={browserBusy ? 'A show or hide request is in progress.' : undefined}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2"
          >
            Show supplier browser
          </button>
          <button
            type="button"
            onClick={() => void hideSupplierBrowser()}
            disabled={browserBusy}
            title={browserBusy ? 'A show or hide request is in progress.' : undefined}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2"
          >
            Hide supplier browser
          </button>
        </div>
        <div className="mt-2">
          <NoticeLine notice={browserNotice} />
        </div>
      </div>
    </section>
  )
}
