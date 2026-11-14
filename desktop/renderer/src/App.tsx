import { Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import DashboardPage from './pages/Dashboard'
import ClaimsPage from './pages/Claims'
import BrowsersPage from './pages/Browsers'
import FollowUpsPage from './pages/FollowUps'
import AiCenterPage from './pages/AiCenter'
import SettingsPage from './pages/Settings'
import UpdatesPage, { readAutoUpdatesPreference, safeLocalStorage } from './pages/Updates'
import { useSession } from './state/SessionContext'
import { useTheme } from './state/ThemeProvider'
import { useEngineStatus } from './hooks/useEngineStatus'
import SystemStatsPill from './components/SystemStatsPill'
import {
  apiGet,
  apiPost,
  EngineApiError,
  getEngineBase,
  isNetworkError,
} from './services/config'
import type {
  OperatorSessionResponse,
  OperatorProfile,
  UpdateCheckResult,
  FollowUpRow,
  FollowUpsResponse,
} from './types/engine'
import { Spinner } from './components/ui/Spinner'
import { Badge } from './components/ui/Badge'
import UpdateDownloadFlow from './components/UpdateDownloadFlow'
import { detectFollowUpNotifications } from './pages/follow-ups-notify'

type TabId = 'dashboard' | 'claims' | 'browsers' | 'follow-ups' | 'ai-center' | 'settings' | 'updates'

const TABS: Array<{ id: TabId; hash: string; label: string; component: ComponentType }> = [
  { id: 'dashboard', hash: '#dashboard', label: 'Dashboard', component: DashboardPage },
  { id: 'claims', hash: '#claims', label: 'Claims', component: ClaimsPage },
  { id: 'browsers', hash: '#browsers', label: 'Browsers', component: BrowsersPage },
  { id: 'follow-ups', hash: '#follow-ups', label: 'Follow-ups', component: FollowUpsPage },
  { id: 'ai-center', hash: '#ai-center', label: 'AI Center', component: AiCenterPage },
  { id: 'settings', hash: '#settings', label: 'Settings', component: SettingsPage },
  { id: 'updates', hash: '#updates', label: 'Updates', component: UpdatesPage },
]

const TAB_BY_HASH = new Map(TABS.map((tab) => [tab.hash, tab]))
const TAB_BY_ID = new Map(TABS.map((tab) => [tab.id, tab]))
const TAB_STORAGE_KEY = 'ra-side-tab'
const OFFLINE_RETRY_MS = 5000

function asApiError(cause: unknown): EngineApiError {
  return cause instanceof EngineApiError
    ? cause
    : new EngineApiError(0, cause instanceof Error ? cause.message : String(cause))
}

/* ------------------------------------------------------------------ */
/* Hash routing (hand-rolled, repo no-router convention)                */
/* ------------------------------------------------------------------ */

function readInitialHash(): string {
  if (typeof window !== 'undefined' && TAB_BY_HASH.has(window.location.hash)) {
    return window.location.hash
  }
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY)
    if (stored && TAB_BY_HASH.has(stored)) return stored
  } catch {
    // Storage unavailable: default tab.
  }
  return TABS[0].hash
}

function useHashRoute(): [string, (hash: string) => void] {
  const [hash, setHash] = useState(readInitialHash)

  useEffect(() => {
    const onHashChange = () => {
      if (TAB_BY_HASH.has(window.location.hash)) setHash(window.location.hash)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((next: string) => {
    if (window.location.hash === next) {
      setHash(next)
    } else {
      window.location.hash = next
    }
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next)
    } catch {
      // Preference persistence is best-effort.
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, hash)
    } catch {
      // Preference persistence is best-effort.
    }
  }, [hash])

  return [hash, navigate]
}

/* ------------------------------------------------------------------ */
/* Offline / connecting page — renders with every API down              */
/* ------------------------------------------------------------------ */

function ConnectingPage({
  engineUrl,
  error,
  onRetry,
  retrying,
}: {
  engineUrl: string
  error: EngineApiError | null
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      <div aria-hidden="true" className="font-display text-3xl font-extrabold tracking-tight text-green">
        Return App
      </div>
      <div className="flex flex-col items-center gap-2">
        <Spinner label="Connecting to the claim engine" />
        <p className="max-w-md text-sm text-muted">
          Waiting for the claim engine at <code className="text-ink">{engineUrl}</code>.
          Start the engine (or the desktop service) and this window picks it up automatically.
        </p>
        {error ? (
          <p role="alert" className="max-w-md text-sm text-red">
            {error.status === 0
              ? `No answer from the engine yet (${error.message}). Retrying every few seconds.`
              : error.message}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="rounded-lg bg-green px-4 py-2 text-sm font-semibold text-white hover:bg-green-dark"
      >
        {retrying ? 'Retrying…' : 'Retry now'}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Login gate — mirrors the engine dashboard gate                       */
/* ------------------------------------------------------------------ */

function LoginGate({ engineUrl }: { engineUrl: string }) {
  const { setUser } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await apiPost<{ ok: boolean; user?: OperatorProfile; error?: string }>(
        '/api/operator/login',
        { email, password },
      )
      if (result.ok && result.user) {
        // Never keep the password in the form once the engine accepted it.
        setPassword('')
        setUser(result.user)
      } else {
        setError(result.error || 'Sign-in failed.')
      }
    } catch (cause) {
      const apiError = asApiError(cause)
      // The engine surfaces backend 401/403 role refusals as { error } — show them.
      setError(apiError.body?.error || apiError.message)
      if (apiError.status === 0) {
        // Engine dropped mid-login: leave the password so the operator can retry.
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6">
      <form
        onSubmit={submit}
        aria-label="Operator sign-in"
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-card"
      >
        <div className="text-xs font-bold uppercase tracking-[0.2em] text-green">Claim bot</div>
        <h1 className="mt-2 font-display text-2xl font-extrabold text-ink">Sign in to start claims</h1>
        <p className="mt-2 text-sm text-muted">
          After you sign in, this PC keeps picking up queued claims for as long as the app is running,
          including when the window is closed to the tray.
        </p>

        <label htmlFor="gate-email" className="mt-6 block text-sm font-medium text-ink">
          Email or login ID
        </label>
        <input
          id="gate-email"
          type="text"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-blue"
        />

        <label htmlFor="gate-password" className="mt-4 block text-sm font-medium text-ink">
          Password
        </label>
        <input
          id="gate-password"
          ref={passwordRef}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-blue"
        />

        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-red-soft px-3 py-2 text-sm text-red">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-lg bg-green px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-dark"
        >
          {busy ? 'Signing in…' : 'Sign in and run the bot'}
        </button>

        <p className="mt-4 text-xs text-muted">
          Engine: <code className="text-ink">{engineUrl}</code>
        </p>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Update banner (dismiss per release tag)                              */
/* ------------------------------------------------------------------ */

const UPDATE_DISMISSED_KEY = 'ra-update-dismissed'

function UpdateBanner() {
  const { user } = useSession()
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    const check = async () => {
      try {
        if (!readAutoUpdatesPreference(safeLocalStorage())) {
          if (!cancelled) setUpdate(null)
          return
        }
        const result = await apiGet<UpdateCheckResult>('/api/updates/check')
        if (!cancelled) setUpdate(result)
      } catch {
        // A failed update check must never disturb the shell.
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 30 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [user])

  const dismissedTag = (() => {
    try {
      return localStorage.getItem(UPDATE_DISMISSED_KEY)
    } catch {
      return null
    }
  })()

  if (!update?.updateAvailable || !update.latestTag || update.latestTag === dismissedTag) return null

  return (
    <div className="flex items-center justify-between gap-3 border-b border-line bg-blue-soft px-4 py-2 text-sm">
      <span className="text-ink">
        A new desktop release is available: <strong>{update.latestTag}</strong>
      </span>
      <span className="flex items-center gap-2">
        {update.downloadUrl ? <UpdateDownloadFlow url={update.downloadUrl} label="Download update" tone="blue" /> : null}
        <button
          type="button"
          className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-muted hover:text-ink"
          onClick={() => {
            try {
              localStorage.setItem(UPDATE_DISMISSED_KEY, update.latestTag || '')
            } catch {
              // Best-effort dismissal persistence.
            }
            setUpdate(null)
          }}
        >
          Later
        </button>
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Follow-up ticket notifications (renderer-side watcher)               */
/* ------------------------------------------------------------------ */

const FOLLOW_UP_NOTIFY_POLL_MS = 60_000
const FIRED_FOLLOW_UP_KEYS_STORAGE_KEY = 'ra-fu-notify-fired'
// Keys already reported this session. Persisted (bounded) so an app restart
// does not re-report every tracked ticket as if it were freshly filed.
const firedFollowUpNotificationKeys = new Set<string>(readFiredFollowUpKeys())

function readFiredFollowUpKeys(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FIRED_FOLLOW_UP_KEYS_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

function markFollowUpNotificationFired(key: string): void {
  firedFollowUpNotificationKeys.add(key)
  try {
    localStorage.setItem(FIRED_FOLLOW_UP_KEYS_STORAGE_KEY, JSON.stringify(Array.from(firedFollowUpNotificationKeys).slice(-200)))
  } catch {
    // Best-effort persistence; the in-memory Set still guards this session.
  }
}

/**
 * Poll the engine's follow-ups (local or remote — the shell resolves the base
 * and injects remote auth) and surface ticket-tracking changes as OS
 * notifications through the bridge. Runs only while signed in; a 401 feeds the
 * caught error to the session (which tears this effect down), anything else
 * waits for the next tick.
 */
function useFollowUpNotifications(): void {
  const { user, handleAuthError } = useSession()

  useEffect(() => {
    if (!user) return
    let cancelled = false
    let timer: number | undefined
    let prevRows: FollowUpRow[] | null = null

    const tick = async () => {
      try {
        const result = await apiGet<FollowUpsResponse>('/api/follow-ups?pageSize=100')
        if (cancelled) return
        const rows = Array.isArray(result?.rows) ? result.rows : []
        for (const note of detectFollowUpNotifications(prevRows, rows)) {
          if (firedFollowUpNotificationKeys.has(note.key)) continue
          markFollowUpNotificationFired(note.key)
          window.desktopApp?.sendNotification(note.title, note.body)
        }
        prevRows = rows
      } catch (cause) {
        if (cancelled) return
        handleAuthError(cause)
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), FOLLOW_UP_NOTIFY_POLL_MS)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [user, handleAuthError])
}

/* ------------------------------------------------------------------ */
/* Render error boundary — a page crash must never white-screen the app  */
/* ------------------------------------------------------------------ */

type BoundaryState = { message: string | null }

class PageErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { message: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: unknown) {
    // Diagnostics only — no secrets in error text.
    console.error('[render-boundary]', error, info)
  }

  render() {
    if (this.state.message === null) return this.props.children
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
        <h2 className="font-display text-lg font-bold text-ink">This screen hit an unexpected error</h2>
        <p className="max-w-lg text-sm text-muted">{this.state.message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-green px-4 py-2 text-sm font-semibold text-white hover:bg-green-dark"
        >
          Reload the app
        </button>
      </div>
    )
  }
}

/* ------------------------------------------------------------------ */
/* App shell                                                            */
/* ------------------------------------------------------------------ */

export default function App() {
  const session = useSession()
  const { theme, toggleTheme } = useTheme()
  const [hash, navigate] = useHashRoute()
  const { status, error: statusError } = useEngineStatus(5000)
  useFollowUpNotifications()

  const [engineUrl, setEngineUrl] = useState('http://127.0.0.1:3005')
  const [connectionError, setConnectionError] = useState<EngineApiError | null>(null)
  const [gateKnown, setGateKnown] = useState(false) // got an answer from /api/operator/session
  const [retryNonce, setRetryNonce] = useState(0)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    void getEngineBase().then(setEngineUrl).catch(() => undefined)
  }, [])

  // Session bootstrap + keep-alive. Only a definite 200 from the engine may
  // clear the session; transient network errors show the connecting page and
  // retry, so a blip never signs the operator out.
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const check = async () => {
      const requestEpoch = session.sessionEpoch
      try {
        const result = await apiGet<OperatorSessionResponse>('/api/operator/session')
        if (cancelled) return
        setConnectionError(null)
        setGateKnown(true)
        if (result.signedIn && result.user) {
          session.setUser(result.user)
        } else if (session.sessionEpoch === requestEpoch) {
          // If the operator signed in while this check was in flight, do not clear.
          session.clearSession()
        }
      } catch (cause) {
        if (cancelled) return
        setConnectionError(asApiError(cause))
        setGateKnown(false)
        timer = window.setTimeout(() => void check(), OFFLINE_RETRY_MS)
      } finally {
        if (!cancelled) setRetrying(false)
      }
    }

    void check()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
    // session.setUser/clearSession are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce])

  const retryNow = useCallback(() => {
    setRetrying(true)
    setRetryNonce((nonce) => nonce + 1)
  }, [])

  const activeTab = TAB_BY_HASH.get(hash) ?? TABS[0]
  const ActivePage = activeTab.component

  const offline = connectionError !== null || (gateKnown === false && statusError !== null && isNetworkError(statusError))

  // Worker status pill for the top bar.
  const workerPill = useMemo(() => {
    if (!status) return null
    if (status.isCurrentlyProcessing) return <Badge variant="blue">Processing {status.activeSummary ?? ''}</Badge>
    if (status.isRunning) return <Badge variant="green">Bot running</Badge>
    if (status.signedIn) return <Badge variant="orange">Bot paused</Badge>
    return <Badge>Bot idle</Badge>
  }, [status])

  // Sidebar keyboard nav: ArrowUp/ArrowDown move focus, Enter/Space click the button.
  const navRef = useRef<HTMLElement>(null)
  const onSidebarKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('button[data-tab]') ?? [])
    if (buttons.length === 0) return
    event.preventDefault()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  if (offline) {
    return <ConnectingPage engineUrl={engineUrl} error={connectionError ?? statusError} onRetry={retryNow} retrying={retrying} />
  }

  if (!session.user) {
    return <LoginGate engineUrl={engineUrl} />
  }

  return (
    <div className="flex h-screen flex-col bg-bg">
      <div className="flex min-h-0 flex-1">
        {/* Persistent sidebar — the supplier browser never covers this. */}
        <aside
          className="flex w-[200px] shrink-0 flex-col border-r border-line bg-sidebar-bg"
          aria-label="Primary"
        >
          <div className="px-4 pb-2 pt-4 font-display text-sm font-extrabold uppercase tracking-[0.18em] text-sidebar-muted">
            Return App
          </div>
          <nav
            ref={navRef}
            aria-label="Sections"
            onKeyDown={onSidebarKeyDown}
            className="flex flex-1 flex-col gap-0.5 px-2 py-2"
          >
            {TABS.map((tab) => {
              const active = tab.id === activeTab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-tab={tab.id}
                  tabIndex={active ? 0 : -1}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => navigate(tab.hash)}
                  className={`rounded-lg px-3 py-2 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue ${
                    active ? 'bg-white/10 text-sidebar-ink' : 'text-sidebar-muted hover:bg-white/5 hover:text-sidebar-ink'
                  }`}
                >
                  {tab.label}
                </button>
              )
            })}
          </nav>
          <div className="px-4 py-3 text-[11px] text-sidebar-muted">Claim bot desktop</div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar: native window frame, so no custom window controls. */}
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-topbar-bg px-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-ink">{activeTab.label}</span>
              {workerPill}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted" title={session.user.email}>
                {session.user.name}
                <span className="ml-1 text-xs">({session.user.role})</span>
              </span>
              <SystemStatsPill />
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-muted hover:text-ink"
              >
                {theme === 'dark' ? '☀' : '☾'}
              </button>
            </div>
          </header>

          <UpdateBanner />

          <main className="min-h-0 flex-1 overflow-y-auto p-4">
            <PageErrorBoundary key={activeTab.id}>
              <ActivePage />
            </PageErrorBoundary>
          </main>
        </div>
      </div>
    </div>
  )
}

// Re-exported so page workers can reuse the tab ids without a second source.
export type { TabId }
export { TAB_BY_ID }
