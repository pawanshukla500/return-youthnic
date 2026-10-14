package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import shop.youthnic.returnscan.util.ServerTime

/**
 * The "Last scan" / "Synced" times on the scanner. The server sends UTC ("...Z"). The old parser cut the text at 19
 * characters, so an offset was dropped, and the recent-scans list showed the raw UTC text, 5 h 30 min behind IST.
 */
class ServerTimeTest {

    @Test
    fun utcServerTimeIsShownInIst() {
        val date = ServerTime.parse("2026-10-14T09:15:22.123Z")!!
        assertEquals(1791969322123L, date.time)
        assertEquals("2:45 pm", ServerTime.istTime(date).lowercase())
        assertEquals("2:45:22 pm", ServerTime.istClock(date).lowercase())
    }

    @Test
    fun offsetIsAppliedNotDropped() {
        val ist = ServerTime.parse("2026-10-14T14:45:22+05:30")!!
        val utc = ServerTime.parse("2026-10-14T09:15:22Z")!!
        assertEquals(utc.time, ist.time)
        assertEquals(utc.time, ServerTime.parse("2026-10-14T14:45:22+0530")!!.time)
        assertEquals(utc.time, ServerTime.parse("2026-10-14T09:15:22")!!.time)
    }

    @Test
    fun epochMillisAndJunk() {
        assertEquals(1791969322123L, ServerTime.parse("1791969322123")!!.time)
        assertNull(ServerTime.parse(""))
        assertNull(ServerTime.parse("2:45 PM"))
        assertNull(ServerTime.parse(null))
    }

    @Test
    fun ageLabelMovesOnInsteadOfStayingAtJustNow() {
        val at = 1791969322123L
        assertEquals("Just now", ServerTime.ageLabel(at, at + 3_000))
        assertEquals("45s ago", ServerTime.ageLabel(at, at + 45_000))
        assertEquals("12 min ago", ServerTime.ageLabel(at, at + 12 * 60_000))
        assertEquals("at 2:45 pm", ServerTime.ageLabel(at, at + 2 * 3600_000).lowercase())
        assertEquals("", ServerTime.ageLabel(0, at))
    }
}
