package shop.youthnic.returnscan.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.chip.Chip
import kotlinx.coroutines.launch
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.IssueCategory
import shop.youthnic.returnscan.data.LookupItem
import shop.youthnic.returnscan.data.LookupResult
import shop.youthnic.returnscan.data.ScanSessionData
import shop.youthnic.returnscan.data.SubIssue
import shop.youthnic.returnscan.databinding.ItemVerificationProductBinding
import shop.youthnic.returnscan.databinding.SheetReturnVerificationBinding
import shop.youthnic.returnscan.util.Ui

data class ItemVerificationState(
    val itemId: String,
    var receivedQty: Int,
    var physicalChecked: Boolean,
    var categoryCode: String,
    var subIssueId: String?,
    var notes: String
)

data class VerificationSubmitData(
    val shipmentId: String,
    val scannedTracking: String,
    val items: List<ItemVerificationState>
)

class ReturnVerificationBottomSheet(
    private val activity: AppCompatActivity,
    private val lookup: LookupResult,
    private val sessionData: ScanSessionData,
    private val onSave: (VerificationSubmitData) -> Unit,
    private val onCancel: () -> Unit
) : BottomSheetDialog(activity, R.style.ThemeOverlay_Youthnic_BottomSheetDialog) {

    private val binding = SheetReturnVerificationBinding.inflate(LayoutInflater.from(activity))
    private val itemStates = mutableListOf<ItemVerificationState>()
    private val productBindings = mutableListOf<ItemVerificationProductBinding>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(binding.root)

        // Expand bottom sheet fully
        window?.findViewById<FrameLayout>(com.google.android.material.R.id.design_bottom_sheet)?.let { sheet ->
            val behavior = BottomSheetBehavior.from(sheet)
            behavior.state = BottomSheetBehavior.STATE_EXPANDED
            behavior.skipCollapsed = true
            behavior.isHideable = true
        }

        populateHeaderAndShipment()
        populateProducts()
        setupActions()
    }

    private fun populateHeaderAndShipment() {
        binding.tvSheetAwb.text = lookup.trackingNumber
        binding.tvSheetMarketplace.text = lookup.marketplace.ifBlank { "Marketplace" }

        if (lookup.carrier.isNotBlank()) {
            binding.tvSheetCarrier.text = lookup.carrier
            binding.tvSheetCarrier.visibility = View.VISIBLE
        } else {
            binding.tvSheetCarrier.visibility = View.GONE
        }

        if (lookup.returnType.isNotBlank()) {
            binding.tvSheetReturnType.text = lookup.returnType
            binding.tvSheetReturnType.visibility = View.VISIBLE
        } else {
            binding.tvSheetReturnType.visibility = View.GONE
        }

        binding.tvSheetOrderId.text = lookup.orderId.ifBlank { "N/A" }
        binding.tvSheetShipmentId.text = lookup.shipmentId.ifBlank { "N/A" }

        val reason = lookup.returnReason
        if (reason.isNotBlank()) {
            binding.tvSheetReturnReason.text = "Reason: $reason"
            binding.tvSheetReturnReason.visibility = View.VISIBLE
        } else {
            binding.tvSheetReturnReason.visibility = View.GONE
        }

        binding.tvSheetMatchLeg.text = "Return Leg Verified"
    }

    private fun populateProducts() {
        binding.layoutProductsList.removeAllViews()
        itemStates.clear()
        productBindings.clear()

        val inflater = LayoutInflater.from(activity)
        val imageCache = (activity.application as ReturnScanApp).imageCache

        val items = if (lookup.items.isNotEmpty()) lookup.items else {
            listOf(
                LookupItem(
                    itemId = lookup.shipmentId,
                    marketplaceSku = lookup.sku,
                    masterSku = lookup.masterSku,
                    title = lookup.productTitle,
                    quantity = lookup.expectedQty,
                    imageUrl = lookup.imageUrl
                )
            )
        }

        for (item in items) {
            val pBinding = ItemVerificationProductBinding.inflate(inflater, binding.layoutProductsList, false)
            val state = ItemVerificationState(
                itemId = item.itemId,
                receivedQty = item.quantity,
                physicalChecked = true,
                categoryCode = "CLEAR",
                subIssueId = null,
                notes = ""
            )
            itemStates.add(state)
            productBindings.add(pBinding)

            // Titles and SKUs
            pBinding.tvItemTitle.text = item.title.ifBlank { "Returned Product" }
            pBinding.tvMarketplaceSku.text = "Marketplace SKU: ${item.marketplaceSku.ifBlank { "N/A" }}"
            pBinding.tvProductSku.text = "Master SKU: ${item.masterSku.ifBlank { item.marketplaceSku }}"
            pBinding.tvExpectedUnits.text = "Expected: ${item.quantity}"
            pBinding.tvReceivedQty.text = state.receivedQty.toString()
            pBinding.cbPhysicalChecked.isChecked = state.physicalChecked

            // Image handling: async cache & thumbnail
            val imgUrl = item.imageUrl
            if (imgUrl.isNotBlank()) {
                activity.lifecycleScope.launch {
                    val bmp = imageCache.getOrFetch(imgUrl)
                    if (bmp != null) {
                        pBinding.ivProductThumb.setImageBitmap(bmp)
                    } else {
                        pBinding.ivProductThumb.setImageResource(android.R.drawable.ic_menu_gallery)
                    }
                }
                pBinding.ivProductThumb.setOnClickListener {
                    val intent = Intent(activity, ImageViewerActivity::class.java).apply {
                        putExtra(ImageViewerActivity.EXTRA_IMAGE_URL, imgUrl)
                        putExtra(ImageViewerActivity.EXTRA_TITLE, "${item.title} · ${item.masterSku}")
                    }
                    activity.startActivity(intent)
                }
            } else {
                pBinding.ivProductThumb.setImageResource(android.R.drawable.ic_menu_gallery)
            }

            // Received Qty Stepper
            pBinding.btnQtyMinus.setOnClickListener {
                if (state.receivedQty > 0) {
                    state.receivedQty--
                    pBinding.tvReceivedQty.text = state.receivedQty.toString()
                }
            }
            pBinding.btnQtyPlus.setOnClickListener {
                state.receivedQty++
                pBinding.tvReceivedQty.text = state.receivedQty.toString()
            }

            // Physical check checkbox
            pBinding.cbPhysicalChecked.setOnCheckedChangeListener { _, isChecked ->
                state.physicalChecked = isChecked
            }

            // Issue Categories setup
            setupIssueChips(pBinding, state, sessionData)

            binding.layoutProductsList.addView(pBinding.root)
        }
    }

    private fun setupIssueChips(
        pBinding: ItemVerificationProductBinding,
        state: ItemVerificationState,
        sessionData: ScanSessionData
    ) {
        // Clear sub-issues initially
        pBinding.layoutSubIssues.visibility = View.GONE
        pBinding.chipGroupSubIssues.removeAllViews()

        pBinding.chipGroupIssues.setOnCheckedStateChangeListener { _, checkedIds ->
            val checkedId = checkedIds.firstOrNull() ?: R.id.chipClear
            when (checkedId) {
                R.id.chipClear -> {
                    state.categoryCode = "CLEAR"
                    state.subIssueId = null
                    pBinding.layoutSubIssues.visibility = View.GONE
                }
                R.id.chipMissing -> {
                    state.categoryCode = "MISSING_COMPONENT"
                    pBinding.layoutSubIssues.visibility = View.VISIBLE
                    populateSubIssues(pBinding, state, sessionData)
                }
                R.id.chipWrong -> {
                    state.categoryCode = "WRONG_PRODUCT"
                    state.subIssueId = null
                    pBinding.layoutSubIssues.visibility = View.GONE
                }
                R.id.chipDamaged -> {
                    state.categoryCode = "DAMAGED_PRODUCT"
                    state.subIssueId = null
                    pBinding.layoutSubIssues.visibility = View.GONE
                }
                R.id.chipSkuChange -> {
                    state.categoryCode = "SKU_CHANGE"
                    state.subIssueId = null
                    pBinding.layoutSubIssues.visibility = View.GONE
                }
                R.id.chipSizeChange -> {
                    state.categoryCode = "SIZE_CHANGE"
                    state.subIssueId = null
                    pBinding.layoutSubIssues.visibility = View.GONE
                }
                R.id.chipOther -> {
                    state.categoryCode = "OTHER"
                    state.subIssueId = null
                    pBinding.layoutSubIssues.visibility = View.GONE
                }
            }
        }
    }

    private fun populateSubIssues(
        pBinding: ItemVerificationProductBinding,
        state: ItemVerificationState,
        sessionData: ScanSessionData
    ) {
        pBinding.chipGroupSubIssues.removeAllViews()

        // Missing item options from backend or standard defaults
        val missingOptions = if (sessionData.missingComponents.isNotEmpty()) {
            sessionData.missingComponents
        } else {
            listOf(
                SubIssue("missing_dupatta", "Missing Dupatta"),
                SubIssue("missing_bottom", "Missing Bottom / Salwar"),
                SubIssue("missing_top", "Missing Top / Kurti"),
                SubIssue("missing_inner", "Missing Inner / Lining"),
                SubIssue("missing_belt", "Missing Belt / Accessories")
            )
        }

        val inflater = LayoutInflater.from(activity)
        for (sub in missingOptions) {
            val chip = inflater.inflate(
                com.google.android.material.R.layout.mtrl_chip_input_layout,
                pBinding.chipGroupSubIssues,
                false
            ) as? Chip ?: Chip(activity).apply {
                isCheckable = true
                isClickable = true
            }
            chip.text = sub.name
            chip.id = View.generateViewId()
            chip.setOnCheckedChangeListener { _, isChecked ->
                if (isChecked) {
                    state.subIssueId = sub.id
                } else if (state.subIssueId == sub.id) {
                    state.subIssueId = null
                }
            }
            pBinding.chipGroupSubIssues.addView(chip)
        }
    }

    private fun setupActions() {
        binding.btnCloseSheet.setOnClickListener {
            dismiss()
            onCancel()
        }

        binding.btnCancelVerification.setOnClickListener {
            dismiss()
            onCancel()
        }

        binding.btnSaveVerification.setOnClickListener {
            if (validateInputs()) {
                binding.btnSaveVerification.isEnabled = false
                binding.btnSaveVerification.text = "Saving..."
                onSave(
                    VerificationSubmitData(
                        shipmentId = lookup.shipmentId,
                        scannedTracking = lookup.trackingNumber,
                        items = itemStates
                    )
                )
            }
        }
    }

    private fun validateInputs(): Boolean {
        binding.tvVerificationError.visibility = View.GONE

        for (i in itemStates.indices) {
            val state = itemStates[i]
            val pBinding = productBindings[i]

            state.notes = pBinding.etItemNotes.text?.toString()?.trim().orEmpty()

            if (!state.physicalChecked) {
                showError("Please check physical condition inspected for item #${i + 1}")
                return false
            }

            if (state.categoryCode == "MISSING_COMPONENT" && state.subIssueId.isNullOrBlank()) {
                showError("Please select which component is missing for item #${i + 1}")
                return false
            }

            if ((state.categoryCode == "WRONG_PRODUCT" || state.categoryCode == "OTHER") && state.notes.isBlank()) {
                showError("Please enter notes explaining the issue for item #${i + 1}")
                pBinding.etItemNotes.requestFocus()
                return false
            }
        }

        return true
    }

    fun showSaveError(message: String) {
        binding.btnSaveVerification.isEnabled = true
        binding.btnSaveVerification.text = activity.getString(R.string.btn_save_return)
        showError(message)
    }

    private fun showError(message: String) {
        binding.tvVerificationError.text = message
        binding.tvVerificationError.visibility = View.VISIBLE
    }
}
