package shop.youthnic.returnscan.ui

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Observer
import androidx.lifecycle.lifecycleScope
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.claim.ClaimEvidenceUploadWorker
import shop.youthnic.returnscan.claim.DraftFile
import shop.youthnic.returnscan.claim.EvidenceDraft
import shop.youthnic.returnscan.claim.EvidenceDraftStore
import shop.youthnic.returnscan.claim.EvidenceUploads
import shop.youthnic.returnscan.data.BenchScan
import shop.youthnic.returnscan.data.ClaimFieldTemplate
import shop.youthnic.returnscan.data.ClaimFormInput
import shop.youthnic.returnscan.data.ClaimPayload
import shop.youthnic.returnscan.data.ClaimProductItem
import shop.youthnic.returnscan.data.ClaimReturnLookup
import shop.youthnic.returnscan.data.ClaimTemplate
import shop.youthnic.returnscan.data.ImageCache
import shop.youthnic.returnscan.databinding.ActivityClaimCaptureBinding
import shop.youthnic.returnscan.databinding.ItemClaimEvidenceCardBinding
import shop.youthnic.returnscan.util.EvidencePhoto
import shop.youthnic.returnscan.util.EvidencePhotoSizing
import java.io.File
import java.util.UUID

class ClaimCaptureActivity : AppCompatActivity() {

    private lateinit var binding: ActivityClaimCaptureBinding
    private val api get() = (application as ReturnScanApp).apiClient
    private val imageCache get() = (application as ReturnScanApp).imageCache
    private val sessionManager get() = (application as ReturnScanApp).sessionManager

    private var lookupData: ClaimReturnLookup? = null
    /**
     * The bench scan File Claim saved before opening this screen (EXTRA_SCAN_ID), or null when the screen was opened
     * another way. The claim for that return is filed on this scan, whatever scan the lookup names.
     */
    private var benchScan: BenchScan? = null
    private var selectedTemplate: ClaimTemplate? = null
    private var currentStep = 1 // 1: Return Details, 2: Upload Images

    // Meesho Issue Options
    private val meeshoIssues = listOf(
        Pair("wrong_return", "I have received wrong return"),
        Pair("missing_items", "Item/s are missing in my return"),
        Pair("wrong_barcode_rto", "I have received a wrong barcoded package in RTO"),
        Pair("damaged_return", "I have received damaged return"),
        Pair("used_product", "I have received used product as return")
    )
    private var selectedIssueCode = "wrong_return"
    private var selectedIssueLabel = "I have received wrong return"
    // Parcel condition options: operator-observed shipment state, never assumed.
    // Unknown blocks automatic submission and routes the claim to operator review.
    private val packetStates = listOf(
        Pair("Intact", "Intact"),
        Pair("Tampered", "Tampered"),
        Pair("Unknown", "Unknown (requires review)")
    )
    private var selectedPacketState = "Unknown"

    // Captured evidence files keyed by fieldKey
    private data class CapturedFile(
        val file: File,
        val mimeType: String,
        val fieldKey: String
    )
    private val capturedFiles = mutableMapOf<String, MutableList<CapturedFile>>()
    private val evidenceCardBindings = mutableMapOf<String, ItemClaimEvidenceCardBinding>()
    /** Each slot's maxCount, so a Product images card shows 0 / 10 (or 3 / 10) and Attachments 0 / 5. */
    private val evidenceMaxCounts = mutableMapOf<String, Int>()

    private var pendingFieldKey = ""
    private var pendingPhotoFile: File? = null
    /** Bumped each time captured evidence is cleared, so a photo still being shrunk never joins another return's claim. */
    private var evidenceGeneration = 0
    /** Camera photos still being shrunk; Submit waits for them so none is left off the claim. */
    private var photosBeingSaved = 0
    /** Captured evidence and the photo being taken, saved on every change so killing the app loses neither. */
    private val evidenceDraftStore by lazy { EvidenceDraftStore(File(filesDir, EvidenceUploads.DRAFT_FILE)) }
    /** The return the captured evidence belongs to (ClaimPayload.returnKey), saved with it. */
    private var evidenceReturnKey = ""

    // Activity Result Launchers
    private val takePhotoLauncher = registerForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val file = pendingPhotoFile
        pendingPhotoFile = null
        if (success && file != null && file.exists()) {
            acceptCameraPhoto(file, pendingFieldKey)
        } else {
            file?.delete()
            saveEvidenceDraft()
        }
    }

    /** Shrinks a camera photo off the main thread, then adds it to [fieldKey] unless the evidence was cleared meanwhile. */
    private fun acceptCameraPhoto(file: File, fieldKey: String) {
        val generation = evidenceGeneration
        photosBeingSaved++
        // The camera app writes the photo at full resolution (12 MP and up); shrink it off the main thread first.
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { EvidencePhoto.downscaleInPlace(file) }
                if (generation == evidenceGeneration) {
                    recordCapturedEvidence(fieldKey, file, "image/jpeg")
                } else {
                    file.delete()
                }
            } finally {
                photosBeingSaved--
            }
        }
    }

    private var pendingPermissionAction: (() -> Unit)? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val anyDenied = permissions.values.any { !it }
        if (!anyDenied) {
            val action = pendingPermissionAction
            pendingPermissionAction = null
            action?.invoke()
        } else {
            pendingPermissionAction = null
            showMessage("Required camera or storage permission was denied.")
        }
    }

    private fun checkAndRun(permissions: Array<String>, action: () -> Unit) {
        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            action()
        } else {
            pendingPermissionAction = action
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    private val pickGalleryLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) copyUriToEvidence(uri, pendingFieldKey)
    }

    private val recordVideoLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@registerForActivityResult
        val path = result.data?.getStringExtra(ClaimVideoCaptureActivity.EXTRA_FILE_PATH).orEmpty()
        if (path.isNotBlank()) {
            val file = File(path)
            if (file.exists() && file.length() <= MAX_VIDEO_BYTES) {
                recordCapturedEvidence(pendingFieldKey, file, "video/mp4")
            } else {
                file.delete()
                showMessage("Video exceeds maximum permitted size. Please record again.")
            }
        }
    }

    private val scanBarcodeLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val code = result.data?.getStringExtra(BarcodeScanCaptureActivity.EXTRA_SCANNED_CODE).orEmpty()
            if (code.isNotBlank()) {
                when (targetScanField) {
                    TARGET_SEARCH -> {
                        binding.etClaimSearch.setText(code)
                        searchReturn(code)
                    }
                    TARGET_PACKET_ID -> {
                        binding.etPacketId.setText(code)
                        updateDescriptionAndTitle(selectedIssueCode)
                    }
                    TARGET_AWB -> {
                        binding.etAwbNumber.setText(code)
                        updateDescriptionAndTitle(selectedIssueCode)
                    }
                }
            }
        }
    }

    private var targetScanField = TARGET_SEARCH

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityClaimCaptureBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupMarketplaceDropdown()
        setupListeners()

        // Initialize evidence cards immediately with standard Meesho evidence slots
        buildDynamicEvidenceCards(getMeeshoStandardEvidenceFields())
        restoreEvidenceDraft()
        observeQueuedUploads()

        // 1. The return to claim comes only from the Intent, all of it from one scan. A remembered return is never mixed
        //    in field by field; the server lookup below fills in the rest, and Proceed and Submit wait for it.
        val awb = intent.getStringExtra(EXTRA_TRACKING_AWB).orEmpty().trim()
        val order = intent.getStringExtra(EXTRA_ORDER_ID).orEmpty().trim()
        val subOrder = intent.getStringExtra(EXTRA_SUB_ORDER_ID).orEmpty().trim().ifBlank { order }
        val packetId = intent.getStringExtra(EXTRA_PACKET_ID).orEmpty().trim()
        val title = intent.getStringExtra(EXTRA_PRODUCT_TITLE).orEmpty().trim()
        val sku = intent.getStringExtra(EXTRA_PRODUCT_SKU).orEmpty().trim()
        val masterSku = intent.getStringExtra(EXTRA_MASTER_SKU).orEmpty().trim()
        val imageUrl = intent.getStringExtra(EXTRA_IMAGE_URL).orEmpty().trim()
        val issueCode = intent.getStringExtra(EXTRA_ISSUE_CODE).orEmpty().trim()
        val scanId = intent.getIntExtra(EXTRA_SCAN_ID, 0)
        benchScan = if (scanId > 0) BenchScan(scanId, subOrder, awb) else null

        // 2. Prefill Return Details IMMEDIATELY in UI
        if (awb.isNotBlank()) binding.etAwbNumber.setText(awb)
        if (subOrder.isNotBlank()) binding.etSubOrderNumber.setText(subOrder)
        binding.etPacketId.setText(if (packetId.isNotBlank()) packetId else "NA")

        val displayOrder = subOrder.ifBlank { order.ifBlank { awb } }
        if (displayOrder.isNotBlank()) {
            binding.tvOrderNumber.text = displayOrder
        }

        // Product preview card
        if (title.isNotBlank() || masterSku.isNotBlank() || sku.isNotBlank()) {
            binding.tvProductTitle.text = title.ifBlank { masterSku.ifBlank { sku } }
            binding.tvProductSku.text = "Master SKU: ${masterSku.ifBlank { sku }} · Listing: $sku"
            binding.tvItemQtyBadge.text = "Ordered: 1"
            binding.tvBadQtyBadge.text = "Bad Qty: 1 (Issue Claim)"
        }

        if (imageUrl.isNotBlank()) {
            imageCache.load(imageUrl, binding.ivProductThumb, android.R.drawable.ic_menu_gallery)
            binding.ivProductThumb.setOnClickListener {
                startActivity(Intent(this, ImageViewerActivity::class.java).apply {
                    putExtra(ImageViewerActivity.EXTRA_IMAGE_URL, imageUrl)
                    putExtra(ImageViewerActivity.EXTRA_TITLE, "${title.ifBlank { masterSku }} · $masterSku")
                })
            }
        }

        // Match issue dropdown if issueCode is known
        val mappedIssueIdx = when (issueCode.lowercase()) {
            "missing", "missing_items", "missing_component" -> meeshoIssues.indexOfFirst { it.first == "missing_items" }
            "wrong", "wrong_return", "wrong_product" -> meeshoIssues.indexOfFirst { it.first == "wrong_return" }
            "damaged", "damaged_return", "damaged_product" -> meeshoIssues.indexOfFirst { it.first == "damaged_return" }
            "used", "used_product" -> meeshoIssues.indexOfFirst { it.first == "used_product" }
            "sku_change", "wrong_barcode_rto" -> meeshoIssues.indexOfFirst { it.first == "wrong_barcode_rto" }
            else -> 0
        }
        if (mappedIssueIdx >= 0) {
            binding.spinnerMeeshoIssue.setSelection(mappedIssueIdx)
            selectedIssueCode = meeshoIssues[mappedIssueIdx].first
            selectedIssueLabel = meeshoIssues[mappedIssueIdx].second
        }

        // 3. Immediately prefill Description and Claim Title from local data
        updateDescriptionAndTitle(selectedIssueCode)

        // 4. In background, fire searchReturn to enrich TAT, templates, customer info, etc.
        val query = subOrder.ifBlank { awb.ifBlank { order } }
        if (query.isNotBlank()) {
            binding.etClaimSearch.setText(query)
            searchReturn(query)
        }
    }

    private fun setupMarketplaceDropdown() {
        val marketplaces = listOf(
            "Meesho (Active & Configured)",
            "Flipkart (Upcoming)",
            "Myntra (Upcoming)",
            "Amazon (Upcoming)",
            "Ajio (Upcoming)"
        )
        binding.spinnerMarketplace.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            marketplaces
        )
        binding.spinnerMarketplace.setSelection(0)
        binding.spinnerMarketplace.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (position != 0) {
                    showMessage("Only Meesho claims filing is currently active.")
                    binding.spinnerMarketplace.setSelection(0)
                }
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        // State of the Packet: operator-observed condition, never assumed.
        binding.spinnerStateOfPacket.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            packetStates.map { it.second }
        )
        binding.spinnerStateOfPacket.setSelection(2)
        binding.spinnerStateOfPacket.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                selectedPacketState = packetStates.getOrNull(position)?.first ?: "Unknown"
                updateDescriptionAndTitle(selectedIssueCode)
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        // Setup Issue Dropdown
        val issueLabels = meeshoIssues.map { it.second }
        binding.spinnerMeeshoIssue.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            issueLabels
        )
        binding.spinnerMeeshoIssue.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val pair = meeshoIssues.getOrNull(position) ?: meeshoIssues[0]
                selectedIssueCode = pair.first
                selectedIssueLabel = pair.second
                updateDescriptionAndTitle(selectedIssueCode)
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
    }

    private fun setupListeners() {
        onBackPressedDispatcher.addCallback(this) {
            if (currentStep == 2) {
                showStep(1)
            } else {
                finish()
            }
        }

        binding.btnClaimBack.setOnClickListener {
            if (currentStep == 2) {
                showStep(1)
            } else {
                finish()
            }
        }

        binding.btnClaimInfo.setOnClickListener {
            showInfoDialog()
        }

        binding.btnClaimSearch.setOnClickListener {
            val query = binding.etClaimSearch.text?.toString()?.trim().orEmpty()
            if (query.length < 3) {
                showMessage("Enter at least 3 characters from AWB or Order ID.")
            } else {
                searchReturn(query)
            }
        }

        binding.btnScanSearchAwb.setOnClickListener {
            targetScanField = TARGET_SEARCH
            val intent = Intent(this, BarcodeScanCaptureActivity::class.java).apply {
                putExtra(BarcodeScanCaptureActivity.EXTRA_TITLE, "Scan AWB / Order Barcode")
            }
            scanBarcodeLauncher.launch(intent)
        }

        binding.btnCopySubOrder.setOnClickListener {
            val text = binding.etSubOrderNumber.text?.toString()?.trim().orEmpty()
            if (text.isNotBlank()) {
                val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("Sub Order Number", text))
                showMessage("Sub Order Number copied: $text")
            }
        }

        binding.tabAcceptReturn.setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setTitle("Accept Return")
                .setMessage("To accept this return as verified inventory without filing a claim, proceed through standard Return Verification.")
                .setPositiveButton("Verify Return") { _, _ -> finish() }
                .setNegativeButton("Stay on Claim", null)
                .show()
        }


        binding.btnProceedToUpload.setOnClickListener {
            if (validateStep1()) {
                showStep(2)
            }
        }

        binding.btnScanPacketId.setOnClickListener {
            targetScanField = TARGET_PACKET_ID
            val intent = Intent(this, BarcodeScanCaptureActivity::class.java).apply {
                putExtra(BarcodeScanCaptureActivity.EXTRA_TITLE, "Scan Flyer / Packet Barcode")
            }
            scanBarcodeLauncher.launch(intent)
        }

        binding.btnScanAwbNumber.setOnClickListener {
            targetScanField = TARGET_AWB
            val intent = Intent(this, BarcodeScanCaptureActivity::class.java).apply {
                putExtra(BarcodeScanCaptureActivity.EXTRA_TITLE, "Scan AWB Barcode")
            }
            scanBarcodeLauncher.launch(intent)
        }

        binding.btnSubmitClaim.setOnClickListener {
            submitCompleteClaim()
        }
    }

    private fun searchReturn(query: String) {
        binding.progressClaim.visibility = View.VISIBLE
        binding.btnClaimSearch.isEnabled = false

        lifecycleScope.launch {
            val result = api.lookupClaimReturn(query)
            binding.progressClaim.visibility = View.GONE
            binding.btnClaimSearch.isEnabled = true

            result.onSuccess { lookup ->
                if (lookup != null && lookup.found) {
                    binding.tvClaimMessage.visibility = View.GONE
                    populateReturnDetails(lookup)
                } else {
                    showMessage("No matching return found for that tracking number or order.")
                }
            }.onFailure {
                showMessage(it.message ?: "Failed to find return details.")
            }
        }
    }

    private fun populateReturnDetails(data: ClaimReturnLookup) {
        // Captured evidence belongs to the return it was captured for. The same return keeps it and its cards as they
        // are; a different one (the sub order was corrected or changed) drops it, so it never goes on this claim.
        // Evidence restored after the app was killed stays on the first lookup only if it is the return it was saved for.
        val sameReturn = ClaimPayload.sameReturn(lookupData, data)
        val keepEvidence = sameReturn || (lookupData == null && ClaimPayload.isReturn(evidenceReturnKey, data))
        val droppedEvidence = if (keepEvidence) 0 else clearCapturedEvidence()
        lookupData = data
        evidenceReturnKey = ClaimPayload.returnKey(data)
        binding.layoutStepReturnDetails.visibility = View.VISIBLE

        // Top Order Summary Card
        val displayOrder = data.orderId.ifBlank { data.subOrderId.ifBlank { data.trackingNumber } }
        binding.tvOrderNumber.text = displayOrder
        binding.tvCustomerName.text = data.customerName
        val totalQty = data.items.sumOf { it.quantity }.coerceAtLeast(1)
        binding.tvOrderTotalAndQty.text = String.format("₹ %.2f · Qty: %d", data.totalPrice, totalQty)
        binding.tvReturnInitBadge.text = data.returnStatus.ifBlank { "Return Init" }
        binding.tvDaysSinceShipped.text = "${data.daysSinceShipped} days since shipped"

        // Item Card
        val item = data.items.firstOrNull()
        if (item != null) {
            val title = item.title.ifBlank { item.masterSku.ifBlank { item.sku } }
            val masterSku = item.masterSku.ifBlank { item.sku }
            binding.tvProductTitle.text = title
            binding.tvProductSku.text = "Master SKU: $masterSku · Listing: ${item.sku}"
            binding.tvItemQtyBadge.text = "Ordered: ${item.quantity}"
            binding.tvBadQtyBadge.text = "Bad Qty: 1 (Issue Claim)"

            if (item.imageUrl.isNotBlank()) {
                imageCache.load(item.imageUrl, binding.ivProductThumb, android.R.drawable.ic_menu_gallery)
                binding.ivProductThumb.setOnClickListener {
                    startActivity(Intent(this, ImageViewerActivity::class.java).apply {
                        putExtra(ImageViewerActivity.EXTRA_IMAGE_URL, item.imageUrl)
                        putExtra(ImageViewerActivity.EXTRA_TITLE, "${item.title} · ${item.masterSku}")
                    })
                }
            } else {
                binding.ivProductThumb.setImageResource(android.R.drawable.ic_menu_gallery)
            }
        }

        // Pre-fill Meesho Support Form Inputs (Sub Order Number = Order Item ID, AWB = Tracking ID, Packet ID = Flyer ID or NA)
        val resolvedSubOrder = data.subOrderId.ifBlank { data.orderId }
        val resolvedAwb = data.awb.ifBlank { data.trackingNumber }
        val resolvedPacketId = data.packetId.ifBlank { "NA" }

        binding.etSubOrderNumber.setText(resolvedSubOrder)
        binding.etAwbNumber.setText(resolvedAwb)
        binding.etPacketId.setText(resolvedPacketId)

        // Pre-select matching issue if detected in scan
        val detectedIssue = data.detectedIssueCode ?: data.standardReasons.firstOrNull()?.code
        val mappedIssueIdx = when (detectedIssue?.lowercase()) {
            "missing", "missing_items", "missing_component" -> meeshoIssues.indexOfFirst { it.first == "missing_items" }
            "wrong", "wrong_return", "wrong_product" -> meeshoIssues.indexOfFirst { it.first == "wrong_return" }
            "damaged", "damaged_return", "damaged_product" -> meeshoIssues.indexOfFirst { it.first == "damaged_return" }
            "used", "used_product" -> meeshoIssues.indexOfFirst { it.first == "used_product" }
            "sku_change", "wrong_barcode_rto" -> meeshoIssues.indexOfFirst { it.first == "wrong_barcode_rto" }
            else -> meeshoIssues.indexOfFirst { it.first == detectedIssue }
        }
        if (mappedIssueIdx >= 0) {
            binding.spinnerMeeshoIssue.setSelection(mappedIssueIdx)
            selectedIssueCode = meeshoIssues[mappedIssueIdx].first
            selectedIssueLabel = meeshoIssues[mappedIssueIdx].second
        }

        // Display Turnaround Time (TAT) Banner (7 Calendar Days Inclusive for Meesho)
        binding.cardClaimTatBanner.visibility = View.VISIBLE
        val daysRem = data.daysRemaining
        val recDate = data.receivedDate ?: "Today"
        val dueDate = data.dueDate ?: "In 7 days"
        if (data.overdue || (daysRem != null && daysRem < 0)) {
            val overdueBy = if (daysRem != null) -daysRem else 1
            binding.tvTatTitle.text = "⚠️ Meesho Claim TAT Overdue"
            binding.tvTatBadge.text = "Overdue"
            binding.tvTatSubtitle.text = "Received: $recDate · Claim Due: $dueDate · Expired by $overdueBy day(s)"
            binding.cardClaimTatBanner.setCardBackgroundColor(0xFFFEF2F2.toInt())
            binding.cardClaimTatBanner.strokeColor = 0xFFFECACA.toInt()
            binding.tvTatBadge.backgroundTintList = ColorStateList.valueOf(0xFFDC2626.toInt())
            binding.tvTatTitle.setTextColor(0xFF991B1B.toInt())
            binding.tvTatSubtitle.setTextColor(0xFFB91C1C.toInt())
        } else {
            val remaining = daysRem ?: 7
            binding.tvTatTitle.text = "⏱️ Meesho Claim TAT: 7 Days Inclusive"
            binding.tvTatBadge.text = "$remaining days left"
            binding.tvTatSubtitle.text = "Received: $recDate · File by: $dueDate · $remaining day(s) remaining"
            binding.cardClaimTatBanner.setCardBackgroundColor(0xFFF0FDF4.toInt())
            binding.cardClaimTatBanner.strokeColor = 0xFF86EFAC.toInt()
            binding.tvTatBadge.backgroundTintList = ColorStateList.valueOf(0xFF22C55E.toInt())
            binding.tvTatTitle.setTextColor(0xFF166534.toInt())
            binding.tvTatSubtitle.setTextColor(0xFF15803D.toInt())
        }

        // Update Title & Description with all loaded details
        updateDescriptionAndTitle(selectedIssueCode)

        // This return replaces the remembered one whole, so nothing from an earlier return is left beside it
        sessionManager.saveLastScannedReturn(
            awb = resolvedAwb,
            orderId = data.orderId,
            subOrderId = resolvedSubOrder,
            flyerId = if (resolvedPacketId != "NA") resolvedPacketId else "",
            marketplace = data.marketplace,
            productTitle = item?.title.orEmpty(),
            sku = item?.sku.orEmpty(),
            masterSku = item?.masterSku.orEmpty(),
            imageUrl = item?.imageUrl.orEmpty(),
            issueCode = data.detectedIssueCode.orEmpty()
        )

        // Select or create Meesho Evidence Template
        selectedTemplate = data.templates.firstOrNull { it.name.contains("Meesho", ignoreCase = true) }
            ?: data.templates.firstOrNull()
            ?: ClaimTemplate(
                id = 0,
                name = "Meesho Claim Evidence",
                description = "Standard 5-slot evidence for Meesho Support tickets",
                fields = getMeeshoStandardEvidenceFields()
            )

        if (!sameReturn) buildDynamicEvidenceCards(selectedTemplate?.fields ?: getMeeshoStandardEvidenceFields())
        showStep(1)
        if (droppedEvidence > 0) {
            showMessage("$droppedEvidence evidence file(s) from the previous return were removed. Capture evidence again for Sub Order $resolvedSubOrder.")
        }
    }

    private fun updateDescriptionAndTitle(code: String) {
        val data = lookupData
        // Only the form and the looked-up return feed the description; a remembered earlier return never does.
        val subOrder = binding.etSubOrderNumber.text?.toString()?.trim().orEmpty()
            .ifBlank { data?.subOrderId?.ifBlank { data.orderId } ?: "" }

        val awb = binding.etAwbNumber.text?.toString()?.trim().orEmpty()
            .ifBlank { data?.awb?.ifBlank { data.trackingNumber } ?: "" }

        val packetId = binding.etPacketId.text?.toString()?.trim().orEmpty()
            .ifBlank { data?.packetId ?: "" }
            .ifBlank { "NA" }

        val packetState = selectedPacketState

        val masterSku = ClaimPayload.sku(data)

        if (subOrder.isNotBlank()) {
            binding.etClaimTitle.setText("$selectedIssueLabel - Sub Order $subOrder")
        } else {
            binding.etClaimTitle.setText(selectedIssueLabel)
        }

        val desc = when (code) {
            "missing_items" -> {
                val missingDetails = if (data != null && data.missingItems.isNotEmpty()) {
                    ": " + data.missingItems.joinToString(", ") { "${it.label} (${it.quantity} × ₹${String.format("%.2f", it.amountEach)} = ₹${String.format("%.2f", it.amount)})" }
                } else {
                    ""
                }
                val amountStr = if (data != null && data.missingAmount > 0) "Total claim amount: ₹${String.format("%.2f", data.missingAmount)}.\n" else ""
                "Team,\n\n" +
                "Please Note This Sub Order ID $subOrder has item/s missing in the return package$missingDetails.\n" +
                amountStr +
                "Please check attached all proof and video and make sure our claim will be approved.\n\n" +
                "Sub Order ID: $subOrder\n" +
                "AWB Number: $awb\n" +
                "State of the packet: $packetState\n" +
                "Packet ID: $packetId\n\n" +
                "Regards,\n" +
                "Return Team Tullipprints"
            }
            "wrong_barcode_rto" -> {
                val itemStr = if (masterSku.isNotBlank()) " ($masterSku)" else ""
                "Team,\n\n" +
                "Please Note This Sub Order ID $subOrder has received a wrong barcoded package in RTO instead of ordered item$itemStr. Outer package barcode label does not match our return manifest. Please check attached proof and video and make sure our claim will be approved.\n\n" +
                "Sub Order ID: $subOrder\n" +
                "AWB Number: $awb\n" +
                "State of the packet: $packetState\n" +
                "Packet ID: $packetId\n\n" +
                "Regards,\n" +
                "Return Team Tullipprints"
            }
            "damaged_return" -> {
                "Team,\n\n" +
                "Please Note This Sub Order ID $subOrder has received damaged return product. Product arrived in physically torn / damaged condition. Please check attached proof and video and make sure our claim will be approved.\n\n" +
                "Sub Order ID: $subOrder\n" +
                "AWB Number: $awb\n" +
                "State of the packet: $packetState\n" +
                "Packet ID: $packetId\n\n" +
                "Regards,\n" +
                "Return Team Tullipprints"
            }
            "used_product" -> {
                "Team,\n\n" +
                "Please Note This Sub Order ID $subOrder has received used/soiled product as return instead of fresh product. Please check attached proof and video and make sure our claim will be approved.\n\n" +
                "Sub Order ID: $subOrder\n" +
                "AWB Number: $awb\n" +
                "State of the packet: $packetState\n" +
                "Packet ID: $packetId\n\n" +
                "Regards,\n" +
                "Return Team Tullipprints"
            }
            else -> {
                "Team,\n\n" +
                "Please Note This Sub Order ID $subOrder Has received Us the wrong please check attached all the prrof and video and and make sure we claim will be approved )\n\n" +
                "Sub Order ID: $subOrder\n" +
                "AWB Number: $awb\n" +
                "State of the packet: $packetState\n" +
                "Packet ID: $packetId\n\n" +
                "Regards,\n" +
                "Return Team Tullipprints"
            }
        }
        binding.etClaimContent.setText(desc)
    }

    private fun getMeeshoStandardEvidenceFields(): List<ClaimFieldTemplate> {
        return listOf(
            ClaimFieldTemplate(
                fieldKey = "barcode_image",
                fieldLabel = "Barcode Image",
                fieldType = "image",
                required = false,
                minCount = 0,
                maxCount = 1,
                maxFileSizeMb = 25
            ),
            ClaimFieldTemplate(
                fieldKey = "product_images",
                fieldLabel = "Image of product received",
                fieldType = "image",
                required = true,
                minCount = 1,
                maxCount = 10,
                maxFileSizeMb = 25
            ),
            ClaimFieldTemplate(
                fieldKey = "reverse_waybill",
                fieldLabel = "Reverse Waybill",
                fieldType = "image",
                required = true,
                minCount = 1,
                maxCount = 1,
                maxFileSizeMb = 25
            ),
            ClaimFieldTemplate(
                fieldKey = "unboxing_video",
                fieldLabel = "Unpacking Video",
                fieldType = "video",
                required = true,
                minCount = 1,
                maxCount = 1,
                maxFileSizeMb = 25
            ),
            ClaimFieldTemplate(
                fieldKey = "attachments",
                fieldLabel = "Attachments",
                fieldType = "document",
                required = false,
                minCount = 0,
                maxCount = 5,
                maxFileSizeMb = 25
            )
        )
    }

    private fun buildDynamicEvidenceCards(fields: List<ClaimFieldTemplate>) {
        binding.layoutDynamicEvidenceCards.removeAllViews()
        evidenceCardBindings.clear()
        evidenceMaxCounts.clear()

        // Ensure all 5 standard Meesho slots exist if template is generic
        val effectiveFields = if (fields.size < 4) getMeeshoStandardEvidenceFields() else fields

        val inflater = LayoutInflater.from(this)
        for (field in effectiveFields) {
            val card = ItemClaimEvidenceCardBinding.inflate(inflater, binding.layoutDynamicEvidenceCards, false)
            val isRequired = field.required
            val reqSuffix = if (isRequired) " *" else ""
            card.tvEvidenceLabel.text = "${field.fieldLabel}$reqSuffix"
            evidenceMaxCounts[field.fieldKey] = field.maxCount

            val isVideo = field.fieldType == "video"
            if (isVideo) {
                card.btnCapturePrimary.text = "Record Video (480p SD)"
                card.btnCapturePrimary.setOnClickListener {
                    startCaptureFor(field.fieldKey)
                    // The unpacking video has no sound track, so only the camera permission is needed.
                    checkAndRun(arrayOf(android.Manifest.permission.CAMERA)) {
                        recordVideoLauncher.launch(Intent(this, ClaimVideoCaptureActivity::class.java))
                    }
                }
                card.btnPickGallery.setOnClickListener {
                    startCaptureFor(field.fieldKey)
                    val perms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        arrayOf(android.Manifest.permission.READ_MEDIA_VIDEO)
                    } else {
                        arrayOf(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    }
                    checkAndRun(perms) {
                        pickGalleryLauncher.launch("video/*")
                    }
                }
            } else {
                card.btnCapturePrimary.text = "Take Photo"
                card.btnCapturePrimary.setOnClickListener {
                    startCaptureFor(field.fieldKey)
                    checkAndRun(arrayOf(android.Manifest.permission.CAMERA)) {
                        launchCameraPhoto(field.fieldKey)
                    }
                }
                card.btnPickGallery.setOnClickListener {
                    startCaptureFor(field.fieldKey)
                    val perms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        arrayOf(android.Manifest.permission.READ_MEDIA_IMAGES)
                    } else {
                        arrayOf(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    }
                    checkAndRun(perms) {
                        pickGalleryLauncher.launch("image/*")
                    }
                }
            }

            card.btnDeleteEvidence.setOnClickListener {
                removeEvidence(field.fieldKey)
            }

            evidenceCardBindings[field.fieldKey] = card
            binding.layoutDynamicEvidenceCards.addView(card.root)
            renderEvidenceCard(field.fieldKey)
        }
    }

    /** Remembers, on disk too, which slot the camera, recorder or picker fills: Android may kill the app meanwhile. */
    private fun startCaptureFor(fieldKey: String) {
        pendingFieldKey = fieldKey
        saveEvidenceDraft()
    }

    private fun launchCameraPhoto(fieldKey: String) {
        val file = createEvidenceFile(fieldKey, ".jpg")
        pendingPhotoFile = file
        pendingFieldKey = fieldKey
        saveEvidenceDraft()
        val uri = FileProvider.getUriForFile(this, "$packageName.updates", file)
        takePhotoLauncher.launch(uri)
    }

    private fun copyUriToEvidence(uri: Uri, fieldKey: String) {
        val mime = contentResolver.getType(uri).orEmpty().ifBlank { "application/octet-stream" }
        val ext = when {
            mime == "image/png" -> ".png"
            mime == "image/webp" -> ".webp"
            mime.startsWith("image/") -> ".jpg"
            mime == "video/mp4" -> ".mp4"
            mime.startsWith("video/") -> ".mp4"
            else -> ".bin"
        }
        val file = createEvidenceFile(fieldKey, ext)
        try {
            contentResolver.openInputStream(uri)?.use { inStream ->
                file.outputStream().use { outStream -> inStream.copyTo(outStream) }
            } ?: throw IllegalStateException("Cannot open input stream.")

            val maxBytes = if (ext == ".mp4") MAX_VIDEO_BYTES else MAX_IMAGE_BYTES
            if (file.length() > maxBytes) {
                file.delete()
                showMessage("Selected file exceeds size limit (${maxBytes / (1024 * 1024)} MB).")
                return
            }
            recordCapturedEvidence(fieldKey, file, mime)
        } catch (e: Exception) {
            file.delete()
            showMessage(e.message ?: "Failed to process selected file.")
        }
    }

    private fun recordCapturedEvidence(fieldKey: String, file: File, mimeType: String) {
        val list = capturedFiles.getOrPut(fieldKey) { mutableListOf() }
        // Clean up replaced file for single-item evidence slots to keep device storage clean
        if (fieldKey == "unboxing_video" || fieldKey == "reverse_waybill" || fieldKey == "barcode_image") {
            for (old in list) {
                try {
                    if (old.file.exists() && old.file.absolutePath != file.absolutePath) {
                        old.file.delete()
                    }
                } catch (_: Exception) {}
            }
            list.clear()
        }
        list.add(CapturedFile(file, mimeType, fieldKey))
        saveEvidenceDraft()
        renderEvidenceCard(fieldKey)
        showMessage("Saved ${file.name}")
    }

    /** Shows the slot's latest captured file on its card, or an empty card when it has none. */
    private fun renderEvidenceCard(fieldKey: String) {
        val card = evidenceCardBindings[fieldKey] ?: return
        val list = capturedFiles[fieldKey].orEmpty()
        val latest = list.lastOrNull()
        if (latest == null) {
            card.layoutEvidencePreview.visibility = View.GONE
            card.tvEvidenceCount.text = "0 / ${evidenceMaxCounts[fieldKey] ?: 1}"
            return
        }
        val file = latest.file
        card.layoutEvidencePreview.visibility = View.VISIBLE
        card.tvEvidenceFileName.text = file.name
        val sizeMb = file.length().toDouble() / (1024.0 * 1024.0)
        card.tvEvidenceFileSize.text = String.format("%.2f MB · Ready for upload", sizeMb)
        card.tvEvidenceCount.text = "${list.size} / ${evidenceMaxCounts[fieldKey] ?: 1}"

        if (latest.mimeType.startsWith("image/")) {
            // Placeholder first, so the previous return's photo never shows; a failed decode leaves the placeholder.
            card.ivEvidenceThumb.setImageResource(R.drawable.ic_camera)
            // Sampled decode off the main thread: a full-size decode here froze the screen and could run out of memory.
            lifecycleScope.launch {
                val thumb = withContext(Dispatchers.IO) {
                    try {
                        ImageCache.decodeSampledBitmap(
                            file.absolutePath, EvidencePhotoSizing.THUMBNAIL_PX, EvidencePhotoSizing.THUMBNAIL_PX
                        )
                    } catch (_: Exception) {
                        null
                    } catch (_: OutOfMemoryError) {
                        null
                    }
                }
                // Show it only while this file is still the slot's latest capture.
                if (thumb != null && capturedFiles[fieldKey]?.lastOrNull()?.file == file) {
                    card.ivEvidenceThumb.setImageBitmap(thumb)
                }
            }
        } else {
            card.ivEvidenceThumb.setImageResource(android.R.drawable.ic_media_play)
        }
    }

    private fun removeEvidence(fieldKey: String) {
        val list = capturedFiles[fieldKey] ?: return
        for (item in list) {
            item.file.delete()
        }
        list.clear()
        saveEvidenceDraft()
        renderEvidenceCard(fieldKey)
    }

    /** Deletes every captured evidence file, from memory and disk, and empties the cards. Returns how many were dropped. */
    private fun clearCapturedEvidence(): Int {
        evidenceGeneration++
        var dropped = 0
        for (list in capturedFiles.values) {
            for (item in list) {
                try {
                    if (item.file.exists()) item.file.delete()
                } catch (_: Exception) {}
                dropped++
            }
            list.clear()
        }
        capturedFiles.clear()
        saveEvidenceDraft()
        for (fieldKey in evidenceCardBindings.keys) renderEvidenceCard(fieldKey)
        return dropped
    }

    /** Saves the captured evidence, the photo being taken and the slot being filled (see [EvidenceDraft]). */
    private fun saveEvidenceDraft() {
        val files = capturedFiles.values.flatten().map { DraftFile(it.file.absolutePath, it.mimeType, it.fieldKey) }
        try {
            evidenceDraftStore.save(
                EvidenceDraft(evidenceReturnKey, files, pendingPhotoFile?.absolutePath.orEmpty(), pendingFieldKey)
            )
        } catch (_: Exception) {}
    }

    /**
     * Puts back the evidence saved before the app was killed (by Android while the camera was open, or force-stopped).
     * The first lookup keeps it only if it is the return it was captured for.
     */
    private fun restoreEvidenceDraft() {
        val draft = evidenceDraftStore.load() ?: return
        evidenceReturnKey = draft.returnKey
        pendingFieldKey = draft.pendingFieldKey
        val restored = draft.restorableFiles()
        for (saved in restored) {
            recordCapturedEvidence(saved.fieldKey, File(saved.path), saved.mimeType)
        }
        // The camera app may have saved its photo after this app was killed; that result never arrives, so take the file.
        val photo = draft.takenPendingPhoto()
        if (photo != null) {
            acceptCameraPhoto(photo, draft.pendingFieldKey)
        } else if (draft.pendingPhotoPath.isNotBlank()) {
            File(draft.pendingPhotoPath).delete()
        }
        saveEvidenceDraft()
        val count = restored.size + (if (photo != null) 1 else 0)
        if (count > 0) showMessage("Restored $count evidence file(s) captured before the app closed.")
    }

    /** Shows the evidence uploads still queued (they run in the background) and any the server refused. */
    private fun observeQueuedUploads() {
        WorkManager.getInstance(this).getWorkInfosByTagLiveData(ClaimEvidenceUploadWorker.ALL_UPLOADS_TAG).observe(this) { infos ->
            val summary = EvidenceUploads.summarize(infos.map { ClaimEvidenceUploadWorker.uploadOf(it) })
            val notice = EvidenceUploads.pendingNotice(summary)
            binding.tvPendingUploads.text = notice.orEmpty()
            binding.tvPendingUploads.visibility = if (notice == null) View.GONE else View.VISIBLE
        }
    }

    private fun createEvidenceFile(fieldKey: String, extension: String): File {
        val dir = File(filesDir, EvidenceUploads.DIR).apply { mkdirs() }
        return File(dir, "claim-evidence-${fieldKey}-${UUID.randomUUID()}$extension")
    }

    private fun validateStep1(): Boolean {
        val subOrder = binding.etSubOrderNumber.text?.toString()?.trim().orEmpty()
        if (subOrder.isBlank()) {
            showMessage("Sub Order Number is required.")
            binding.etSubOrderNumber.requestFocus()
            return false
        }
        val awb = binding.etAwbNumber.text?.toString()?.trim().orEmpty()
        if (awb.isBlank()) {
            showMessage("AWB Number is required.")
            binding.etAwbNumber.requestFocus()
            return false
        }
        val title = binding.etClaimTitle.text?.toString()?.trim().orEmpty()
        if (title.isBlank()) {
            showMessage("Please enter a Claim Title.")
            binding.etClaimTitle.requestFocus()
            return false
        }
        val desc = binding.etClaimContent.text?.toString()?.trim().orEmpty()
        if (desc.isBlank()) {
            showMessage("Please enter a Description.")
            binding.etClaimContent.requestFocus()
            return false
        }
        // The claim carries the looked-up return's details, so the form must show a return the server found. When it
        // does not (the lookup failed, or the sub order was changed), look it up now and let the operator check it.
        if (ClaimPayload.confirmedLookup(lookupData, subOrder, awb) == null) {
            showMessage("Checking Sub Order $subOrder with the server. Review the details it loads, then tap Proceed again.")
            binding.etClaimSearch.setText(subOrder)
            searchReturn(subOrder)
            return false
        }
        val otherReturn = benchMismatchMessage(subOrder, awb)
        if (otherReturn != null) {
            showMessage(otherReturn)
            return false
        }
        return true
    }

    /**
     * On a screen File Claim opened, the message to show when the form's confirmed return is not the one whose bench scan
     * File Claim saved; null otherwise. That claim cannot be filed here: its return has no bench scan on this screen.
     */
    private fun benchMismatchMessage(subOrder: String, awb: String): String? {
        val bench = benchScan ?: return null
        val found = ClaimPayload.confirmedLookup(lookupData, subOrder, awb) ?: return null
        if (bench.isFor(found)) return null
        val saved = bench.subOrderId.ifBlank { bench.awb }
        return "File Claim saved the bench scan for $saved, so this claim is for $saved. Search $saved again, or go back and tap File Claim on the other return's scan."
    }

    private fun showStep(step: Int) {
        currentStep = step
        if (step == 1) {
            binding.tvClaimScreenTitle.text = "Return Details"
            binding.layoutStepReturnDetails.visibility = View.VISIBLE
            binding.layoutStepUploadImages.visibility = View.GONE
        } else {
            binding.tvClaimScreenTitle.text = "Upload Images"
            binding.layoutStepReturnDetails.visibility = View.GONE
            binding.layoutStepUploadImages.visibility = View.VISIBLE

            // Update Step 2 summary card from Step 1 values
            val subOrder = binding.etSubOrderNumber.text?.toString()?.trim().orEmpty()
            val awb = binding.etAwbNumber.text?.toString()?.trim().orEmpty()
            val packetId = binding.etPacketId.text?.toString()?.trim().orEmpty().ifBlank { "NA" }

            binding.tvStep2IssueLabel.text = selectedIssueLabel
            binding.tvStep2SubOrderAwb.text = "Sub Order: $subOrder · AWB: $awb"
            binding.tvStep2PacketInfo.text = "State: $selectedPacketState · Packet ID: $packetId"
        }
    }

    private fun submitCompleteClaim() {
        if (photosBeingSaved > 0) {
            showMessage("A photo is still being saved. Try again in a moment.")
            return
        }
        val form = ClaimFormInput(
            subOrderId = binding.etSubOrderNumber.text?.toString()?.trim().orEmpty(),
            awb = binding.etAwbNumber.text?.toString()?.trim().orEmpty(),
            packetId = binding.etPacketId.text?.toString()?.trim().orEmpty().ifBlank { "NA" },
            packetState = selectedPacketState,
            issueCode = selectedIssueCode,
            issueLabel = selectedIssueLabel,
            title = binding.etClaimTitle.text?.toString()?.trim().orEmpty(),
            content = binding.etClaimContent.text?.toString()?.trim().orEmpty(),
            templateId = selectedTemplate?.id
        )
        // Only a lookup that found this form's return may supply its details. Without one nothing is sent: no invented
        // return, and no customer, price, SKU or packet ID remembered from an earlier scan.
        // A screen File Claim opened files the claim on the bench scan it saved (receiptScanId), not on the lookup's scan.
        val body = ClaimPayload.build(lookupData, form, benchScan)
        if (body == null) {
            showStep(1)
            showMessage(
                benchMismatchMessage(form.subOrderId, form.awb)
                    ?: "The return for Sub Order ${form.subOrderId} is not confirmed yet. Tap Proceed to look it up, then submit again."
            )
            return
        }

        // Validate required evidence fields (Product images, Reverse Waybill, Unpacking Video)
        val requiredKeys = listOf(
            Pair("product_images", "Image of product received"),
            Pair("reverse_waybill", "Reverse Waybill"),
            Pair("unboxing_video", "Unpacking Video")
        )
        for ((key, label) in requiredKeys) {
            val files = capturedFiles[key]
            if (files.isNullOrEmpty()) {
                showMessage("Please provide required evidence: $label")
                return
            }
        }

        binding.progressClaim.visibility = View.VISIBLE
        binding.btnSubmitClaim.isEnabled = false

        lifecycleScope.launch {
            val createResult = api.unifiedCreateClaim(body)
            binding.progressClaim.visibility = View.GONE

            createResult.onSuccess { result ->
                val claimId = result.claimId
                // Every file becomes its own upload job straight away. WorkManager keeps the jobs through app kills and
                // network loss and retries them, and each job deletes its file once uploaded, so the screen lets go of
                // the files here without deleting them.
                val allFiles = capturedFiles.values.flatten()
                // Sized before queueing: a job deletes its file as soon as the server has it.
                val totalBytes = allFiles.sumOf { it.file.length() }
                for (cf in allFiles) {
                    ClaimEvidenceUploadWorker.enqueue(this@ClaimCaptureActivity, claimId, cf.fieldKey, cf.file, cf.mimeType)
                }
                capturedFiles.clear()
                pendingFieldKey = ""
                saveEvidenceDraft()
                showUploadProgress(claimId, allFiles.size, totalBytes)
            }.onFailure { err ->
                binding.btnSubmitClaim.isEnabled = true
                showMessage(err.message ?: "Failed to submit claim.")
            }
        }
    }

    /**
     * Shows the claim's upload jobs as they run, by bytes sent out of [expectedBytes]. Closing it leaves them running;
     * the result dialog follows either way.
     */
    private fun showUploadProgress(claimId: Int, expected: Int, expectedBytes: Long) {
        val container = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(60, 40, 60, 40)
        }
        val tvStatus = android.widget.TextView(this).apply {
            text = "Uploading evidence files (0 / $expected)..."
            textSize = 14f
            setTextColor(android.graphics.Color.parseColor("#334155"))
            setPadding(0, 0, 0, 24)
        }
        val progressBar = android.widget.ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = false
            max = 100
            progress = 0
            progressTintList = ColorStateList.valueOf(android.graphics.Color.parseColor("#059669"))
        }
        val tvPercent = android.widget.TextView(this).apply {
            text = "0%"
            textSize = 12f
            setTextColor(android.graphics.Color.parseColor("#64748b"))
            gravity = android.view.Gravity.END
            setPadding(0, 12, 0, 0)
        }
        container.addView(tvStatus)
        container.addView(progressBar)
        container.addView(tvPercent)

        val uploads = WorkManager.getInstance(this).getWorkInfosByTagLiveData(EvidenceUploads.claimTag(claimId))
        var latest = EvidenceUploads.Summary(uploaded = 0, waiting = expected, failures = emptyList())
        lateinit var progressDialog: AlertDialog
        val observer = object : Observer<List<WorkInfo>> {
            override fun onChanged(value: List<WorkInfo>) {
                latest = EvidenceUploads.summarize(value.map { ClaimEvidenceUploadWorker.uploadOf(it) })
                tvStatus.text = EvidenceUploads.progressText(latest, expected, expectedBytes)
                val pct = EvidenceUploads.percent(latest, expected, expectedBytes)
                progressBar.progress = pct
                tvPercent.text = "$pct%"
                if (EvidenceUploads.isDone(latest, expected)) {
                    uploads.removeObserver(this)
                    try { progressDialog.dismiss() } catch (_: Exception) {}
                    showClaimSubmitted(claimId, latest)
                }
            }
        }
        progressDialog = MaterialAlertDialogBuilder(this)
            .setTitle("Uploading Claim Evidence")
            .setView(container)
            .setCancelable(false)
            .setNeutralButton("Continue in background") { _, _ ->
                uploads.removeObserver(observer)
                showClaimSubmitted(claimId, latest)
            }
            .create()
        progressDialog.show()
        uploads.observe(this, observer)
    }

    private fun showClaimSubmitted(claimId: Int, summary: EvidenceUploads.Summary) {
        MaterialAlertDialogBuilder(this)
            .setTitle(if (summary.failures.isEmpty()) "Claim Submitted Successfully" else "Claim Submitted: Evidence Refused")
            .setMessage(EvidenceUploads.resultMessage(claimId, summary))
            .setPositiveButton("File Next Return (Start Again)") { _, _ ->
                resetFormForNextClaim()
            }
            .setNegativeButton("Done") { _, _ ->
                finish()
            }
            .setCancelable(false)
            .show()
    }

    private fun resetFormForNextClaim() {
        // 1. Clear input text fields
        binding.etClaimSearch.setText("")
        binding.etSubOrderNumber.setText("")
        binding.etAwbNumber.setText("")
        binding.etPacketId.setText("")
        binding.etClaimTitle.setText("")
        binding.etClaimContent.setText("")
        binding.tvClaimMessage.visibility = View.GONE

        // 2. Clear captured evidence files from memory and disk, and reset the evidence cards
        clearCapturedEvidence()

        // 3. Reset state variables. The next return was not saved by File Claim, so it has no bench scan here.
        lookupData = null
        benchScan = null
        evidenceReturnKey = ""
        binding.cardProductPreview.visibility = View.GONE
        binding.cardOrderSummary.visibility = View.GONE
        selectedIssueCode = "wrong_return"
        selectedIssueLabel = "I have received wrong return"
        binding.spinnerMeeshoIssue.setSelection(0)
        binding.btnSubmitClaim.isEnabled = true
        binding.progressClaim.visibility = View.GONE

        // 4. Switch back to Step 1: Return Details
        showStep(1)

        // 5. Request focus on search input
        binding.etClaimSearch.requestFocus()
        showMessage("Ready for next return claim. Enter or scan SubOrder ID / AWB.")
    }

    private fun showInfoDialog() {
        MaterialAlertDialogBuilder(this)
            .setTitle("Meesho Claim Guidelines")
            .setMessage("For Meesho Support tickets:\n• Observe and select the actual State of the packet. Unknown blocks automatic submission and needs operator review.\n• Turnaround time (TAT) is 7 calendar days inclusive.\n• Unpacking video must be recorded in 480p SD MP4 and under 25 MB.\n• Images of received product and reverse waybill are mandatory.")
            .setPositiveButton("OK", null)
            .show()
    }

    private fun showMessage(msg: String) {
        binding.tvClaimMessage.text = msg
        binding.tvClaimMessage.visibility = View.VISIBLE
        Snackbar.make(binding.root, msg, Snackbar.LENGTH_LONG).show()
    }

    override fun onDestroy() {
        super.onDestroy()
    }

    companion object {
        const val EXTRA_TRACKING_AWB = "extra_tracking_awb"
        const val EXTRA_ORDER_ID = "extra_order_id"
        const val EXTRA_SUB_ORDER_ID = "extra_sub_order_id"
        const val EXTRA_PACKET_ID = "extra_packet_id"
        const val EXTRA_MARKETPLACE = "extra_marketplace"
        const val EXTRA_MARKETPLACE_ID = "extra_marketplace_id"
        const val EXTRA_SCAN_ID = "extra_scan_id"
        const val EXTRA_PRODUCT_TITLE = "extra_product_title"
        const val EXTRA_PRODUCT_SKU = "extra_product_sku"
        const val EXTRA_MASTER_SKU = "extra_master_sku"
        const val EXTRA_IMAGE_URL = "extra_image_url"
        const val EXTRA_ISSUE_CODE = "extra_issue_code"

        private const val TARGET_SEARCH = 0
        private const val TARGET_PACKET_ID = 1
        private const val TARGET_AWB = 2

        private const val MAX_IMAGE_BYTES = 25L * 1024L * 1024L
        private const val MAX_VIDEO_BYTES = 25L * 1024L * 1024L
    }
}