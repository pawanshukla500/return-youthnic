/**
 * Preload bridge contract (fixed). The Electron main process exposes
 * `window.desktopApp` via the context bridge; every call is optional so the
 * renderer also runs in a plain browser (Vite dev without the shell) — guard
 * every access with `window.desktopApp?.…`.
 *
 * Security note: for a remote (non-loopback) engine the shell injects
 * `Authorization: Bearer <ENGINE_TOKEN>` through its webRequest hook. The
 * token never reaches this renderer and must never be requested here.
 */

export type DesktopAppInfo = {
  version: string
  platform: string
  isPackaged: boolean
}

export type EngineTarget = {
  kind: 'local' | 'remote'
  url: string
}

export type DesktopBotStatus = {
  workerRunning: boolean
  isCurrentlyProcessing: boolean
  activeSummary: string | null
  signedIn: boolean
  backendUrl: string
  engineLabel: string
}

export type BrowserWorkspaceRect = {
  x: number
  y: number
  width: number
  height: number
}

declare global {
  interface Window {
    desktopApp?: {
      isDesktop: true
      platform: string
      getAppInfo: () => Promise<DesktopAppInfo>
      getEngineTarget: () => Promise<EngineTarget>
      getBotStatus: () => Promise<DesktopBotStatus>
      toggleBot: () => Promise<DesktopBotStatus>
      onBotStatusChange: (callback: (status: DesktopBotStatus) => void) => () => void
      sendNotification: (title: string, body: string) => void
      setBrowserWorkspaceRect: (rect: BrowserWorkspaceRect | null) => void
      setBrowserFullscreen: (on: boolean) => void
    }
  }
}

export {}
