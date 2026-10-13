package shop.youthnic.returnscan.ui

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.chip.Chip
import kotlinx.coroutines.launch
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.IssueCategory
import shop.youthnic.returnscan.data.ItemVerificationState
import shop.youthnic.returnscan.data.LookupResult
import shop.youthnic.returnscan.data.ScanPayload
import shop.youthnic.returnscan.data.ScanSessionData
import shop.youthnic.returnscan.data.VerificationSubmitData
import shop.youthnic.returnscan.databinding.ItemVerificationProductBinding
import shop.youthnic.returnscan.databinding.SheetReturnVerificationBinding

/**
 * Physical verification of one found return. The categories, the missing-item options and the rules for each come from
 * the server (GET /api/scan/session), so a code sent back is always one the server accepts. Dismissing the sheet in any
 * way is reported through the dialog's own dismiss listener, which the scanner sets.
 */
class ReturnVerificationBottomSheet(
    private val activity: AppCompatActivity,
    private val lookup: LookupResult,
    private val sessionData: ScanSessionData,
    private val onSave: (VerificationSubmitData) -> Unit
) : BottomSheetDialog(activity, R.style.ThemeOverlay_ReturnScan_BottomSheet) {

    private val binding = SheetReturnVerificationBinding.inflate(LayoutInflater.from(activity))
    private val itemStates = mutableListOf<ItemVerificationState>()
    private val productBindings = mutableListOf<ItemVerificationProductBinding>()

    /** The category with is_clear set. The server seeds it as "no_issue". */
    private val clearCategory: IssueCategory =
        sessionData.categories.firstOrNull { it.isClear }
            ?: IssueCategory(
                code = IssueCategory.CODE_NO_ISSUE,
                label = "No issue",
                isClear = true,
                isMissing = false,
                requiresTicket = false,
                allowsSubIssue = false,
                requiresSubIssue = false
            )

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

        // Which stored AWB the scan matched, as the server reports it (the web screen shows the same words).
        when (lookup.matchLeg) {
            "return" -> binding.tvSheetMatchLeg.text = "Return leg"
            "forward" -> binding.tvSheetMatchLeg.text = "Forward leg"
            else -> binding.tvSheetMatchLeg.text = ""
        }
    }

    private fun populateProducts() {
        binding.layoutProductsList.removeAllViews()
        itemStates.clear()
        productBindings.clear()

        val inflater = LayoutInflater.from(activity)
        val imageCache = (activity.application as ReturnScanApp).imageCache

        for (item in lookup.items) {
            val pBinding = ItemVerificationProductBinding.inflate(inflater, binding.layoutProductsList, false)
            val state = ItemVerificationState(
                itemId = item.itemId,
                expectedQty = item.quantity,
                receivedQty = item.quantity,
                physicalChecked = true,
                category = clearCategory,
                subIssueId = null,
                ticketCode = "",
                notes = ""
            )
            itemStates.add(state)
            productBindings.add(pBinding)

            // Titles and SKUs
            pBinding.tvItemTitle.text = item.title.ifBlank { "Returned Product" }
            val skuLine = "Marketplace SKU: ${item.marketplaceSku.ifBlank { "N/A" }}"
            pBinding.tvMarketplaceSku.text = if (item.detailLine.isNotBlank()) skuLine + "\n" + item.detailLine else skuLine
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

            // Received Qty Stepper: from 0 up to the expected units
            pBinding.btnQtyMinus.setOnClickListener {
                if (state.receivedQty > 0) {
                    state.receivedQty--
                    pBinding.tvReceivedQty.text = state.receivedQty.toString()
                }
            }
            pBinding.btnQtyPlus.setOnClickListener {
                if (state.receivedQty < state.expectedQty) {
                    state.receivedQty++
                    pBinding.tvReceivedQty.text = state.receivedQty.toString()
                }
            }

            // Units affected (a line with more than one unit, for an issue that is not a missing item)
            pBinding.btnAffectedMinus.setOnClickListener {
                if (state.affectedUnits > 1) {
                    state.affectedUnits--
                    pBinding.tvAffectedQty.text = state.affectedUnits.toString()
                }
            }
            pBinding.btnAffectedPlus.setOnClickListener {
                if (state.affectedUnits < state.receivedQty) {
                    state.affectedUnits++
                    pBinding.tvAffectedQty.text = state.affectedUnits.toString()
                }
            }

            // Physical check checkbox
            pBinding.cbPhysicalChecked.setOnCheckedChangeListener { _, isChecked ->
                state.physicalChecked = isChecked
            }

            // Issue Categories setup
            setupIssueChips(pBinding, state)

            binding.layoutProductsList.addView(pBinding.root)
        }
    }

    /** The category an inspection chip stands for. The code is the server's, so it is the same one the web screen sends. */
    private fun categoryCodeFor(chipId: Int): String? = when (chipId) {
        R.id.chipClear -> clearCategory.code
        R.id.chipMissing -> IssueCategory.CODE_MISSING
        R.id.chipWrong -> IssueCategory.CODE_WRONG
        R.id.chipDamaged -> IssueCategory.CODE_DAMAGED
        R.id.chipSkuChange -> IssueCategory.CODE_SKU_CHANGE
        R.id.chipSizeChange -> IssueCategory.CODE_SIZE_CHANGE
        R.id.chipOther -> IssueCategory.CODE_OTHER
        else -> null
    }

    private fun setupIssueChips(pBinding: ItemVerificationProductBinding, state: ItemVerificationState) {
        pBinding.layoutSubIssues.visibility = View.GONE
        pBinding.chipGroupSubIssues.removeAllViews()
        pBinding.tilTicketCode.visibility = View.GONE
        pBinding.layoutAffectedUnits.visibility = View.GONE

        // An administrator can switch a category off. A chip for a category the server no longer offers is hidden.
        val chips = listOf(
            pBinding.chipMissing, pBinding.chipWrong, pBinding.chipDamaged,
            pBinding.chipSkuChange, pBinding.chipSizeChange, pBinding.chipOther
        )
        for (chip in chips) {
            val code = categoryCodeFor(chip.id)
            chip.visibility = if (code != null && sessionData.categoryOf(code) != null) View.VISIBLE else View.GONE
        }

        pBinding.chipGroupIssues.setOnCheckedStateChangeListener { _, checkedIds ->
            val checkedId = checkedIds.firstOrNull() ?: R.id.chipClear
            val code = categoryCodeFor(checkedId) ?: clearCategory.code
            val category = if (code == clearCategory.code) clearCategory else sessionData.categoryOf(code) ?: clearCategory
            chooseCategory(pBinding, state, category)
        }
    }

    private fun chooseCategory(pBinding: ItemVerificationProductBinding, state: ItemVerificationState, category: IssueCategory) {
        state.category = category
        state.subIssueId = null
        binding.tvVerificationError.visibility = View.GONE

        // The same one-tap rule as the web screen: a missing item means none of the line arrived; any other choice means
        // every unit arrived. The stepper can still be changed afterwards.
        state.receivedQty = if (category.isMissing) 0 else state.expectedQty
        pBinding.tvReceivedQty.text = state.receivedQty.toString()

        // A one-tap issue starts as all units affected. The scanner can lower it when only some units have the problem.
        state.affectedUnits = state.expectedQty
        pBinding.tvAffectedQty.text = state.affectedUnits.toString()
        val showAffected = !category.isClear && !category.isMissing && state.expectedQty > 1
        pBinding.layoutAffectedUnits.visibility = if (showAffected) View.VISIBLE else View.GONE

        if (category.allowsSubIssue) {
            pBinding.layoutSubIssues.visibility = View.VISIBLE
            populateSubIssues(pBinding, state, category)
        } else {
            pBinding.layoutSubIssues.visibility = View.GONE
            pBinding.chipGroupSubIssues.removeAllViews()
        }
        pBinding.tilTicketCode.visibility = if (category.requiresTicket) View.VISIBLE else View.GONE
    }

    private fun populateSubIssues(
        pBinding: ItemVerificationProductBinding,
        state: ItemVerificationState,
        category: IssueCategory
    ) {
        pBinding.chipGroupSubIssues.removeAllViews()

        // Only the options the server lists for this category. An id the server does not know would be refused on save.
        val options = sessionData.subIssuesFor(category.code)
        if (options.isEmpty() && category.requiresSubIssue) {
            showError(activity.getString(R.string.no_missing_options))
        }

        for (sub in options) {
            val chip = Chip(activity).apply {
                isCheckable = true
                isClickable = true
                text = sub.name
                id = View.generateViewId()
            }
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
        binding.btnCloseSheet.setOnClickListener { dismiss() }

        binding.btnCancelVerification.setOnClickListener { dismiss() }

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
            state.ticketCode = pBinding.etTicketCode.text?.toString()?.trim().orEmpty()

            val problem = ScanPayload.problemWith(state, "item #${i + 1}")
            if (problem != null) {
                showError(problem)
                if (problem.contains("ticket ID")) {
                    pBinding.etTicketCode.requestFocus()
                } else if (problem.contains("notes")) {
                    pBinding.etItemNotes.requestFocus()
                }
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
