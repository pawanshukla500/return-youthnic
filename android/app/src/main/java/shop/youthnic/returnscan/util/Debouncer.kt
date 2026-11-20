package shop.youthnic.returnscan.util

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Folds a burst of events into one call. The first [trigger] starts a wait of [waitMs]; every trigger during the wait
 * joins it, and [action] runs once when the wait ends. The wait never restarts, so a non-stop stream of events still
 * runs [action] once every [waitMs] instead of never. A trigger that comes while [action] runs starts the next wait, so
 * no change is missed. Call it from one thread (the scanner uses the main thread). No Android classes here, so the JVM
 * unit tests cover it (DebouncerTest).
 */
class Debouncer(
    private val scope: CoroutineScope,
    private val waitMs: Long,
    private val action: () -> Unit,
) {
    private var pending: Job? = null

    fun trigger() {
        if (pending != null) return
        pending = scope.launch {
            delay(waitMs)
            pending = null
            action()
        }
    }

    /** Drops a waiting call. */
    fun cancel() {
        pending?.cancel()
        pending = null
    }
}
