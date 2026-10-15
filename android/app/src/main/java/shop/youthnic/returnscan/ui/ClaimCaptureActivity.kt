package shop.youthnic.returnscan.ui

import android.app.Activity
import android.content.Intent
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

    private var lookupData: ClaimReturnLookup? = null
    private var selectedTemplate: ClaimTemplate? = null
    private var currentStep = 1 // 1: Return Details, 2: Upload Images

    // Steppers state
    private var receivedGood = 0
    private var receivedBad = 0
    private var acceptedGood = 0
    private var acceptedBad = 0

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
                    TARGET_PACKET_ID -> binding.etPacketId.setText(code)
                    TARGET_AWB -> binding.etAwbNumber.setText(code)
                }
            }
        }
    }

    private var targetScanField = TARGET_SEARCH

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityClaimCaptureBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupListeners()

        val initialAwb = intent.getStringExtra(EXTRA_TRACKING_AWB).orEmpty()
        val initialOrder = intent.getStringExtra(EXTRA_ORDER_ID).orEmpty()
        val query = initialAwb.ifBlank { initialOrder }

        if (query.isNotBlank()) {
            binding.etClaimSearch.setText(query)
            searchReturn(query)
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

        binding.tabAcceptReturn.setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setTitle("Accept Return")
                .setMessage("To accept this return as verified inventory without filing a claim, proceed through standard Return Verification.")
                .setPositiveButton("Verify Return") { _, _ -> finish() }
                .setNegativeButton("Stay on Claim", null)
                .show()
        }

        // Steppers
        binding.btnGoodMinus.setOnClickListener {
            if (receivedGood > 0) {
                receivedGood--
                updateSteppersUi()
            }
        }
        binding.btnGoodPlus.setOnClickListener {
            val max = lookupData?.items?.firstOrNull()?.quantity ?: 1
            if (receivedGood + receivedBad < max) {
                receivedGood++
                updateSteppersUi()
            }
        }
        binding.btnBadMinus.setOnClickListener {
            if (receivedBad > 0) {
                receivedBad--
                updateSteppersUi()
            }
        }
        binding.btnBadPlus.setOnClickListener {
            val max = lookupData?.items?.firstOrNull()?.quantity ?: 1
            if (receivedGood + receivedBad < max) {
                receivedBad++
                updateSteppersUi()
            }
        }

        binding.btnProceedToUpload.setOnClickListener {
            if (validateStep1()) {
                showStep(2)
            }
        }

        binding.btnScanPacketId.setOnClickListener {
            targetScanField = TARGET_PACKET_ID
            val intent = Intent(this, BarcodeScanCaptureActivity::class.java).apply {
                putExtra(BarcodeScanCaptureActivity.EXTRA_TITLE, "Scan Packet Barcode")
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
        binding.tvOrderNumber.text = data.orderId.ifBlank { data.trackingNumber }
        binding.tvCustomerName.text = data.customerName
        val totalQty = data.items.sumOf { it.quantity }.coerceAtLeast(1)
        binding.tvOrderTotalAndQty.text = String.format("₹ %.2f · Qty: %d", data.totalPrice, totalQty)
        binding.tvReturnInitBadge.text = data.returnStatus.ifBlank { "Return Init" }
        binding.tvDaysSinceShipped.text = "${data.daysSinceShipped} days since shipped"

        // Item Card
        val item = data.items.firstOrNull()
        if (item != null) {
            binding.tvProductSku.text = item.masterSku.ifBlank { item.sku }
            binding.tvItemQtyBadge.text = "Qty: ${item.quantity}"

            // Load reference catalog image
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

        // Steppers initial: 0 Good, 1 Bad (since opening claim)
        receivedGood = 0
        receivedBad = totalQty
        acceptedGood = 0
        acceptedBad = 0
        updateSteppersUi()

        // Populate Templates
        setupTemplates(data)

        // Pre-fill Step 2 inputs
        binding.etPacketId.setText(data.packetId)
        binding.etAwbNumber.setText(data.trackingNumber)

        showStep(1)
    }

    private fun updateSteppersUi() {
        binding.tvGoodCount.text = receivedGood.toString()
        binding.tvBadCount.text = receivedBad.toString()
        binding.tvAcceptedGoodCount.text = acceptedGood.toString()
        binding.tvAcceptedBadCount.text = acceptedBad.toString()
    }

    private fun setupTemplates(data: ClaimReturnLookup) {
        val templates = data.templates
        if (templates.isEmpty()) return

        val templateTypeLabels = listOf("Standard Return Claim (${templates.size} available)")
        binding.spinnerClaimTemplateType.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            templateTypeLabels
        )

        val templateNames = templates.map { it.name }
        binding.spinnerClaimTemplate.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            templateNames
        )

        binding.spinnerClaimTemplate.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                selectedTemplate = templates.getOrNull(position)
                applyTemplateDefaults(selectedTemplate)
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        selectedTemplate = templates.firstOrNull()
        applyTemplateDefaults(selectedTemplate)
    }

    private fun applyTemplateDefaults(tpl: ClaimTemplate?) {
        if (tpl == null) return
        val data = lookupData ?: return

        // Set suggested title & content from reason matching template
        val reason = data.standardReasons.firstOrNull { it.label.contains(tpl.name, ignoreCase = true) }
            ?: data.standardReasons.firstOrNull()

        if (binding.etClaimTitle.text.isNullOrBlank()) {
            binding.etClaimTitle.setText(reason?.suggestedTitle ?: "Claim for Order ${data.orderId}")
        }
        if (binding.etClaimContent.text.isNullOrBlank()) {
            binding.etClaimContent.setText(reason?.suggestedContent ?: tpl.description)
        }

        // Build Step 2 dynamic evidence slots according to template fields
        buildDynamicEvidenceCards(tpl.fields)
    }

    private fun buildDynamicEvidenceCards(fields: List<ClaimFieldTemplate>) {
        binding.layoutDynamicEvidenceCards.removeAllViews()
        evidenceCardBindings.clear()

        val inflater = LayoutInflater.from(this)
        for (field in fields) {
            val card = ItemClaimEvidenceCardBinding.inflate(inflater, binding.layoutDynamicEvidenceCards, false)
            val isRequired = field.required
            val reqSuffix = if (isRequired) " *" else ""
            card.tvEvidenceLabel.text = "${field.fieldLabel}$reqSuffix"
            card.tvEvidenceCount.text = "0 / ${field.maxCount}"

            val isVideo = field.fieldType == "video"
            if (isVideo) {
                card.btnCapturePrimary.text = "Record Video"
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
        if (lookupData == null) {
            showMessage("Please find and select a return first.")
            return false
        }
        val title = binding.etClaimTitle.text?.toString()?.trim().orEmpty()
        if (title.isBlank()) {
            showMessage("Please enter a Claim Title.")
            binding.etClaimTitle.requestFocus()
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
        }
    }

    private fun submitCompleteClaim() {
        val data = lookupData ?: return
        val tpl = selectedTemplate

        // Validate required fields
        if (tpl != null) {
            for (field in tpl.fields) {
                if (field.required) {
                    val files = capturedFiles[field.fieldKey]
                    if (files.isNullOrEmpty()) {
                        showMessage("Please provide required evidence: ${field.fieldLabel}")
                        return
                    }
                }
            }
        }

        val packetId = binding.etPacketId.text?.toString()?.trim().orEmpty()
        val awb = binding.etAwbNumber.text?.toString()?.trim().orEmpty()
        if (awb.isBlank()) {
            showMessage("AWB Number is required.")
            binding.etAwbNumber.requestFocus()
            return
        }

        binding.progressClaim.visibility = View.VISIBLE
        binding.btnSubmitClaim.isEnabled = false

        val item = data.items.firstOrNull()

        lifecycleScope.launch {
            val body = JSONObject().apply {
                if (data.scanId != null && data.scanId > 0) {
                    put("receiptScanId", data.scanId)
                }
                put("expectedReturnId", data.expectedReturnId)
                put("claimReason", tpl?.name ?: "Wrong Product")
                put("claimTitle", binding.etClaimTitle.text?.toString()?.trim().orEmpty())
                put("claimDescription", binding.etClaimContent.text?.toString()?.trim().orEmpty())
                put("claimContent", binding.etClaimContent.text?.toString()?.trim().orEmpty())
                put("remarks", binding.etReturnComment.text?.toString()?.trim().orEmpty())
                put("claimTemplateId", tpl?.id ?: 1)
                put("customerName", data.customerName)
                put("totalPrice", data.totalPrice)
                put("shippedDate", data.shippedDate ?: "")
                put("sku", item?.masterSku ?: item?.sku ?: "")
                put("packetId", packetId)
                put("awb", awb)
            }

            val createResult = api.unifiedCreateClaim(body)
            binding.progressClaim.visibility = View.GONE

            createResult.onSuccess { result ->
                val claimId = result.claimId
                // Enqueue all captured files into WorkManager
                queueAllFilesForUpload(claimId)

                MaterialAlertDialogBuilder(this@ClaimCaptureActivity)
                    .setTitle("Claim Submitted")
                    .setMessage("Claim #$claimId created successfully! Evidence files are saved safely on device and uploading in background.")
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
            .setTitle("Claim Evidence Guidelines")
            .setMessage("Capture clear photos of the shipping label, packet barcode, reverse waybill, and received product.\nFor Myntra, Meesho, and Ajio, an unboxing video is required.")
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
        const val EXTRA_MARKETPLACE = "extra_marketplace"
        const val EXTRA_MARKETPLACE_ID = "extra_marketplace_id"
        const val EXTRA_SCAN_ID = "extra_scan_id"

        private const val TARGET_SEARCH = 0
        private const val TARGET_PACKET_ID = 1
        private const val TARGET_AWB = 2

        private const val MAX_IMAGE_BYTES = 25L * 1024L * 1024L
        private const val MAX_VIDEO_BYTES = 25L * 1024L * 1024L
    }
}
