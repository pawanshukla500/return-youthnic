import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { apiGet, EngineApiError } from '../services/config'
import type { UpdateAsset, UpdateCheckResult } from '../types/engine'
import { Spinner } from '../components/ui/Spinner'

/**
 * Updates page — detail view for desktop release updates.
 *
 * Parity with the retired engine dashboard's "App updates" panel
 * (desktop-agent/src/desktop-app-server.ts): current-version line, manual
 * "Check now" against GET /api/updates/check, an auto-check preference, and a
 * last-checked line. The app-wide update banner lives in App.tsx (UpdateBanner)
 * and is deliberately NOT duplicated here.
 *
 * Pure helpers below are exported so node:test can cover the preference
 * persistence, asset picking, and result classification without a DOM.
 */

export const AUTO_UPDATES_STORAGE_KEY = 'ra-auto-updates'
export const LAST_CHECKED_STORAGE_KEY = 'ra-updates-last-checked'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null

function safeLocalStorage(): StorageLike {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Auto-check preference. Stored '1'/'0'; default on when never set. */
export function readAutoUpdatesPreference(storage: StorageLike): boolean {
  if (!storage) return true
  try {
    return storage.getItem(AUTO_UPDATES_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeAutoUpdatesPreference(storage: StorageLike, enabled: boolean): void {
  if (!storage) return
  try {
    storage.setItem(AUTO_UPDATES_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Best-effort preference persistence.
  }
}

/** Last-checked timestamp, stored as ISO; null when absent or not a date. */
export function readLastCheckedIso(storage: StorageLike): string | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(LAST_CHECKED_STORAGE_KEY)
    if (!raw || Number.isNaN(Date.parse(raw))) return null
    return raw
  } catch {
    return null
  }
}

export function writeLastCheckedIso(storage: StorageLike, iso: string): void {
  if (!storage) return
  try {
    storage.setItem(LAST_CHECKED_STORAGE_KEY, iso)
  } catch {
    // Best-effort preference persistence.
  }
}

/**
 * The engine already resolves downloadUrl via selectWindowsSetupAsset (.exe
 * first); this mirrors that pick as a fallback so the page still offers a real
 * asset if downloadUrl ever comes back null on an available release.
 */
export function pickSetupAsset(downloads: UpdateAsset[] | null | undefined): UpdateAsset | null {
  const list = Array.isArray(downloads) ? downloads : []
  return list.find((asset) => Boolean(asset?.url) && asset.name.toLowerCase().endsWith('.exe')) ?? list.find((asset) => Boolean(asset?.url)) ?? null
}

export type UpdateResultState = 'idle' | 'checking' | 'available' | 'up-to-date' | 'error'

export function classifyUpdateResult(result: UpdateCheckResult): UpdateResultState {
  if (!result.ok) return 'error'
  return result.updateAvailable ? 'available' : 'up-to-date'
}

/** Display formatting for the persisted ISO timestamp; null when unparseable. */
export function formatLastChecked(iso: string): string | null {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed).toLocaleString('en-IN', { hour12: false })
}

export default function UpdatesPage() {
  const [appVersion, setAppVersion] = useState('unknown')
  const [autoCheck, setAutoCheck] = useState(() => readAutoUpdatesPreference(safeLocalStorage()))
  const [lastCheckedIso, setLastCheckedIso] = useState(() => readLastCheckedIso(safeLocalStorage()))
  const [state, setState] = useState<UpdateResultState>('idle')
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const info = await window.desktopApp?.getAppInfo()
        if (!cancelled) setAppVersion(info?.version?.trim() ? info.version : 'unknown')
      } catch {
        if (!cancelled) setAppVersion('unknown')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const checkNow = useCallback(async () => {
    setState('checking')
    setCheckError(null)
    try {
      const data = await apiGet<UpdateCheckResult>('/api/updates/check')
      setResult(data)
      setState(classifyUpdateResult(data))
    } catch (cause) {
      setResult(null)
      setCheckError(cause instanceof EngineApiError ? cause.message : cause instanceof Error ? cause.message : String(cause))
      setState('error')
    } finally {
      const iso = new Date().toISOString()
      writeLastCheckedIso(safeLocalStorage(), iso)
      setLastCheckedIso(iso)
    }
  }, [])

  const onAutoCheckChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked
    setAutoCheck(next)
    writeAutoUpdatesPreference(safeLocalStorage(), next)
  }

  const downloadAsset = result && state === 'available' ? pickSetupAsset(result.downloads) : null
  const downloadUrl = result?.downloadUrl ?? downloadAsset?.url ?? null
  const lastCheckedLabel = lastCheckedIso ? formatLastChecked(lastCheckedIso) : null

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title" className="font-display text-xl font-bold text-ink">Updates</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        This app checks for a newer desktop release after install and while it runs. When one is found,
        a banner appears at the top of the window with the download link; install it over this version,
        supplier cookies are kept.
      </p>

      <div className="mt-4 max-w-2xl rounded-xl border border-line bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <span className="text-muted">
            This app: <span className="font-medium text-ink">{appVersion}</span>
          </span>
          <button
            type="button"
            onClick={() => void checkNow()}
            disabled={state === 'checking'}
            className="rounded-lg bg-green px-4 py-2 text-sm font-semibold text-white hover:bg-green-dark"
          >
            {state === 'checking' ? 'Checking…' : 'Check now'}
          </button>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={onAutoCheckChange}
              className="h-4 w-4 accent-[var(--green)]"
            />
            Check automatically
          </label>
        </div>

        {state === 'checking' ? (
          <div className="mt-4">
            <Spinner label="Checking for updates" />
          </div>
        ) : null}

        {state === 'available' && result ? (
          <div role="status" className="mt-4 rounded-xl border border-green/30 bg-green-soft px-4 py-3">
            <p className="text-sm text-ink">
              Update available: <strong className="text-green">{result.latestTag ?? 'a newer release'}</strong>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {downloadUrl ? (
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg bg-green px-4 py-2 text-sm font-semibold text-white hover:bg-green-dark"
                >
                  Download {downloadAsset?.name ?? 'installer'}
                </a>
              ) : (
                <span className="text-sm text-muted">No download has been published for this release yet.</span>
              )}
            </div>
            <p className="mt-2 text-xs text-muted">
              The installer downloads inside this app; close the app and run it to update. Supplier cookies are kept.
            </p>
          </div>
        ) : null}

        {state === 'up-to-date' && result ? (
          <p className="mt-4 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-ink">
            Up to date (this app: {result.currentVersion}).
          </p>
        ) : null}

        {state === 'error' ? (
          <div role="alert" className="mt-4 rounded-xl border border-red/30 bg-red-soft px-4 py-3">
            <p className="text-sm font-semibold text-red">Update check failed</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
              {result && !result.ok ? result.error : checkError}
            </p>
          </div>
        ) : null}

        {lastCheckedLabel ? (
          <p className="mt-3 text-xs text-muted">Last checked: {lastCheckedLabel}</p>
        ) : null}
      </div>
    </section>
  )
}
