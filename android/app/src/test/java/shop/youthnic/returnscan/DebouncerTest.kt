package shop.youthnic.returnscan

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import shop.youthnic.returnscan.ui.ScannerActivity
import shop.youthnic.returnscan.util.Debouncer

/**
 * The scanner's live refresh (ScannerActivity.liveRefresh): every live change event used to reload the whole scan
 * session. Now the events of about 2 seconds are folded into one request for today's figures. Virtual time, so the
 * test takes no real seconds.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DebouncerTest {

    private val waitMs = ScannerActivity.LIVE_REFRESH_WAIT_MS

    @Test
    fun tenEventsInTwoSecondsCauseOneRequest() = runTest {
        var requests = 0
        val refresh = Debouncer(this, waitMs) { requests++ }

        repeat(10) {
            refresh.trigger()
            advanceTimeBy(190L)
        }
        assertEquals("nothing is fetched while events are still arriving", 0, requests)

        advanceUntilIdle()
        assertEquals(1, requests)
    }

    @Test
    fun aSteadyStreamStillRefreshesEveryWait() = runTest {
        var requests = 0
        val refresh = Debouncer(this, waitMs) { requests++ }

        // One event every 500 ms for 6 seconds: the wait never restarts, so the figures still refresh.
        repeat(12) {
            refresh.trigger()
            advanceTimeBy(500L)
        }
        advanceUntilIdle()
        assertEquals(3, requests)
    }

    @Test
    fun anEventDuringTheRequestStartsTheNextWait() = runTest {
        var requests = 0
        lateinit var refresh: Debouncer
        // A change that lands while the request is being made must not be lost.
        refresh = Debouncer(this, waitMs) {
            requests++
            if (requests == 1) refresh.trigger()
        }

        refresh.trigger()
        advanceUntilIdle()
        assertEquals(2, requests)
    }

    @Test
    fun cancelDropsTheWaitingRequest() = runTest {
        var requests = 0
        val refresh = Debouncer(this, waitMs) { requests++ }

        refresh.trigger()
        runCurrent()
        refresh.cancel()
        advanceUntilIdle()
        assertEquals(0, requests)

        refresh.trigger()
        advanceUntilIdle()
        assertEquals("a later event after cancel still refreshes", 1, requests)
    }
}
