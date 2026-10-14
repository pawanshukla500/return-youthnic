package shop.youthnic.returnscan.ui

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import androidx.core.content.ContextCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.data.RecentScan
import shop.youthnic.returnscan.databinding.DialogRecentScansBinding
import shop.youthnic.returnscan.databinding.ItemRecentScanRowBinding
import shop.youthnic.returnscan.util.Ui

class RecentScansDialog(
    context: Context,
    private val scans: List<RecentScan>
) : BottomSheetDialog(context) {

    private val binding = DialogRecentScansBinding.inflate(LayoutInflater.from(context))

    init {
        setContentView(binding.root)

        binding.btnCloseRecent.setOnClickListener { dismiss() }

        if (scans.isEmpty()) {
            binding.tvEmptyRecent.visibility = View.VISIBLE
        } else {
            binding.tvEmptyRecent.visibility = View.GONE
            val inflater = LayoutInflater.from(context)

            for (scan in scans.reversed()) { // Show newest first
                val row = ItemRecentScanRowBinding.inflate(inflater, binding.layoutRecentScansList, false)
                row.tvRecentAwb.text = scan.awb

                val metaText = listOf(scan.marketplace, scan.courier, scan.itemsSummary)
                    .filter { it.isNotBlank() }
                    .joinToString(" · ")
                row.tvRecentMeta.text = metaText.ifBlank { "Return Scan" }
                // The timestamp is epoch milliseconds (saved on this phone) or the server's UTC time. Both are shown in IST.
                val displayTime = Ui.parseServerTime(scan.timestamp)?.let { Ui.istTime(it) }
                    ?: scan.timestamp.ifBlank { "Just now" }
                row.tvRecentTime.text = displayTime

                row.tvRecentOutcomeBadge.text = scan.outcome
                val isNormal = scan.outcome.equals("NORMAL", ignoreCase = true) ||
                        scan.outcome.equals("CLEAR", ignoreCase = true) ||
                        scan.outcome.contains("Clear", ignoreCase = true)

                if (isNormal) {
                    Ui.pillRes(row.tvRecentOutcomeBadge, R.color.verdict_ok, R.color.verdict_ok_bg)
                } else {
                    Ui.pillRes(row.tvRecentOutcomeBadge, R.color.verdict_check, R.color.verdict_check_bg)
                }

                binding.layoutRecentScansList.addView(row.root)
            }
        }
    }
}
