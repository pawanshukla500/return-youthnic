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
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RecentScansDialog(
    context: Context,
    private val scans: List<RecentScan>
) : BottomSheetDialog(context) {

    private val binding = DialogRecentScansBinding.inflate(LayoutInflater.from(context))
    private val timeFormat = SimpleDateFormat("h:mm a", Locale.US)

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
                row.tvRecentTime.text = timeFormat.format(Date(scan.timestamp))

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
