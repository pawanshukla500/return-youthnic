import { useUpdateDownload, formatDownloadProgress } from '../hooks/useUpdateDownload'

/**
 * The "download update → run installer" control rendered by the app-wide
 * banner (App.tsx) and the Updates page. Replaces the old `<a target="_blank">`
 * that routed through the popup handler with no feedback: one component keeps
 * the busy/progress/success/error behaviour identical on both surfaces.
 *
 * States: idle (download button) → downloading (live MB progress; indeterminate
 * when the server gave no content-length) → done (saved-file row + a
 * double-click-confirmed "Run installer" button) → launching (app is closing).
 * Failure is an inline error + Retry, never a silent console line.
 */

export default function UpdateDownloadFlow({ url, label, tone = 'green' }: { url: string; label: string; tone?: 'green' | 'blue' }) {
  const { state, bridgeAvailable, start, retry, requestRun } = useUpdateDownload()
  const primary =
    tone === 'blue'
      ? 'rounded-lg bg-blue px-3 py-1 text-xs font-semibold text-white hover:opacity-90'
      : 'rounded-lg bg-green px-4 py-2 text-sm font-semibold text-white hover:bg-green-dark'
  const secondary = 'rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-muted hover:text-ink'

  if (!bridgeAvailable) {
    // Plain-browser dev: the bridge that downloads and launches is absent.
    return (
      <button type="button" disabled title="Update downloads run inside the installed desktop app" className={secondary}>
        {label}
      </button>
    )
  }

  switch (state.phase) {
    case 'downloading':
      return (
        <span className="text-sm text-muted" role="status">
          Downloading… {state.progress ? formatDownloadProgress(state.progress) : 'starting…'}
        </span>
      )
    case 'done':
      return (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-green">Downloaded to Downloads\{state.fileName}</span>
          <button type="button" onClick={requestRun} className={primary} title="Launches the installer and closes this app">
            {state.runArmed ? 'Click again to confirm — the app will close' : 'Run installer (app will close)'}
          </button>
          {state.error ? (
            <span role="alert" className="text-sm text-red">
              {state.error}
            </span>
          ) : null}
        </span>
      )
    case 'error':
      return (
        <span className="flex flex-wrap items-center gap-2">
          <span role="alert" className="text-sm text-red">
            {state.error}
          </span>
          <button type="button" onClick={() => retry(url)} className={secondary}>
            Retry
          </button>
        </span>
      )
    case 'launching':
      return (
        <span className="text-sm text-muted" role="status">
          Closing the app to run the installer…
        </span>
      )
    default:
      return (
        <button type="button" onClick={() => start(url)} className={primary}>
          {label}
        </button>
      )
  }
}
