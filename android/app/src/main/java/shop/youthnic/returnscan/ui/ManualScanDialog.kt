package shop.youthnic.returnscan.ui

import android.app.Dialog
import android.content.Context
import android.os.Bundle
import android.view.ViewGroup
import android.view.Window
import shop.youthnic.returnscan.data.BarcodeRules
import shop.youthnic.returnscan.databinding.DialogManualScanBinding

class ManualScanDialog(
    context: Context,
    private val onAwbEntered: (String) -> Unit
) : Dialog(context) {

    private val binding = DialogManualScanBinding.inflate(layoutInflater)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        setContentView(binding.root)

        window?.setLayout(
            (context.resources.displayMetrics.widthPixels * 0.90).toInt(),
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        binding.btnCancelManual.setOnClickListener { dismiss() }

        binding.btnSubmitManual.setOnClickListener {
            val text = BarcodeRules.normalize(binding.etManualAwb.text?.toString())
            if (text.isNotBlank()) {
                // Hand the AWB over first: the caller looks it up from the dismiss listener, which runs after dismiss().
                onAwbEntered(text)
                dismiss()
            } else {
                binding.tilManualAwb.error = "Please enter tracking number"
            }
        }
    }
}
