package shop.youthnic.returnscan.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Live updates from the server (server/live.ts): a WebSocket to /api/live while it works, and a poll of /api/sync/state
 * every 4 seconds while it does not. Both carry the sync cursor (the newest audit id). When the cursor moves, [onChange]
 * runs and the scanner reloads today's figures through the normal API, so nothing is counted twice.
 */
class LiveSync(
    private val api: ApiClient,
    private val sessionManager: SessionManager,
    private val scope: CoroutineScope,
    private val onChange: () -> Unit,
    private val onStatus: (Mode, Long) -> Unit,
) {
    enum class Mode { CONNECTING, LIVE, POLLING, OFFLINE }

    @Volatile private var socket: WebSocket? = null
    @Volatile private var mode: Mode = Mode.CONNECTING
    @Volatile private var cursor: Long = 0L
    @Volatile private var lastSyncedAt: Long = 0L
    private var pollJob: Job? = null
    private var reconnectJob: Job? = null
    private var reconnectDelayMs = 2_000L
    @Volatile private var running = false

    fun start() {
        if (running) return
        running = true
        connect()
    }

    fun stop() {
        running = false
        pollJob?.cancel()
        reconnectJob?.cancel()
        pollJob = null
        reconnectJob = null
        socket?.close(1000, "screen closed")
        socket = null
    }

    private fun report(next: Mode) {
        mode = next
        val at = lastSyncedAt
        scope.launch(Dispatchers.Main) { onStatus(next, at) }
    }

    /** The first cursor is only remembered. A later, larger cursor means data changed somewhere. */
    private fun noteCursor(value: Long, forceChange: Boolean) {
        val previous = cursor
        if (value > cursor) cursor = value
        lastSyncedAt = System.currentTimeMillis()
        report(mode)
        if (forceChange || (previous > 0 && value > previous)) {
            scope.launch(Dispatchers.Main) { onChange() }
        }
    }

    private fun connect() {
        if (!running) return
        val token = sessionManager.authToken
        val builder = Request.Builder().url("${sessionManager.serverUrl}/api/live")
        if (!token.isNullOrBlank()) builder.addHeader("Authorization", "Bearer $token")
        try {
            socket = api.okHttpClient.newWebSocket(builder.build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    reconnectDelayMs = 2_000L
                    pollJob?.cancel()
                    pollJob = null
                    lastSyncedAt = System.currentTimeMillis()
                    report(Mode.LIVE)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val json = try { JSONObject(text) } catch (_: Exception) { return }
                    noteCursor(json.optLong("cursor", 0L), json.optString("type") == "change")
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = fallBack(webSocket)

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = fallBack(webSocket)
            })
        } catch (_: Exception) {
            fallBack(null)
        }
    }

    private fun fallBack(closed: WebSocket?) {
        if (closed != null && socket !== closed) return
        socket = null
        if (!running) return
        report(if (lastSyncedAt > 0) Mode.POLLING else Mode.CONNECTING)
        startPolling()
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(reconnectDelayMs)
            reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000L)
            if (running && socket == null) connect()
        }
    }

    private fun startPolling() {
        if (pollJob?.isActive == true) return
        pollJob = scope.launch {
            while (isActive && running) {
                val result = api.getSyncCursor()
                val value = result.getOrNull()
                if (value != null) {
                    if (mode != Mode.LIVE) mode = Mode.POLLING
                    noteCursor(value, false)
                } else if (mode != Mode.LIVE) {
                    report(Mode.OFFLINE)
                }
                delay(POLL_MS)
            }
        }
    }

    companion object {
        const val POLL_MS = 4_000L
    }
}
