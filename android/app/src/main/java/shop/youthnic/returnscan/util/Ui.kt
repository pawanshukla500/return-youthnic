package shop.youthnic.returnscan.util

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.view.View
import android.widget.TextView
import androidx.annotation.ColorInt
import androidx.annotation.ColorRes
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.roundToInt

object Ui {

    private val indian = Locale("en", "IN")

    fun tint(view: View, @ColorInt color: Int) {
        ViewCompat.setBackgroundTintList(view, ColorStateList.valueOf(color))
    }

    fun pill(view: TextView, @ColorInt text: Int, @ColorInt background: Int) {
        view.setTextColor(text)
        tint(view, background)
    }

    fun pillRes(view: TextView, @ColorRes text: Int, @ColorRes background: Int) {
        val c = view.context
        pill(view, ContextCompat.getColor(c, text), ContextCompat.getColor(c, background))
    }

    @ColorInt
    fun parseColor(hex: String?, @ColorInt fallback: Int): Int {
        if (hex.isNullOrBlank()) return fallback
        return try {
            Color.parseColor(hex.trim())
        } catch (_: IllegalArgumentException) {
            fallback
        }
    }

    fun dp(context: Context, value: Int): Int = (value * context.resources.displayMetrics.density).roundToInt()

    fun count(n: Int): String = NumberFormat.getIntegerInstance(indian).format(n)

    fun megabytes(bytes: Long): String = String.format(Locale.US, "%.1f MB", bytes / 1048576.0)

    // Times: see ServerTime (no Android classes, so it is unit tested on the JVM).
    val IST: TimeZone get() = ServerTime.IST

    fun parseServerTime(value: String?): Date? = ServerTime.parse(value)

    @Deprecated("Ignored the offset of the server time. Use parseServerTime.", ReplaceWith("parseServerTime(iso)"))
    fun parseIsoUtc(iso: String?): Date? = ServerTime.parse(iso)

    fun shortDateTime(date: Date): String = ServerTime.format("d MMM, h:mm a", date)

    fun shortDate(date: Date): String = ServerTime.format("d MMM", date)

    fun istTime(date: Date): String = ServerTime.istTime(date)

    fun istClock(date: Date): String = ServerTime.istClock(date)

    fun ageLabel(atMillis: Long, nowMillis: Long = System.currentTimeMillis()): String = ServerTime.ageLabel(atMillis, nowMillis)
}
