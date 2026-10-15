package shop.youthnic.returnscan.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
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
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.claim.ClaimEvidenceUploadWorker
import shop.youthnic.returnscan.data.ClaimScanResult
import shop.youthnic.returnscan.data.MeeshoClaimDraft
import shop.youthnic.returnscan.databinding.ActivityClaimCaptureBinding
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

class ClaimCaptureActivity : AppCompatActivity() {

    private lateinit var binding: ActivityClaimCaptureBinding
    private val api get() = (application as ReturnScanApp).apiClient
    private var scan: ClaimScanResult? = null
    private var draft: MeeshoClaimDraft? = null
    private var claimId: Int = 0
    private var pendingField = ""
    private var pendingPhoto: File? = null

    private val takePhoto = registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val file = pendingPhoto
        if (saved && file != null) queueEvidence(pendingField, file, "image/jpeg") else file?.delete()
        pendingPhoto = null
    }

    private val pickImage = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) copyAndQueue(uri, pendingField)
    }

    private val pickAttachments = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        uris.take(5).forEach { copyAndQueue(it, "attachments") }
    }

    private val recordVideo = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@registerForActivityResult
        val path = result.data?.getStringExtra(ClaimVideoCaptureActivity.EXTRA_FILE_PATH).orEmpty()
        if (path.isNotBlank()) {
            val file = File(path)
            if (file.length() <= ClaimVideoCaptureActivity.MAX_BYTES) {
                queueEvidence("unboxing_video", file, "video/mp4")
            } else {
                file.delete()
                showMessage("Video exceeded 25 MB. Please record again.")
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityClaimCaptureBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnClaimBack.setOnClickListener { finish() }
        binding.btnClaimSearch.setOnClickListener { search() }
        binding.btnCreateClaim.setOnClickListener { createOrResumeClaim() }
        binding.btnBarcodeImage.setOnClickListener { chooseImageSource("barcode_image", "Barcode image") }
        binding.btnProductImage.setOnClickListener { chooseImageSource("product_images", "Image of product received") }
        binding.btnReverseWaybill.setOnClickListener { chooseImageSource("reverse_waybill", "Reverse waybill") }
        binding.btnUnpackingVideo.setOnClickListener {
            recordVideo.launch(Intent(this, ClaimVideoCaptureActivity::class.java))
        }
        binding.btnAttachments.setOnClickListener { pickAttachments.launch("*/*") }
    }

    private fun search() {
        val value = binding.etClaimSearch.text?.toString()?.trim().orEmpty()
        if (value.length < 3) {
            showMessage("Enter at least 3 characters from the AWB or order ID.")
            return
        }
        binding.progressClaim.visibility = View.VISIBLE
        binding.btnClaimSearch.isEnabled = false
        lifecycleScope.launch {
            val result = api.searchClaimScans(value)
            binding.progressClaim.visibility = View.GONE
            binding.btnClaimSearch.isEnabled = true
            result.onSuccess { rows ->
                val meesho = rows.filter { it.marketplace.equals("Meesho", ignoreCase = true) }
                when {
                    meesho.isEmpty() -> showMessage("No saved Meesho return found.")
                    meesho.size == 1 -> loadDraft(meesho.first())
                    else -> chooseScan(meesho)
                }
            }.onFailure { showMessage(it.message ?: "Could not search claims.") }
        }
    }

    private fun chooseScan(rows: List<ClaimScanResult>) {
        val labels = rows.map { "${it.trackingId} · ${it.orderId}" }.toTypedArray()
        MaterialAlertDialogBuilder(this)
            .setTitle("Choose Meesho return")
            .setItems(labels) { _, which -> loadDraft(rows[which]) }
            .show()
    }

    private fun loadDraft(selected: ClaimScanResult) {
        scan = selected
        claimId = selected.claimId ?: 0
        binding.progressClaim.visibility = View.VISIBLE
        lifecycleScope.launch {
            api.getMeeshoClaimDraft(selected.scanId)
                .onSuccess { renderDraft(it, selected.hasClaim) }
                .onFailure { showMessage(it.message ?: "Could not load Meesho claim details.") }
            binding.progressClaim.visibility = View.GONE
        }
    }

    private fun renderDraft(value: MeeshoClaimDraft, hasClaim: Boolean) {
        draft = value
        binding.layoutClaimDraft.visibility = View.VISIBLE
        binding.tvClaimReference.text = "Sub Order ID: ${value.subOrderId}\nAWB Number: ${value.awb}"
        binding.tvClaimPacket.text = "State of packet: ${value.packetState}\nPacket ID: ${value.packetId.ifBlank { "Missing flyer ID" }}"
        binding.tvClaimTat.text = if (value.overdue) {
            "Claim deadline ${value.dueDate} · OVERDUE by ${kotlin.math.abs(value.daysRemaining)} day(s)"
        } else {
            "File by ${value.dueDate} · ${value.daysRemaining} day(s) remaining"
        }
        val labels = value.issueOptions.map { it.label }
        binding.spinnerClaimIssue.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
        binding.spinnerClaimIssue.setSelection(0)
        binding.tvClaimDescription.text = value.issueOptions.firstOrNull()?.description.orEmpty()
        binding.spinnerClaimIssue.setOnItemSelectedListener(SimpleItemSelectedListener { position ->
            binding.tvClaimDescription.text = value.issueOptions.getOrNull(position)?.description.orEmpty()
        })
        binding.btnCreateClaim.text = if (hasClaim) "Continue evidence for claim #$claimId" else "Create claim and capture evidence"
        if (hasClaim && claimId > 0) binding.layoutClaimEvidence.visibility = View.VISIBLE
        binding.tvClaimMessage.text = if (value.flyerState == "scanned") "" else "Packet ID is missing. This claim cannot be created."
    }

    private fun createOrResumeClaim() {
        if (claimId > 0) {
            binding.layoutClaimEvidence.visibility = View.VISIBLE
            return
        }
        val selectedDraft = draft ?: return
        val issue = selectedDraft.issueOptions.getOrNull(binding.spinnerClaimIssue.selectedItemPosition) ?: return
        binding.btnCreateClaim.isEnabled = false
        lifecycleScope.launch {
            api.createMeeshoClaim(selectedDraft.scanId, issue.code)
                .onSuccess {
                    claimId = it
                    binding.layoutClaimEvidence.visibility = View.VISIBLE
                    binding.btnCreateClaim.text = "Claim #$it created"
                    showMessage("Claim created. Capture every required file.")
                }
                .onFailure { showMessage(it.message ?: "Could not create claim.") }
            binding.btnCreateClaim.isEnabled = true
        }
    }

    private fun chooseImageSource(fieldKey: String, title: String) {
        if (!requireClaim()) return
        pendingField = fieldKey
        MaterialAlertDialogBuilder(this)
            .setTitle(title)
            .setItems(arrayOf("Take photo", "Choose from gallery")) { _, which ->
                if (which == 0) launchPhoto(fieldKey) else pickImage.launch("image/*")
            }
            .show()
    }

    private fun launchPhoto(fieldKey: String) {
        pendingField = fieldKey
        val file = evidenceFile(fieldKey, ".jpg")
        pendingPhoto = file
        val uri = FileProvider.getUriForFile(this, "$packageName.updates", file)
        takePhoto.launch(uri)
    }

    private fun copyAndQueue(uri: Uri, fieldKey: String) {
        if (!requireClaim()) return
        val mime = contentResolver.getType(uri).orEmpty().ifBlank { "application/octet-stream" }
        val extension = when {
            mime == "image/png" -> ".png"
            mime == "image/webp" -> ".webp"
            mime.startsWith("image/") -> ".jpg"
            mime == "application/pdf" -> ".pdf"
            else -> ".bin"
        }
        val file = evidenceFile(fieldKey, extension)
        try {
            contentResolver.openInputStream(uri)?.use { input ->
                file.outputStream().use { output -> input.copyTo(output) }
            } ?: throw IllegalStateException("File cannot be opened")
            if (file.length() > MAX_FILE_BYTES) {
                file.delete()
                showMessage("Each attachment must be under 25 MB.")
                return
            }
            queueEvidence(fieldKey, file, mime)
        } catch (error: Exception) {
            file.delete()
            showMessage(error.message ?: "Could not copy the selected file.")
        }
    }

    private fun queueEvidence(fieldKey: String, file: File, mimeType: String) {
        if (!requireClaim()) return
        val data = Data.Builder()
            .putInt(ClaimEvidenceUploadWorker.KEY_CLAIM_ID, claimId)
            .putString(ClaimEvidenceUploadWorker.KEY_FIELD_KEY, fieldKey)
            .putString(ClaimEvidenceUploadWorker.KEY_FILE_PATH, file.absolutePath)
            .putString(ClaimEvidenceUploadWorker.KEY_MIME_TYPE, mimeType)
            .build()
        val request = OneTimeWorkRequestBuilder<ClaimEvidenceUploadWorker>()
            .setInputData(data)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(this).enqueue(request)
        binding.tvEvidenceQueue.text = "${file.name} saved safely and queued for upload."
        showMessage("Evidence saved. Upload will retry automatically if the network disconnects.")
    }

    private fun requireClaim(): Boolean {
        if (claimId > 0) return true
        showMessage("Create the claim before capturing evidence.")
        return false
    }

    private fun evidenceFile(fieldKey: String, extension: String): File {
        val directory = File(filesDir, "claim-evidence").apply { mkdirs() }
        return File(directory, "claim-$claimId-$fieldKey-${UUID.randomUUID()}$extension")
    }

    private fun showMessage(message: String) {
        binding.tvClaimMessage.text = message
        Snackbar.make(binding.root, message, Snackbar.LENGTH_LONG).show()
    }

    companion object {
        private const val MAX_FILE_BYTES = 25L * 1024L * 1024L
    }
}
