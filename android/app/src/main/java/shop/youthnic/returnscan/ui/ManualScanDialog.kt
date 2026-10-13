package shop.youthnic.returnscan.ui

import android.app.Dialog
import android.content.Context
import android.os.Bundle
import android.view.ViewGroup
import android.view.Window
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
            val text = binding.etManualAwb.text?.toString()?.trim().orEmpty()
            if (text.isNotBlank()) {
                dismiss()
                onAwbEntered(text)
            } else {
                binding.tilManualAwb.error = "Please enter tracking number"
            }
        }
    }
}
