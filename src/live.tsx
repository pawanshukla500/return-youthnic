import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { api } from "./api"
import { Icon } from "./ui"

// Live updates for every screen (server/live.ts).
//
// One connection per browser tab: a WebSocket to /api/live while it works, and a poll of /api/sync/state every 3.5
// seconds while it does not. Both carry the same sync cursor (the newest audit id). When the cursor moves, the pages that
// listen reload their data through the normal API, so nothing is applied twice and the account rule always holds.

export type SyncMode = "connecting" | "live" | "polling" | "offline"

export type LiveChange = {
  kind: string
  cursor: number
  marketplaceId?: number | null
  shipmentId?: number
  scanId?: number
  actorId?: number
}

type SyncState = { mode: SyncMode; cursor: number; lastSyncedAt: number | null }

const POLL_MS = 3500
const MAX_RECONNECT_MS = 30_000

let state: SyncState = { mode: "connecting", cursor: 0, lastSyncedAt: null }
const stateListeners = new Set<() => void>()
const changeListeners = new Set<(change: LiveChange) => void>()
let socket: WebSocket | null = null
let pollTimer: number | null = null
let reconnectTimer: number | null = null
let reconnectDelay = 2000
let started = false

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  for (const listener of stateListeners) listener()
}

function emit(change: LiveChange) {
  for (const listener of changeListeners) listener(change)
}

// A cursor that moved means data changed somewhere. The first cursor a tab sees is only remembered.
function noteCursor(cursor: number, change?: Omit<LiveChange, "cursor">) {
  const previous = state.cursor
  setState({ cursor: Math.max(previous, cursor), lastSyncedAt: Date.now() })
  if (change) emit({ ...change, cursor })
  else if (previous > 0 && cursor > previous) emit({ kind: "resync", cursor })
}

async function pollOnce() {
  try {
    const result = await api<{ cursor: number }>("/api/sync/state")
    if (state.mode !== "live") setState({ mode: "polling" })
    noteCursor(Number(result.cursor) || 0)
  } catch {
    if (state.mode !== "live") setState({ mode: "offline" })
  }
}

function startPolling() {
  if (pollTimer !== null) return
  void pollOnce()
  pollTimer = window.setInterval(() => void pollOnce(), POLL_MS)
}

function stopPolling() {
  if (pollTimer === null) return
  window.clearInterval(pollTimer)
  pollTimer = null
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2)
}

function connect() {
  if (typeof WebSocket === "undefined") {
    startPolling()
    return
  }
  try {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws"
    const ws = new WebSocket(`${scheme}://${window.location.host}/api/live`)
    socket = ws
    ws.onopen = () => {
      reconnectDelay = 2000
      stopPolling()
      setState({ mode: "live", lastSyncedAt: Date.now() })
    }
    ws.onmessage = (event) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        return
      }
      const cursor = Number(message.cursor) || 0
      if (message.type === "change") {
        noteCursor(cursor, {
          kind: String(message.kind || "change"),
          marketplaceId: message.marketplaceId === null ? null : Number(message.marketplaceId) || null,
          shipmentId: Number(message.shipmentId) || undefined,
          scanId: Number(message.scanId) || undefined,
          actorId: Number(message.actorId) || undefined,
        })
      } else {
        noteCursor(cursor)
      }
    }
    ws.onclose = () => {
      if (socket === ws) socket = null
      setState({ mode: state.lastSyncedAt ? "polling" : "connecting" })
      startPolling()
      scheduleReconnect()
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        // The close handler takes over.
      }
    }
  } catch {
    startPolling()
    scheduleReconnect()
  }
}

function ensureStarted() {
  if (started || typeof window === "undefined") return
  started = true
  connect()
  // A tab that comes back from the background checks at once instead of waiting for the next tick.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void pollOnce()
  })
  window.addEventListener("online", () => {
    void pollOnce()
    if (!socket) connect()
  })
}

function subscribeState(listener: () => void) {
  ensureStarted()
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeState, () => state, () => state)
}

// Calls onChange after data changed anywhere. Debounced, so a burst of saves is one reload, and never delayed past
// maxWaitMs, so a busy floor (a save every few seconds) still refreshes the screen.
export function useLiveChanges(onChange: (change: LiveChange) => void, debounceMs = 400, maxWaitMs = Math.max(debounceMs * 4, 3000)) {
  const callback = useRef(onChange)
  callback.current = onChange
  useEffect(() => {
    ensureStarted()
    let timer: number | null = null
    let firstPendingAt = 0
    let last: LiveChange | null = null
    const fire = () => {
      timer = null
      firstPendingAt = 0
      if (last) callback.current(last)
    }
    const listener = (change: LiveChange) => {
      last = change
      const now = Date.now()
      if (!firstPendingAt) firstPendingAt = now
      if (timer !== null) window.clearTimeout(timer)
      const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - now))
      timer = window.setTimeout(fire, wait)
    }
    changeListeners.add(listener)
    return () => {
      changeListeners.delete(listener)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [debounceMs, maxWaitMs])
}

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
})

// "Just now", "12 s ago", "3 min ago", or the IST clock time for anything older.
export function syncedLabel(at: number | null, now: number): string {
  if (!at) return "Not synced yet"
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 5) return "Synced just now"
  if (seconds < 60) return `Synced ${seconds}s ago`
  if (seconds < 3600) return `Synced ${Math.floor(seconds / 60)} min ago`
  return `Synced ${IST_TIME.format(new Date(at))} IST`
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

const MODE_TEXT: Record<SyncMode, string> = {
  connecting: "Connecting",
  live: "Live",
  polling: "Auto-sync 3.5s",
  offline: "Offline",
}

const MODE_TITLE: Record<SyncMode, string> = {
  connecting: "Connecting to live updates…",
  live: "Live: changes from other screens and phones appear within a second.",
  polling: "Live connection unavailable: checking for changes every 3.5 seconds.",
  offline: "Cannot reach the server. Scans are not lost: the screen retries automatically.",
}

export function LiveSyncBadge({ compact = false }: { compact?: boolean }) {
  const sync = useSyncState()
  const now = useNow(1000)
  return (
    <div className={`live-sync-badge mode-${sync.mode}`} title={`${MODE_TITLE[sync.mode]} ${syncedLabel(sync.lastSyncedAt, now)}.`} role="status">
      <span className="live-sync-dot" aria-hidden="true" />
      <Icon name="wifi" size={15} />
      <strong>{MODE_TEXT[sync.mode]}</strong>
      {!compact && <span className="live-sync-time">{syncedLabel(sync.lastSyncedAt, now)}</span>}
    </div>
  )
}
