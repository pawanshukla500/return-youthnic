package shop.youthnic.returnscan.ui

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.launch
import org.json.JSONObject
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.claim.ClaimEvidenceUploadWorker
import shop.youthnic.returnscan.data.ClaimFieldTemplate
import shop.youthnic.returnscan.data.ClaimProductItem
import shop.youthnic.returnscan.data.ClaimReturnLookup
import shop.youthnic.returnscan.data.ClaimTemplate
import shop.youthnic.returnscan.databinding.ActivityClaimCaptureBinding
import shop.youthnic.returnscan.databinding.ItemClaimEvidenceCardBinding
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

class ClaimCaptureActivity : AppCompatActivity() {

    private lateinit var binding: ActivityClaimCaptureBinding
    private val api get() = (application as ReturnScanApp).apiClient
    private val imageCache get() = (application as ReturnScanApp).imageCache
    private val sessionManager get() = (application as ReturnScanApp).sessionManager

    private var lookupData: ClaimReturnLookup? = null
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

    // Captured evidence files keyed by fieldKey
    private data class CapturedFile(
        val file: File,
        val mimeType: String,
        val fieldKey: String
    )
    private val capturedFiles = mutableMapOf<String, MutableList<CapturedFile>>()
    private val evidenceCardBindings = mutableMapOf<String, ItemClaimEvidenceCardBinding>()

    private var pendingFieldKey = ""
    private var pendingPhotoFile: File? = null

    // Activity Result Launchers
    private val takePhotoLauncher = registerForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val file = pendingPhotoFile
        if (success && file != null && file.exists()) {
            recordCapturedEvidence(pendingFieldKey, file, "image/jpeg")
        } else {
            file?.delete()
        }
        pendingPhotoFile = null
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

        // 1. Extract values from Intent extras with fallback to SessionManager's cached last-scanned return
        val extraAwb = intent.getStringExtra(EXTRA_TRACKING_AWB).orEmpty().trim()
        val extraOrder = intent.getStringExtra(EXTRA_ORDER_ID).orEmpty().trim()
        val extraSubOrder = intent.getStringExtra(EXTRA_SUB_ORDER_ID).orEmpty().trim()
        val extraPacketId = intent.getStringExtra(EXTRA_PACKET_ID).orEmpty().trim()
        val extraMarketplace = intent.getStringExtra(EXTRA_MARKETPLACE).orEmpty().trim()
        val extraTitle = intent.getStringExtra(EXTRA_PRODUCT_TITLE).orEmpty().trim()
        val extraSku = intent.getStringExtra(EXTRA_PRODUCT_SKU).orEmpty().trim()
        val extraMasterSku = intent.getStringExtra(EXTRA_MASTER_SKU).orEmpty().trim()
        val extraImage = intent.getStringExtra(EXTRA_IMAGE_URL).orEmpty().trim()
        val extraIssue = intent.getStringExtra(EXTRA_ISSUE_CODE).orEmpty().trim()

        val awb = extraAwb.ifBlank { sessionManager.lastScannedAwb }
        val order = extraOrder.ifBlank { sessionManager.lastScannedOrderId }
        val subOrder = extraSubOrder.ifBlank { sessionManager.lastScannedSubOrderId }.ifBlank { order }
        val packetId = extraPacketId.ifBlank { sessionManager.lastScannedFlyerId }
        val title = extraTitle.ifBlank { sessionManager.lastScannedProductTitle }
        val sku = extraSku.ifBlank { sessionManager.lastScannedSku }
        val masterSku = extraMasterSku.ifBlank { sessionManager.lastScannedMasterSku }
        val imageUrl = extraImage.ifBlank { sessionManager.lastScannedImageUrl }
        val issueCode = extraIssue.ifBlank { sessionManager.lastScannedIssueCode }

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
            lifecycleScope.launch {
                val bmp = imageCache.getOrFetch(imageUrl)
                if (bmp != null) {
                    binding.ivProductThumb.setImageBitmap(bmp)
                } else {
                    binding.ivProductThumb.setImageResource(android.R.drawable.ic_menu_gallery)
                }
            }
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

        // Setup fixed State of the Packet (always Tampered)
        binding.spinnerStateOfPacket.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            listOf("Tampered")
        )
        binding.spinnerStateOfPacket.setSelection(0)

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
        lookupData = data
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
                lifecycleScope.launch {
                    val bmp = imageCache.getOrFetch(item.imageUrl)
                    if (bmp != null) {
                        binding.ivProductThumb.setImageBitmap(bmp)
                    } else {
                        binding.ivProductThumb.setImageResource(android.R.drawable.ic_menu_gallery)
                    }
                }
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
        val detectedIssue = data.standardReasons.firstOrNull()?.code
        if (!detectedIssue.isNullOrBlank()) {
            val idx = meeshoIssues.indexOfFirst { it.first == detectedIssue }
            if (idx >= 0) {
                binding.spinnerMeeshoIssue.setSelection(idx)
                selectedIssueCode = meeshoIssues[idx].first
                selectedIssueLabel = meeshoIssues[idx].second
            }
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

        // Save fresh details to SessionManager
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
            customerName = data.customerName,
            totalPrice = data.totalPrice
        )

        // Select or create Meesho Evidence Template
        selectedTemplate = data.templates.firstOrNull { it.name.contains("Meesho", ignoreCase = true) }
            ?: data.templates.firstOrNull()
            ?: ClaimTemplate(
                id = 1,
                name = "Meesho Claim Evidence",
                description = "Standard 5-slot evidence for Meesho Support tickets",
                fields = getMeeshoStandardEvidenceFields()
            )

        buildDynamicEvidenceCards(selectedTemplate?.fields ?: getMeeshoStandardEvidenceFields())
        showStep(1)
    }

    private fun updateDescriptionAndTitle(code: String) {
        val data = lookupData
        val subOrder = binding.etSubOrderNumber.text?.toString()?.trim().orEmpty()
            .ifBlank { data?.subOrderId?.ifBlank { data.orderId } ?: "" }
            .ifBlank { sessionManager.lastScannedSubOrderId.ifBlank { sessionManager.lastScannedOrderId } }

        val awb = binding.etAwbNumber.text?.toString()?.trim().orEmpty()
            .ifBlank { data?.awb?.ifBlank { data.trackingNumber } ?: "" }
            .ifBlank { sessionManager.lastScannedAwb }

        val packetId = binding.etPacketId.text?.toString()?.trim().orEmpty()
            .ifBlank { data?.packetId ?: "" }
            .ifBlank { sessionManager.lastScannedFlyerId }
            .ifBlank { "NA" }

        val item = data?.items?.firstOrNull()
        val masterSku = item?.masterSku?.ifBlank { item.sku }.orEmpty()
            .ifBlank { sessionManager.lastScannedMasterSku.ifBlank { sessionManager.lastScannedSku } }

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
                "State of the packet: Tampered\n" +
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
                "State of the packet: Tampered\n" +
                "Packet ID: $packetId\n\n" +
                "Regards,\n" +
                "Return Team Tullipprints"
            }
            "damaged_return" -> {
                "Team,\n\n" +
                "Please Note This Sub Order ID $subOrder has received damaged return product. Product arrived in physically torn / damaged condition. Please check attached proof and video and make sure our claim will be approved.\n\n" +
                "Sub Order ID: $subOrder\n" +
                "AWB Number: $awb\n" +
                "State of the packet: Tampered\n" +
                "Packet ID: $packetId\n\n" +
                "Regards,\n" +
                "Return Team Tullipprints"
            }
            "used_product" -> {
                "Team,\n\n" +
                "Please Note This Sub Order ID $subOrder has received used/soiled product as return instead of fresh product. Please check attached proof and video and make sure our claim will be approved.\n\n" +
                "Sub Order ID: $subOrder\n" +
                "AWB Number: $awb\n" +
                "State of the packet: Tampered\n" +
                "Packet ID: $packetId\n\n" +
                "Regards,\n" +
                "Return Team Tullipprints"
            }
            else -> {
                "Team,\n\n" +
                "Please Note This Sub Order ID $subOrder Has received Us the wrong please check attached all the prrof and video and and make sure we claim will be approved )\n\n" +
                "Sub Order ID: $subOrder\n" +
                "AWB Number: $awb\n" +
                "State of the packet: Tampered\n" +
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

        // Ensure all 5 standard Meesho slots exist if template is generic
        val effectiveFields = if (fields.size < 4) getMeeshoStandardEvidenceFields() else fields

        val inflater = LayoutInflater.from(this)
        for (field in effectiveFields) {
            val card = ItemClaimEvidenceCardBinding.inflate(inflater, binding.layoutDynamicEvidenceCards, false)
            val isRequired = field.required
            val reqSuffix = if (isRequired) " *" else ""
            card.tvEvidenceLabel.text = "${field.fieldLabel}$reqSuffix"
            card.tvEvidenceCount.text = "0 / ${field.maxCount}"

            val isVideo = field.fieldType == "video"
            if (isVideo) {
                card.btnCapturePrimary.text = "Record Video (720p HD)"
                card.btnCapturePrimary.setOnClickListener {
                    pendingFieldKey = field.fieldKey
                    recordVideoLauncher.launch(Intent(this, ClaimVideoCaptureActivity::class.java))
                }
                card.btnPickGallery.setOnClickListener {
                    pendingFieldKey = field.fieldKey
                    pickGalleryLauncher.launch("video/*")
                }
            } else {
                card.btnCapturePrimary.text = "Take Photo"
                card.btnCapturePrimary.setOnClickListener {
                    pendingFieldKey = field.fieldKey
                    launchCameraPhoto(field.fieldKey)
                }
                card.btnPickGallery.setOnClickListener {
                    pendingFieldKey = field.fieldKey
                    pickGalleryLauncher.launch("image/*")
                }
            }

            card.btnDeleteEvidence.setOnClickListener {
                removeEvidence(field.fieldKey)
            }

            evidenceCardBindings[field.fieldKey] = card
            binding.layoutDynamicEvidenceCards.addView(card.root)
        }
    }

    private fun launchCameraPhoto(fieldKey: String) {
        val file = createEvidenceFile(fieldKey, ".jpg")
        pendingPhotoFile = file
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
        list.add(CapturedFile(file, mimeType, fieldKey))

        val card = evidenceCardBindings[fieldKey] ?: return
        card.layoutEvidencePreview.visibility = View.VISIBLE
        card.tvEvidenceFileName.text = file.name
        val sizeMb = file.length().toDouble() / (1024.0 * 1024.0)
        card.tvEvidenceFileSize.text = String.format("%.2f MB · Ready for upload", sizeMb)
        card.tvEvidenceCount.text = "${list.size} / 1"

        if (mimeType.startsWith("image/")) {
            try {
                val bmp = BitmapFactory.decodeFile(file.absolutePath)
                if (bmp != null) card.ivEvidenceThumb.setImageBitmap(bmp)
            } catch (_: Exception) {}
        } else {
            card.ivEvidenceThumb.setImageResource(android.R.drawable.ic_media_play)
        }

        showMessage("Saved ${file.name}")
    }

    private fun removeEvidence(fieldKey: String) {
        val list = capturedFiles[fieldKey] ?: return
        for (item in list) {
            item.file.delete()
        }
        list.clear()

        val card = evidenceCardBindings[fieldKey] ?: return
        card.layoutEvidencePreview.visibility = View.GONE
        card.tvEvidenceCount.text = "0 / 1"
    }

    private fun createEvidenceFile(fieldKey: String, extension: String): File {
        val dir = File(filesDir, "claim-evidence").apply { mkdirs() }
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
        return true
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
            binding.tvStep2PacketInfo.text = "State: Tampered · Packet ID: $packetId"
        }
    }

    private fun submitCompleteClaim() {
        val subOrder = binding.etSubOrderNumber.text?.toString()?.trim().orEmpty()
        val awb = binding.etAwbNumber.text?.toString()?.trim().orEmpty()
        val packetId = binding.etPacketId.text?.toString()?.trim().orEmpty().ifBlank { "NA" }

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
            var data = lookupData
            if (data == null) {
                val query = subOrder.ifBlank { awb }
                val lookupResult = api.lookupClaimReturn(query)
                data = lookupResult.getOrNull()
                if (data == null) {
                    data = ClaimReturnLookup(
                        found = true,
                        expectedReturnId = 0,
                        subOrderId = subOrder,
                        orderId = subOrder,
                        trackingNumber = awb,
                        awb = awb,
                        packetId = packetId,
                        marketplace = "Meesho",
                        marketplaceId = 1,
                        customerName = sessionManager.lastScannedCustomerName.ifBlank { "Customer" },
                        totalPrice = sessionManager.lastScannedTotalPrice
                    )
                }
                lookupData = data
            }

            val item = data.items.firstOrNull()
            val masterSku = item?.masterSku?.ifBlank { item.sku }.orEmpty()
                .ifBlank { sessionManager.lastScannedMasterSku.ifBlank { sessionManager.lastScannedSku } }

            val currentScanId = data.scanId
            val body = JSONObject().apply {
                if (currentScanId != null && currentScanId > 0) {
                    put("receiptScanId", currentScanId)
                }
                put("expectedReturnId", data.expectedReturnId)
                put("claimReason", selectedIssueLabel)
                put("marketplaceIssueCode", selectedIssueCode)
                put("claimTitle", binding.etClaimTitle.text?.toString()?.trim().orEmpty())
                put("claimDescription", binding.etClaimContent.text?.toString()?.trim().orEmpty())
                put("claimContent", binding.etClaimContent.text?.toString()?.trim().orEmpty())
                put("remarks", "")
                put("claimTemplateId", selectedTemplate?.id ?: 1)
                put("customerName", data.customerName)
                put("totalPrice", data.totalPrice)
                put("shippedDate", data.shippedDate ?: "")
                put("sku", masterSku)
                put("subOrderId", subOrder)
                put("packetState", "Tampered")
                put("packetId", packetId)
                put("awb", awb)
                put("missingAmount", data.missingAmount)
            }

            val createResult = api.unifiedCreateClaim(body)
            binding.progressClaim.visibility = View.GONE

            createResult.onSuccess { result ->
                val claimId = result.claimId
                // Enqueue all captured files into WorkManager
                queueAllFilesForUpload(claimId)

                MaterialAlertDialogBuilder(this@ClaimCaptureActivity)
                    .setTitle("Claim Submitted")
                    .setMessage("Meesho claim #$claimId created successfully! Evidence files are saved safely on device and uploading in background.")
                    .setPositiveButton("Done") { _, _ -> finish() }
                    .setCancelable(false)
                    .show()
            }.onFailure { err ->
                binding.btnSubmitClaim.isEnabled = true
                showMessage(err.message ?: "Failed to submit claim.")
            }
        }
    }

    private fun queueAllFilesForUpload(claimId: Int) {
        val wm = WorkManager.getInstance(this)
        for ((fieldKey, files) in capturedFiles) {
            for (cf in files) {
                val inputData = Data.Builder()
                    .putInt(ClaimEvidenceUploadWorker.KEY_CLAIM_ID, claimId)
                    .putString(ClaimEvidenceUploadWorker.KEY_FIELD_KEY, fieldKey)
                    .putString(ClaimEvidenceUploadWorker.KEY_FILE_PATH, cf.file.absolutePath)
                    .putString(ClaimEvidenceUploadWorker.KEY_MIME_TYPE, cf.mimeType)
                    .build()

                val workRequest = OneTimeWorkRequestBuilder<ClaimEvidenceUploadWorker>()
                    .setInputData(inputData)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                    .build()

                wm.enqueue(workRequest)
            }
        }
    }

    private fun showInfoDialog() {
        MaterialAlertDialogBuilder(this)
            .setTitle("Meesho Claim Guidelines")
            .setMessage("For Meesho Support tickets:\n• State of the packet is always Tampered.\n• Turnaround time (TAT) is 7 calendar days inclusive.\n• Unpacking video must be recorded in 720p MP4 and under 25 MB.\n• Images of received product and reverse waybill are mandatory.")
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
