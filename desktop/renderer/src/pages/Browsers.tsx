import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPost, EngineApiError, isSessionError } from '../services/engineApi'
import { useBrowserWorkspaceRect } from '../hooks/useBrowserWorkspaceRect'
import { useEnginePolling } from '../hooks/useEnginePolling'
import { Badge } from '../components/ui/Badge'
import { ErrorState } from '../components/ui/ErrorState'
import { Modal } from '../components/ui/Modal'
import { Spinner } from '../components/ui/Spinner'
import type { BrowserSnapshot, BrowserTab } from '../types/engine'

/**
 * Marketplace supplier browsers.
 *
 * Parity with the old engine dashboard's browsers workspace: tab strip, nav
 * toolbar, bounded native viewport (the Electron shell fits the WebContentsView
 * to `#browser-workspace-viewport`), detached-tab placeholder, claim control
 * bar and a live action-message region. Every control calls the real engine
 * API on 127.0.0.1:3005; mutations embed a fresh snapshot which is applied
 * directly (flicker-free: tabs key by tabId and update in place).
 */

/** The six marketplace panels the engine hosts as native browser tabs. */
export const SUPPLIER_PANELS: ReadonlyArray<{ key: string; name: string; automated: boolean }> = [
  { key: 'meesho', name: 'Meesho', automated: true },
  { key: 'flipkart', name: 'Flipkart', automated: false },
  { key: 'amazon', name: 'Amazon', automated: false },
  { key: 'myntra_vb', name: 'Myntra VB', automated: false },
  { key: 'myntra_ej', name: 'Myntra EJ', automated: false },
  { key: 'ajio', name: 'AJIO', automated: false },
]

/** Closed tabs leave the strip; their sessions stay restorable via Reopen. */
export function openTabs(tabs: BrowserTab[]): BrowserTab[] {
  return tabs.filter((tab) => tab.mode !== 'closed')
}

export function hasClosedTabs(tabs: BrowserTab[]): boolean {
  return tabs.some((tab) => tab.mode === 'closed')
}

/** Active-tab resolution — the same fallback chain as the engine dashboard. */
export function resolveActiveTab(snapshot: Pick<BrowserSnapshot, 'tabs' | 'activeTabId'> | null): BrowserTab | null {
  if (!snapshot) return null
  const byId = snapshot.activeTabId
    ? snapshot.tabs.find((tab) => tab.tabId === snapshot.activeTabId && tab.mode !== 'closed')
    : undefined
  return (
    byId ??
    snapshot.tabs.find((tab) => tab.mode === 'active') ??
    snapshot.tabs.find((tab) => tab.mode === 'detached') ??
    null
  )
}

/**
 * URL pill text. Plain string only — the supplier URL and title are untrusted
 * page data and are rendered as React text, never as HTML.
 */
export function formatUrlPill(active: BrowserTab | null): string {
  if (!active || active.mode === 'closed') return 'No supplier page open'
  const url = active.url || '(loading supplier page…)'
  const title = active.title ? ` — ${active.title}` : ''
  const account = active.accountName ? ` · ${active.accountName}` : ''
  return `${url}${title}${account}`
}

/** Mutation responses spread the fresh snapshot next to an `ok` flag. */
type PortalBrowserMutationResponse = BrowserSnapshot & { ok?: boolean; hidden?: string[] }

type ActionMessage = { kind: 'info' | 'error'; text: string } | null

const POLL_MS = 2000

export default function BrowsersPage() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<ActionMessage>(null)

  // The last snapshot wins whether it came from the 2s poll or a mutation
  // response (the engine embeds the snapshot in every mutation reply). The
  // previous layout is never cleared before a request resolves, so refreshes
  // cannot flash or drop scroll position.
  const snapshotSeqRef = useRef(0)

  const applySnapshot = useCallback((next: BrowserSnapshot, seq?: number) => {
    if (seq !== undefined && seq < snapshotSeqRef.current) return
    setSnapshot(next)
  }, [])

  const { error: pollError } = useEnginePolling(
    useCallback(async () => {
      const seq = ++snapshotSeqRef.current
      const next = await apiGet<BrowserSnapshot>('/api/portal-browser')
      applySnapshot(next, seq)
      return next
    }, [applySnapshot]),
    POLL_MS,
    true,
  )

  const mutate = useCallback(
    async (path: string, body: unknown, okText?: string) => {
      if (busy) return
      setBusy(true)
      setMessage(null)
      try {
        const seq = ++snapshotSeqRef.current
        const result = await apiPost<PortalBrowserMutationResponse>(path, body)
        applySnapshot(result, seq)
        setMessage(okText ? { kind: 'info', text: okText } : null)
      } catch (cause) {
        if (cause instanceof EngineApiError) {
          // Use cause.status directly: the isNetworkError guard would narrow
          // the remaining branch to never here (cause is already EngineApiError).
          if (cause.status === 0) {
            setMessage({ kind: 'error', text: 'Could not reach the claim bot. Check the connection and try again.' })
          } else if (cause.status === 409 && cause.body?.code === 'WORKER_ACTIVE_PAUSE_REQUIRED') {
            setMessage({
              kind: 'error',
              text: `Pause the worker before closing this tab: ${cause.body.error || 'a claim is running here.'}`,
            })
          } else {
            setMessage({ kind: 'error', text: cause.body?.error || cause.message })
          }
        } else {
          setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        }
      } finally {
        setBusy(false)
      }
    },
    [busy, applySnapshot],
  )

  /* Explicit fullscreen — entered only by the Expand button, never by polling. */
  const enterFullscreen = useCallback(() => {
    setFullscreen(true)
    try {
      window.desktopApp?.setBrowserFullscreen(true)
    } catch {
      // The bridge is absent in a plain browser; the local state still dims chrome.
    }
  }, [])

  const exitFullscreen = useCallback(() => {
    setFullscreen(false)
    try {
      window.desktopApp?.setBrowserFullscreen(false)
    } catch {
      // See enterFullscreen.
    }
  }, [])

  useEffect(() => {
    document.body.classList.toggle('ra-browser-fullscreen', fullscreen)
    return () => {
      document.body.classList.remove('ra-browser-fullscreen')
    }
  }, [fullscreen])

  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exitFullscreen()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [fullscreen, exitFullscreen])

  // Leaving the page must never leave the native view expanded over another
  // screen: clear the shell fullscreen flag and let the workspace hook send
  // null (both idempotent).
  useEffect(() => {
    return () => {
      document.body.classList.remove('ra-browser-fullscreen')
      try {
        window.desktopApp?.setBrowserFullscreen(false)
      } catch {
        // Unmount cleanup must never throw.
      }
    }
  }, [])

  // The shell only fits the native view while this exact route is active.
  const [routeActive, setRouteActive] = useState(() => window.location.hash === '#browsers')
  useEffect(() => {
    const onHashChange = () => setRouteActive(window.location.hash === '#browsers')
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const tabs = snapshot?.tabs ?? []
  const liveTabs = openTabs(tabs)
  const activeTab = resolveActiveTab(snapshot)
  const isDetached = activeTab?.mode === 'detached'
  const visibleViews = (snapshot?.views ?? []).filter((view) => view.visible)
  const activeClaim = activeTab?.activeClaim ?? null

  // Fail-closed: only report bounds while the Browsers route is active, the
  // engine says the browser is open, and the operator has not expanded to
  // fullscreen. Every other case reports null and the native view hides.
  const workspaceActive = Boolean(snapshot?.open) && !fullscreen && !isDetached && routeActive
  useBrowserWorkspaceRect(viewportRef, workspaceActive)

  if (!snapshot && pollError && isSessionError(pollError)) {
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title" className="font-display text-xl font-bold text-ink">Browsers</h1>
        <div className="mt-4">
          <ErrorState title="Sign-in required" message="Sign in again to manage the marketplace supplier browsers." />
        </div>
      </section>
    )
  }

  if (!snapshot && pollError) {
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title" className="font-display text-xl font-bold text-ink">Browsers</h1>
        <div className="mt-4">
          <ErrorState
            title="The claim engine is unreachable"
            message={`${pollError.message} The page keeps retrying on its own and restores itself once the engine answers.`}
          />
        </div>
      </section>
    )
  }

  if (!snapshot) {
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title" className="font-display text-xl font-bold text-ink">Browsers</h1>
        <div className="mt-4">
          <Spinner label="Loading the supplier browser state" />
        </div>
      </section>
    )
  }

  const hasActive = Boolean(activeTab && activeTab.mode !== 'closed')
  const toolbarDisabled = busy || !hasActive

  return (
    <section aria-labelledby="page-title" aria-busy={busy} className="flex h-full min-h-0 flex-col gap-3">
      <div>
        <h1 id="page-title" className="font-display text-xl font-bold text-ink">Browsers</h1>
        <p className="mt-1 text-sm text-muted">
          Marketplace supplier pages open inside this app window, bounded below. The sidebar and these controls stay
          visible while a page is open. Sessions are preserved when you switch tabs.
        </p>
      </div>

      {fullscreen ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2">
          <span className="text-xs font-semibold text-ink">
            Supplier browser expanded — press Esc or Exit Fullscreen to return
          </span>
          <button
            type="button"
            onClick={exitFullscreen}
            className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2"
          >
            Exit Fullscreen (Esc)
          </button>
        </div>
      ) : null}

      {/* Tab strip — keyed by tabId so polls update tabs in place. */}
      <div role="tablist" aria-label="Marketplace browser tabs" className="flex flex-wrap items-center gap-1.5">
        {liveTabs.length === 0 ? (
          <span className="text-xs text-muted">No supplier pages open.</span>
        ) : (
          liveTabs.map((tab) => {
            const isActiveTab = activeTab?.tabId === tab.tabId
            return (
              <span
                key={tab.tabId}
                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium ${
                  isActiveTab ? 'border-green bg-green-soft text-green-dark' : 'border-line bg-surface text-ink'
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActiveTab}
                  disabled={busy}
                  title={`Switch to the ${tab.label || tab.panelKey} tab (session preserved)`}
                  onClick={() => {
                    if (!isActiveTab) void mutate('/api/portal-browser/switch', { tabId: tab.tabId })
                  }}
                  className="rounded-full px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-blue"
                >
                  {tab.label || tab.panelKey}
                  {isActiveTab ? ' · open' : ''}
                </button>
                {tab.workerOwned ? (
                  <Badge variant="blue" title="A worker claim is running on this tab. Pause the worker before closing it.">
                    worker
                  </Badge>
                ) : null}
                {tab.mode === 'detached' ? (
                  <Badge variant="purple" title="This tab is open in its own window. Dock Back brings it home; the session rides along.">
                    detached
                  </Badge>
                ) : null}
                <button
                  type="button"
                  aria-label={`Close the ${tab.label || tab.panelKey} tab`}
                  title={`Close the ${tab.label || tab.panelKey} tab`}
                  disabled={busy}
                  onClick={() => void mutate('/api/portal-browser/close-tab', { tabId: tab.tabId })}
                  className="rounded-full px-1 text-muted hover:text-red"
                >
                  ×
                </button>
              </span>
            )
          })
        )}
        <button
          type="button"
          onClick={() => setChooserOpen(true)}
          disabled={busy}
          className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink hover:bg-surface-2"
          title="Open a supplier marketplace tab"
        >
          + Open Panel
        </button>
      </div>

      {/* Nav toolbar — disabled states mirror the old browserToolbarState. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
        <button
          type="button"
          disabled={toolbarDisabled || !activeTab?.canGoBack}
          title={
            !hasActive
              ? 'Open a supplier tab first'
              : activeTab?.canGoBack
                ? 'Go back in the supplier page'
                : 'No earlier page in this tab'
          }
          onClick={() => void mutate('/api/portal-browser/nav', { action: 'back', tabId: activeTab?.tabId })}
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
        >
          ← Back
        </button>
        <button
          type="button"
          disabled={toolbarDisabled || !activeTab?.canGoForward}
          title={
            !hasActive
              ? 'Open a supplier tab first'
              : activeTab?.canGoForward
                ? 'Go forward in the supplier page'
                : 'No later page in this tab'
          }
          onClick={() => void mutate('/api/portal-browser/nav', { action: 'forward', tabId: activeTab?.tabId })}
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
        >
          Forward →
        </button>
        <button
          type="button"
          disabled={toolbarDisabled}
          title={hasActive ? 'Reload the supplier page' : 'Open a supplier tab first'}
          onClick={() => void mutate('/api/portal-browser/nav', { action: 'reload', tabId: activeTab?.tabId })}
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
        >
          ↻ Reload
        </button>
        <button
          type="button"
          disabled={toolbarDisabled || !activeTab?.loading}
          title={
            !hasActive
              ? 'Open a supplier tab first'
              : activeTab?.loading
                ? 'Stop loading the supplier page'
                : 'The supplier page is not loading'
          }
          onClick={() => void mutate('/api/portal-browser/nav', { action: 'stop', tabId: activeTab?.tabId })}
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
        >
          ✕ Stop
        </button>

        <span
          className="min-w-[180px] flex-1 truncate text-xs text-muted"
          title={hasActive ? `Supplier page address: ${activeTab?.url || '(loading supplier page…)'}` : 'Supplier page address'}
        >
          {formatUrlPill(activeTab)}
        </span>
        <Badge title="Isolated session partition (cookies and login stay in this tab)">
          {hasActive && activeTab?.partition ? activeTab.partition : 'no session'}
        </Badge>

        <button
          type="button"
          disabled={toolbarDisabled || isDetached}
          title={
            !hasActive
              ? 'Open a supplier tab first'
              : isDetached
                ? 'Dock the tab back before expanding'
                : 'Expand the supplier browser to the full window'
          }
          onClick={enterFullscreen}
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
        >
          Expand
        </button>
        <button
          type="button"
          disabled={toolbarDisabled || isDetached}
          title={
            !hasActive
              ? 'Open a supplier tab first'
              : isDetached
                ? 'This tab is already detached; use Dock to bring it back'
                : 'Open this supplier tab in its own window; cookies and login ride along'
          }
          onClick={() =>
            void mutate('/api/portal-browser/detach', { tabId: activeTab?.tabId }, 'Tab detached into its own window. Use Dock Back here to bring it home.')
          }
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
        >
          Detach
        </button>
        {isDetached ? (
          <button
            type="button"
            disabled={busy}
            title="Bring the detached supplier window to the front"
            onClick={() => void mutate('/api/portal-browser/focus', { tabId: activeTab?.tabId })}
            className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
          >
            Focus Window
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || !isDetached}
          title={isDetached ? 'Bring the detached supplier window back into this workspace' : 'Nothing is detached right now'}
          onClick={() =>
            void mutate('/api/portal-browser/dock', { tabId: activeTab?.tabId }, 'Supplier window docked back into this workspace.')
          }
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
        >
          Dock
        </button>
        <button
          type="button"
          disabled={busy}
          title="Hide the supplier browser; the session stays saved"
          onClick={() =>
            void mutate('/api/portal-browser/hide', {}, snapshot.views.length > 0 ? 'Supplier browser hidden; the session stays saved.' : 'No supplier browser is open.')
          }
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
        >
          Hide
        </button>
      </div>

      {/* Bounded workspace: the Electron shell fits the native WebContentsView
          to this placeholder's rect; hidden or invalid bounds hide the view. */}
      {isDetached && activeTab ? (
        <div className="flex min-h-[320px] flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-line bg-surface px-6 text-center">
          <span aria-hidden="true" className="text-4xl text-muted">
            ⧉
          </span>
          <div className="flex flex-col gap-1">
            <p className="font-display text-sm font-semibold text-ink">
              {activeTab.label || activeTab.panelKey} is detached in a separate window
            </p>
            <p className="max-w-md text-sm text-muted">
              Cookies, the login session, and any running worker ride along in the detached window ({activeTab.partition}).
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void mutate('/api/portal-browser/dock', { tabId: activeTab.tabId }, 'Supplier window docked back into this workspace.')
              }
              className="rounded-lg bg-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-dark"
            >
              Dock Back
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutate('/api/portal-browser/focus', { tabId: activeTab.tabId })}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
            >
              Focus Window
            </button>
          </div>
        </div>
      ) : (
        <div
          ref={viewportRef}
          id="browser-workspace-viewport"
          className="flex min-h-[320px] flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-line bg-surface px-6 py-8 text-center"
        >
          {!snapshot.open ? (
            <>
              <p className="font-display text-sm font-semibold text-ink">No supplier browser is open</p>
              <p className="max-w-md text-sm text-muted">
                Use <strong>+ Open Panel</strong> above to open a marketplace tab. The supplier page appears inside this
                bounded area — it never covers the sidebar or these controls.
              </p>
            </>
          ) : visibleViews.length === 0 ? (
            <>
              <p className="font-display text-sm font-semibold text-ink">Supplier browser is hidden</p>
              <p className="max-w-md text-sm text-muted">
                The tab stays open with its session saved. Show it to continue, or switch back to Browsers.
              </p>
              {snapshot.panelKey ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void mutate('/api/portal-browser/show', { panelKey: snapshot.panelKey }, 'Supplier browser is open inside this window.')}
                  className="mt-1 rounded-lg bg-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-dark"
                >
                  Show supplier browser
                </button>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-muted">
              Supplier browser is shown in this area: {visibleViews.map((view) => view.panelKey).join(', ')}
            </p>
          )}
        </div>
      )}

      {/* Claim control bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-muted">
        {activeClaim ? (
          <span className="text-ink">
            Claim {activeClaim.claimId}
            {activeClaim.stage ? ` — ${activeClaim.stage}` : ''}
            {activeClaim.statusText ? ` — ${activeClaim.statusText}` : ''}
          </span>
        ) : activeTab ? (
          <span>
            Open: {activeTab.label || activeTab.panelKey} — session preserved across tabs.
          </span>
        ) : (
          <span>Idle — no supplier page open.</span>
        )}
        {activeClaim?.paused ? <Badge variant="orange">paused</Badge> : null}
        {activeTab?.workerOwned ? (
          <span className="text-muted">A worker claim is running on this tab — pause the worker before closing it.</span>
        ) : null}
        <span className="flex-1" />
        {hasClosedTabs(tabs) ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void mutate('/api/portal-browser/reopen', {})}
            title="Reopen the most recently closed supplier tab"
            className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
          >
            Reopen Closed Tab
          </button>
        ) : null}
      </div>

      {/* Action feedback — the exact server error text surfaces here. */}
      <div aria-live="polite">
        {message ? (
          message.kind === 'error' ? (
            <p role="alert" className="rounded-lg bg-red-soft px-3 py-2 text-xs text-red">
              {message.text}
            </p>
          ) : (
            <p className="rounded-lg bg-green-soft px-3 py-2 text-xs text-green-dark">
              {message.text}
            </p>
          )
        ) : null}
        {pollError && snapshot ? (
          <p className="mt-1 text-xs text-muted">
            Connection to the engine dropped — retrying automatically. Controls answer again once it is back.
          </p>
        ) : null}
      </div>

      {chooserOpen ? (
        <Modal title="Open a supplier panel" onClose={() => setChooserOpen(false)}>
          <p className="mb-3 text-sm text-muted">
            Each panel opens with its own saved login session. Meesho is filed automatically; the other panels are
            assisted (you drive the portal, the bot prepares the claim).
          </p>
          <div className="grid grid-cols-2 gap-2">
            {SUPPLIER_PANELS.map((panel) => (
              <button
                key={panel.key}
                type="button"
                disabled={busy}
                onClick={() => {
                  setChooserOpen(false)
                  void mutate('/api/portal-browser/open', { marketplace: panel.key })
                }}
                className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-left text-sm font-medium text-ink hover:bg-surface-2"
              >
                <span>{panel.name}</span>
                <Badge variant={panel.automated ? 'green' : 'neutral'}>{panel.automated ? 'auto' : 'assisted'}</Badge>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
    </section>
  )
}
