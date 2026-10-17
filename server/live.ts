// Live updates for the web screens and the Android app.
//
// Every change that other screens must see (a scan saved or corrected, a ticket moved, an upload activated, ironed units
// received) writes a row to register_audit_log in the same transaction. The newest audit id is the sync cursor: two
// clients with the same cursor have seen the same data.
//
//  - WebSocket /api/live pushes {type: "change", cursor, kind, marketplaceId, ...} the moment a change is committed,
//    and {type: "tick", cursor} every 15 seconds, so a client that missed a message notices the new cursor.
//  - GET /api/sync/state returns {cursor, serverTime}. A client without a WebSocket polls it every 3-4 seconds and
//    reloads when the cursor moves. That is the fallback, and it works through any proxy.
//
// A client never applies a change from the message itself: it reloads the data through the normal scoped routes, so the
// account rule is applied exactly as on a page load, and a duplicate message cannot double-count anything.

import type { IncomingMessage, Server } from "node:http"
import type pg from "pg"
import { WebSocketServer, type WebSocket } from "ws"
import { allowsAccount, type AccountScope } from "./access.js"

export type ChangeKind = "scan.saved" | "scan.corrected" | "ticket.updated" | "upload.activated" | "iron.received" | "iron.settings" | "iron.batch" | "claim.updated"

export type LiveChange = {
  kind: ChangeKind
  marketplaceId: number | null
  shipmentId?: number
  scanId?: number
  actorId?: number
}

type LiveClient = { socket: WebSocket; userId: number; scope: AccountScope; alive: boolean }

export type LiveAuthenticator = (req: IncomingMessage) => Promise<{ userId: number; scope: AccountScope } | null>

const clients = new Set<LiveClient>()
let poolRef: pg.Pool | null = null
let tickTimer: NodeJS.Timeout | null = null

export async function currentCursor(db: pg.Pool): Promise<number> {
  const row = (await db.query("SELECT COALESCE(MAX(id), 0)::bigint AS cursor FROM register_audit_log")).rows[0]
  return Number(row?.cursor || 0)
}

// Who may see a change: everyone whose scope includes its account. A change with no account (a setting) goes to all.
export function changeVisibleTo(scope: AccountScope, change: Pick<LiveChange, "marketplaceId">): boolean {
  return change.marketplaceId === null || allowsAccount(scope, change.marketplaceId)
}

function send(client: LiveClient, payload: Record<string, unknown>) {
  if (client.socket.readyState !== client.socket.OPEN) return
  try {
    client.socket.send(JSON.stringify(payload))
  } catch {
    // A broken socket is dropped by the heartbeat.
  }
}

// Called after a change is committed. Never throws: a failed push only means clients pick it up on the next poll/tick.
export function publishChange(change: LiveChange): void {
  const db = poolRef
  if (!db || clients.size === 0) return
  currentCursor(db)
    .then((cursor) => {
      const payload = { type: "change", cursor, at: new Date().toISOString(), ...change }
      for (const client of clients) {
        if (changeVisibleTo(client.scope, change)) send(client, payload)
      }
    })
    .catch(() => {})
}

export function liveClientCount(): number {
  return clients.size
}

// Attaches the WebSocket endpoint to the HTTP server. The session is checked on the upgrade request (cookie for the
// browser, Authorization header for the Android app), with the same rule as every API route.
export function attachLiveServer(server: Server, db: pg.Pool, authenticate: LiveAuthenticator): void {
  poolRef = db
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 })

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url || "").split("?")[0]
    if (path !== "/api/live") {
      socket.destroy()
      return
    }
    authenticate(req)
      .then((user) => {
        if (!user) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const client: LiveClient = { socket: ws, userId: user.userId, scope: user.scope, alive: true }
          clients.add(client)
          ws.on("pong", () => {
            client.alive = true
          })
          ws.on("message", () => {
            // The client only listens. Any message is treated as a keep-alive.
            client.alive = true
          })
          ws.on("close", () => clients.delete(client))
          ws.on("error", () => clients.delete(client))
          currentCursor(db)
            .then((cursor) => send(client, { type: "hello", cursor, serverTime: new Date().toISOString() }))
            .catch(() => {})
        })
      })
      .catch(() => {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
        socket.destroy()
      })
  })

  if (tickTimer) clearInterval(tickTimer)
  tickTimer = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        clients.delete(client)
        client.socket.terminate()
        continue
      }
      client.alive = false
      try {
        client.socket.ping()
      } catch {
        clients.delete(client)
      }
    }
    if (clients.size === 0) return
    currentCursor(db)
      .then((cursor) => {
        const payload = { type: "tick", cursor, serverTime: new Date().toISOString() }
        for (const client of clients) send(client, payload)
      })
      .catch(() => {})
  }, 15_000)
}

export function closeLiveServer(): void {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  for (const client of clients) client.socket.terminate()
  clients.clear()
}
