package shop.youthnic.returnscan.util

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Server times and the clock on screen. The server sends UTC ISO-8601 ("2026-10-14T09:15:22.123Z"). Every time shown to
 * the warehouse is India Standard Time, whatever timezone the phone is set to. No Android classes here, so the JVM unit
 * tests cover it (ServerTimeTest).
 */
object ServerTime {

    val IST: TimeZone = TimeZone.getTimeZone("Asia/Kolkata")
    private val indian = Locale("en", "IN")
    private val ISO = Regex("""^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$""")

    /**
     * Parses ISO-8601 with "Z", with an offset such as "+05:30", or with no zone (taken as UTC), with or without
     * milliseconds; or epoch milliseconds. The offset is applied, never dropped. Null when the text is not a time.
     */
    fun parse(value: String?): Date? {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) return null
        text.toLongOrNull()?.let { return if (it > 0) Date(it) else null }
        val m = ISO.matchEntire(text) ?: return null
        val g = m.groupValues
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.clear()
        cal.set(g[1].toInt(), g[2].toInt() - 1, g[3].toInt(), g[4].toInt(), g[5].toInt(), g[6].toInt())
        val fraction = g[7]
        val millis = if (fraction.length > 1) fraction.substring(1).padEnd(3, '0').take(3).toInt() else 0
        var epoch = cal.timeInMillis + millis
        val zone = g[8]
        if (zone.isNotEmpty() && zone != "Z") {
            val sign = if (zone[0] == '-') -1 else 1
            val digits = zone.substring(1).replace(":", "")
            val offsetMs = (digits.substring(0, 2).toInt() * 60 + digits.substring(2, 4).toInt()) * 60_000L
            epoch -= sign * offsetMs
        }
        return Date(epoch)
    }

    fun format(pattern: String, date: Date): String =
        SimpleDateFormat(pattern, indian).apply { timeZone = IST }.format(date)

    /** "2:45 PM" in IST. */
    fun istTime(date: Date): String = format("h:mm a", date)

    /** "2:45:10 PM" in IST. */
    fun istClock(date: Date): String = format("h:mm:ss a", date)

    /** "Just now", "40s ago", "3 min ago", then the IST time ("at 2:45 PM"). The screen refreshes it while it shows. */
    fun ageLabel(atMillis: Long, nowMillis: Long): String {
        if (atMillis <= 0L) return ""
        val seconds = ((nowMillis - atMillis) / 1000L).coerceAtLeast(0L)
        return when {
            seconds < 10 -> "Just now"
            seconds < 60 -> "${seconds}s ago"
            seconds < 3600 -> "${seconds / 60} min ago"
            else -> "at ${istTime(Date(atMillis))}"
        }
    }
}
