package shop.youthnic.returnscan.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import androidx.core.content.ContextCompat
import com.google.android.material.chip.Chip
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.data.IssueCategory

/**
 * Handles visual styling (distinct category colors) and dynamic frequency ordering for issue buttons in the Android app.
 * Matches the exact business logic and color taxonomy used on the web scanner.
 */
object IssueCategoryUi {

    data class CategoryColorRes(
        val primaryRes: Int,
        val bgRes: Int,
        val borderRes: Int
    )

    fun colorsFor(code: String): CategoryColorRes = when (code) {
        IssueCategory.CODE_NO_ISSUE -> CategoryColorRes(
            R.color.issue_clear,
            R.color.issue_clear_bg,
            R.color.issue_clear_border
        )
        IssueCategory.CODE_IRON_SEND -> CategoryColorRes(
            R.color.issue_iron_send,
            R.color.issue_iron_send_bg,
            R.color.issue_iron_send_border
        )
        IssueCategory.CODE_DAMAGED -> CategoryColorRes(
            R.color.issue_damaged,
            R.color.issue_damaged_bg,
            R.color.issue_damaged_border
        )
        IssueCategory.CODE_WRONG -> CategoryColorRes(
            R.color.issue_wrong,
            R.color.issue_wrong_bg,
            R.color.issue_wrong_border
        )
        IssueCategory.CODE_MISSING -> CategoryColorRes(
            R.color.issue_missing,
            R.color.issue_missing_bg,
            R.color.issue_missing_border
        )
        IssueCategory.CODE_SKU_CHANGE -> CategoryColorRes(
            R.color.issue_sku_change,
            R.color.issue_sku_change_bg,
            R.color.issue_sku_change_border
        )
        IssueCategory.CODE_SIZE_CHANGE -> CategoryColorRes(
            R.color.issue_size_change,
            R.color.issue_size_change_bg,
            R.color.issue_size_change_border
        )
        IssueCategory.CODE_OTHER -> CategoryColorRes(
            R.color.issue_other,
            R.color.issue_other_bg,
            R.color.issue_other_border
        )
        else -> CategoryColorRes(
            R.color.colorPrimary,
            R.color.brand_soft,
            R.color.border
        )
    }

    private const val PREFS_NAME = "return_scan_issue_frequency"

    // High baseline weights ensuring healthy initial order: No Issue 1st, Iron Send 2nd, Damaged 3rd, etc.
    private val BASELINE_FREQUENCIES = mapOf(
        IssueCategory.CODE_NO_ISSUE to 100000,
        IssueCategory.CODE_IRON_SEND to 50000,
        IssueCategory.CODE_DAMAGED to 40000,
        IssueCategory.CODE_WRONG to 30000,
        IssueCategory.CODE_MISSING to 20000,
        IssueCategory.CODE_SKU_CHANGE to 15000,
        IssueCategory.CODE_SIZE_CHANGE to 10000,
        IssueCategory.CODE_OTHER to 5000
    )

    fun recordUsage(context: Context, code: String) {
        if (code.isBlank()) return
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val current = prefs.getInt("freq_$code", 0)
        prefs.edit().putInt("freq_$code", current + 1).apply()
    }

    fun getFrequency(context: Context, code: String): Int {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val baseline = BASELINE_FREQUENCIES[code] ?: 0
        return baseline + prefs.getInt("freq_$code", 0)
    }

    /**
     * Orders categories so Clear Return is always first, then sorted descending by frequency score (most frequently used moved forward).
     */
    fun sortCategories(context: Context, categories: List<IssueCategory>): List<IssueCategory> {
        return categories.sortedWith { a, b ->
            if (a.isClear && !b.isClear) -1
            else if (!a.isClear && b.isClear) 1
            else {
                val freqA = getFrequency(context, a.code)
                val freqB = getFrequency(context, b.code)
                if (freqB != freqA) {
                    freqB.compareTo(freqA)
                } else {
                    a.label.compareTo(b.label)
                }
            }
        }
    }

    /**
     * Applies distinctive Material choice-chip color styling:
     * - Unchecked: soft tinted background, colored outline border, colored text.
     * - Checked: solid vibrant category background, matching border, crisp white text.
     */
    fun applyColorStyle(chip: Chip, code: String) {
        val context = chip.context
        val c = colorsFor(code)
        val primary = ContextCompat.getColor(context, c.primaryRes)
        val bg = ContextCompat.getColor(context, c.bgRes)
        val border = ContextCompat.getColor(context, c.borderRes)

        val states = arrayOf(
            intArrayOf(android.R.attr.state_checked),
            intArrayOf(-android.R.attr.state_checked)
        )

        val bgColors = intArrayOf(primary, bg)
        chip.chipBackgroundColor = ColorStateList(states, bgColors)

        val strokeColors = intArrayOf(primary, border)
        chip.chipStrokeColor = ColorStateList(states, strokeColors)
        chip.chipStrokeWidth = 1.5f * context.resources.displayMetrics.density

        val textColors = intArrayOf(Color.WHITE, primary)
        chip.setTextColor(ColorStateList(states, textColors))
    }
}
