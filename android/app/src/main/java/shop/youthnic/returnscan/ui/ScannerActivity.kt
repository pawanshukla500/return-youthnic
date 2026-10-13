package shop.youthnic.returnscan.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.ColorRes
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.AppRelease
import shop.youthnic.returnscan.data.AuthExpiredException
import shop.youthnic.returnscan.data.BarcodeRules
import shop.youthnic.returnscan.data.DuplicateGuard
import shop.youthnic.returnscan.data.LookupResult
import shop.youthnic.returnscan.data.NetworkException
import shop.youthnic.returnscan.data.RecentScan
import shop.youthnic.returnscan.data.ScanReceipt
import shop.youthnic.returnscan.data.ScanSessionData
import shop.youthnic.returnscan.databinding.ActivityScannerBinding
import shop.youthnic.returnscan.update.AppUpdater
import shop.youthnic.returnscan.util.CameraTuning
import shop.youthnic.returnscan.util.Cue
import shop.youthnic.returnscan.util.ScanSignals
import shop.youthnic.returnscan.util.Ui
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs

class ScannerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityScannerBinding
    private var accountId: String = ""
    private var accountName: String = ""
    private var marketplace: String = ""
    private var channelColor: String = ""

    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var isTorchOn = false
    private lateinit var cameraExecutor: ExecutorService
    private var barcodeScanner: BarcodeScanner? = null

    private val duplicateGuard = DuplicateGuard(sameCodeSuppressMs = 8000L, anyCodeCooldownMs = 1500L)
    private val isRequestInFlight = AtomicBoolean(false)
    private val openDialogs = AtomicInteger(0)

    private var cameraRunning = false
    private var lastAnalyzedAt = 0L
    private var lastActivityAt = 0L
    private var idleJob: Job? = null
    private var flashJob: Job? = null

    private lateinit var flashView: View
    private var activeVerificationSheet: ReturnVerificationBottomSheet? = null
    private var sessionData = ScanSessionData()
    private val recentScansList = mutableListOf<RecentScan>()
    private var scannedCountToday = 0

    private val requestCameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            startCamera()
        } else {
            Toast.makeText(this, "Camera permission is required to scan return barcodes", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityScannerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        accountId = intent.getStringExtra(EXTRA_ACCOUNT_ID).orEmpty()
        accountName = intent.getStringExtra(EXTRA_ACCOUNT_NAME).orEmpty()
        marketplace = intent.getStringExtra(EXTRA_MARKETPLACE).orEmpty()
        channelColor = intent.getStringExtra(EXTRA_COLOR).orEmpty()

        cameraExecutor = Executors.newSingleThreadExecutor()
        initFlashOverlay()
        initUi()
        initBarcodeScanner()
        loadSessionData()

        if (hasCameraPermission()) {
            startCamera()
        } else {
            requestCameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onResume() {
        super.onResume()
        noteActivity()
        resumeCamera()
        startIdleWatch()
        checkForUpdates()
    }

    override fun onPause() {
        super.onPause()
        idleJob?.cancel()
        pauseCamera()
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        barcodeScanner?.close()
    }

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun initFlashOverlay() {
        flashView = View(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            visibility = View.GONE
        }
        (window.decorView as ViewGroup).addView(flashView)
    }

    private fun initUi() {
        binding.tvActiveMarketplace.text = if (marketplace.isNotBlank()) "$accountName ($marketplace)" else accountName
        if (channelColor.isNotBlank()) {
            val color = Ui.parseColor(channelColor, ContextCompat.getColor(this, R.color.colorPrimary))
            Ui.tint(binding.btnTorch, color)
        }

        binding.btnTorch.setOnClickListener { toggleTorch() }
        binding.btnManualEntry.setOnClickListener { showManualEntryDialog() }
        binding.btnRecentScans.setOnClickListener { showRecentScansDialog() }
        binding.btnResumeCamera.setOnClickListener { resumeCamera() }

        updateCountsUi()
    }

    private fun loadSessionData() {
        lifecycleScope.launch {
            val app = application as ReturnScanApp
            val result = withContext(Dispatchers.IO) { app.apiClient.getSessionData(accountId) }
            if (result.isSuccess) {
                result.getOrNull()?.let {
                    sessionData = it
                    scannedCountToday = it.shiftProgress.scannedToday
                    updateCountsUi()
                }
            }
        }
    }

    private fun updateCountsUi() {
        binding.tvProgressScanned.text = getString(R.string.scanned_today_format, Ui.count(scannedCountToday))
        binding.progressBarScans.progress = (scannedCountToday % 100)
    }

    private fun checkForUpdates() {
        lifecycleScope.launch {
            val release = AppUpdater.check(this@ScannerActivity).getOrNull()
            if (release != null) {
                binding.tvUpdateBanner.text = getString(R.string.update_scanner_banner, release.versionName)
                binding.tvUpdateBanner.visibility = View.VISIBLE
                binding.tvUpdateBanner.setOnClickListener {
                    AppUpdater.showUpdateDialog(this@ScannerActivity, release, always = true)
                }
            } else {
                binding.tvUpdateBanner.visibility = View.GONE
            }
        }
    }

    // ---- Camera & Barcode Scanner -------------------------------------------------------------------

    private fun initBarcodeScanner() {
        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(
                Barcode.FORMAT_CODE_128,
                Barcode.FORMAT_CODE_39,
                Barcode.FORMAT_CODE_93,
                Barcode.FORMAT_CODABAR,
                Barcode.FORMAT_ITF,
                Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_EAN_8,
                Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E
            )
            .build()
        barcodeScanner = BarcodeScanning.getClient(options)
    }

    private fun startCamera() {
        binding.tvScannerHint.text = getString(R.string.preparing_scanner)
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            try {
                cameraProvider = cameraProviderFuture.get()
                bindCameraUseCases()
            } catch (e: Exception) {
                binding.tvScannerHint.text = "Error starting camera: ${e.message}"
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun bindCameraUseCases() {
        val provider = cameraProvider ?: return
        provider.unbindAll()

        val hdSize = android.util.Size(CameraTuning.HD.first, CameraTuning.HD.second)
        val preview = Preview.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(ResolutionStrategy(hdSize, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                    .build()
            )
            .build()
            .also { it.setSurfaceProvider(binding.previewView.surfaceProvider) }

        val imageAnalysis = ImageAnalysis.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(ResolutionStrategy(hdSize, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                    .build()
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()

        imageAnalysis.setAnalyzer(cameraExecutor) { imageProxy ->
            processImageProxy(imageProxy)
        }

        try {
            camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageAnalysis)
            cameraRunning = true
            binding.layoutCameraPaused.visibility = View.GONE
            binding.tvScannerHint.text = getString(R.string.aim_at_awb)
            updateKeepScreenOn()
        } catch (e: Exception) {
            cameraRunning = false
            binding.tvScannerHint.text = "Camera bind error: ${e.message}"
            binding.layoutCameraPaused.visibility = View.VISIBLE
        }
    }

    @SuppressLint("UnsafeOptInUsageError")
    private fun processImageProxy(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        val scanner = barcodeScanner
        if (mediaImage == null || scanner == null || !cameraRunning || openDialogs.get() > 0 || isRequestInFlight.get()) {
            imageProxy.close()
            return
        }

        val now = SystemClock.elapsedRealtime()
        if (now - lastAnalyzedAt < CameraTuning.ANALYZE_EVERY_MS) {
            imageProxy.close()
            return
        }
        lastAnalyzedAt = now

        val rotation = imageProxy.imageInfo.rotationDegrees
        val image = InputImage.fromMediaImage(mediaImage, rotation)

        scanner.process(image)
            .addOnSuccessListener { barcodes ->
                onBarcodesDetected(barcodes)
            }
            .addOnCompleteListener {
                imageProxy.close()
            }
    }

    private fun onBarcodesDetected(barcodes: List<Barcode>) {
        if (isRequestInFlight.get() || openDialogs.get() > 0) return

        for (barcode in barcodes) {
            val rawValue = BarcodeRules.normalize(barcode.rawValue)
            val format = barcode.format

            if (rawValue.isBlank()) continue
            if (!BarcodeRules.isAllowed1DFormat(format)) continue
            if (BarcodeRules.looksLikeQr(rawValue)) continue

            if (!duplicateGuard.shouldProcess(rawValue)) continue

            duplicateGuard.markEmitted(rawValue)
            runOnUiThread {
                executeLookup(rawValue)
            }
            break
        }
    }

    // ---- Lookup & Verification Workflow ------------------------------------------------------------

    private fun executeLookup(rawAwb: String) {
        if (!isRequestInFlight.compareAndSet(false, true)) return
        noteActivity()

        binding.progressSubmitting.visibility = View.VISIBLE
        binding.tvScannerHint.text = "Looking up AWB: $rawAwb"

        val app = application as ReturnScanApp
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                app.apiClient.lookup(accountId, rawAwb)
            }

            binding.progressSubmitting.visibility = View.GONE
            binding.tvScannerHint.text = getString(R.string.aim_at_awb)

            if (result.isSuccess) {
                val lookup = result.getOrThrow()
                handleLookupResponse(rawAwb, lookup)
            } else {
                isRequestInFlight.set(false)
                val ex = result.exceptionOrNull()
                if (ex is AuthExpiredException) {
                    goToLogin()
                    return@launch
                }
                duplicateGuard.forget(rawAwb)
                signal(Cue.STOP)
                showBannerError(rawAwb, ex?.message ?: "Lookup request failed")
            }
        }
    }

    private fun handleLookupResponse(rawAwb: String, lookup: LookupResult) {
        when (lookup.status.uppercase()) {
            "FOUND" -> {
                // Attention / inspection needed - NOT OK yet!
                signal(Cue.CHECK)
                showVerificationSheet(lookup)
            }
            "DUPLICATE" -> {
                isRequestInFlight.set(false)
                signal(Cue.DUPLICATE)
                showBannerDuplicate(rawAwb, lookup)
            }
            "NOT_FOUND" -> {
                isRequestInFlight.set(false)
                signal(Cue.NOT_FOUND)
                showBannerNotFound(rawAwb)
            }
            else -> {
                isRequestInFlight.set(false)
                signal(Cue.STOP)
                showBannerError(rawAwb, "Unexpected status: ${lookup.status}")
            }
        }
    }

    private fun showVerificationSheet(lookup: LookupResult) {
        openDialogs.incrementAndGet()
        val idempotencyKey = BarcodeRules.generateClientScanKey(accountId, lookup.trackingNumber)

        val sheet = ReturnVerificationBottomSheet(
            activity = this,
            lookup = lookup,
            sessionData = sessionData,
            onSave = { submitData ->
                commitVerificationSave(idempotencyKey, lookup, submitData)
            },
            onCancel = {
                openDialogs.decrementAndGet()
                isRequestInFlight.set(false)
                activeVerificationSheet = null
                resumeCamera()
            }
        )

        activeVerificationSheet = sheet
        sheet.show()
    }

    private fun commitVerificationSave(
        clientScanKey: String,
        lookup: LookupResult,
        data: VerificationSubmitData
    ) {
        val app = application as ReturnScanApp
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                app.apiClient.completeScan(
                    accountId = accountId,
                    shipmentId = data.shipmentId,
                    clientScanKey = clientScanKey,
                    scannedTracking = data.scannedTracking,
                    items = data.items
                )
            }

            if (result.isSuccess) {
                val receipt = result.getOrThrow()
                onSaveSuccess(lookup, receipt, data)
            } else {
                val err = result.exceptionOrNull()?.message ?: "Failed to save return scan"
                signal(Cue.STOP)
                activeVerificationSheet?.showSaveError(err)
            }
        }
    }

    private fun onSaveSuccess(
        lookup: LookupResult,
        receipt: ScanReceipt,
        data: VerificationSubmitData
    ) {
        // Successful PostgreSQL commit confirmed: OK signal!
        signal(Cue.OK)

        // Close verification sheet
        activeVerificationSheet?.dismiss()
        activeVerificationSheet = null
        openDialogs.decrementAndGet()

        // Update counts
        scannedCountToday++
        updateCountsUi()

        // Record recent scan
        val primaryItem = data.items.firstOrNull()
        val outcome = if (primaryItem?.categoryCode == "CLEAR") "CLEAR" else primaryItem?.categoryCode ?: "VERIFIED"
        recentScansList.add(
            RecentScan(
                awb = lookup.trackingNumber,
                marketplace = lookup.marketplace,
                courier = lookup.carrier,
                itemsSummary = "${data.items.sumOf { it.receivedQty }} unit(s)",
                outcome = outcome,
                timestamp = System.currentTimeMillis().toString()
            )
        )

        showBannerSuccess(lookup.trackingNumber, lookup.orderId, outcome)

        // Seamless auto-resume for the next return: no "Scan Again" button needed!
        lifecycleScope.launch {
            delay(500)
            isRequestInFlight.set(false)
            resumeCamera()
        }
    }

    // ---- Signals & Banner ---------------------------------------------------------------------------

    private fun signal(cue: Cue) {
        val app = application as ReturnScanApp
        app.soundManager.play(cue)

        if (app.sessionManager.screenFlashEnabled) {
            flashScreen(cue)
        }
    }

    private fun flashScreen(cue: Cue) {
        flashJob?.cancel()
        val colorRes = when (cue) {
            Cue.OK -> R.color.verdict_ok
            Cue.DUPLICATE -> R.color.verdict_duplicate
            Cue.NOT_FOUND -> R.color.verdict_unverified
            Cue.CHECK -> R.color.verdict_check
            Cue.STOP -> R.color.verdict_stop
        }
        val color = ContextCompat.getColor(this, colorRes)

        flashJob = lifecycleScope.launch {
            flashView.visibility = View.VISIBLE
            val totalDur = ScanSignals.flashDurationMs(cue)
            val startTime = SystemClock.elapsedRealtime()

            while (isActive) {
                val elapsed = (SystemClock.elapsedRealtime() - startTime).toInt()
                if (elapsed >= totalDur) break

                val level = ScanSignals.flashLevel(cue, elapsed)
                val alpha = (level * ScanSignals.FLASH_MAX_ALPHA * 255).toInt().coerceIn(0, 255)
                flashView.setBackgroundColor((alpha shl 24) or (color and 0x00FFFFFF))

                delay(16)
            }
            flashView.visibility = View.GONE
        }
    }

    private fun showBannerSuccess(awb: String, orderId: String, outcome: String) {
        binding.cardScanBanner.visibility = View.VISIBLE
        binding.tvBannerStatus.text = "SAVED: $outcome"
        Ui.pillRes(binding.tvBannerStatus, R.color.verdict_ok, R.color.verdict_ok_bg)
        binding.tvBannerAwb.text = awb
        binding.tvBannerOrder.text = "Order: $orderId"
        binding.tvBannerDetails.text = "Return scan committed to database"
    }

    private fun showBannerDuplicate(awb: String, lookup: LookupResult) {
        binding.cardScanBanner.visibility = View.VISIBLE
        binding.tvBannerStatus.text = "DUPLICATE SCAN"
        Ui.pillRes(binding.tvBannerStatus, R.color.verdict_duplicate, R.color.verdict_duplicate_bg)
        binding.tvBannerAwb.text = awb
        val dup = lookup.duplicateDetails
        if (dup != null) {
            binding.tvBannerOrder.text = "Previously scanned by ${dup.scannedBy}"
            binding.tvBannerDetails.text = "At ${dup.scannedAt} · AWB already in register"
        } else {
            binding.tvBannerOrder.text = "AWB already scanned"
            binding.tvBannerDetails.text = "Set packet aside"
        }
    }

    private fun showBannerNotFound(awb: String) {
        binding.cardScanBanner.visibility = View.VISIBLE
        binding.tvBannerStatus.text = "NOT FOUND"
        Ui.pillRes(binding.tvBannerStatus, R.color.verdict_unverified, R.color.verdict_unverified_bg)
        binding.tvBannerAwb.text = awb
        binding.tvBannerOrder.text = "Not in active return lookup"
        binding.tvBannerDetails.text = "Verify marketplace report upload"
    }

    private fun showBannerError(awb: String, message: String) {
        binding.cardScanBanner.visibility = View.VISIBLE
        binding.tvBannerStatus.text = "ERROR"
        Ui.pillRes(binding.tvBannerStatus, R.color.verdict_stop, R.color.verdict_stop_bg)
        binding.tvBannerAwb.text = awb
        binding.tvBannerOrder.text = message
        binding.tvBannerDetails.text = "Check connection or retry"
    }

    // ---- Dialogs & Controls ------------------------------------------------------------------------

    private fun toggleTorch() {
        val cam = camera ?: return
        isTorchOn = !isTorchOn
        cam.cameraControl.enableTorch(isTorchOn)
        binding.btnTorch.alpha = if (isTorchOn) 1.0f else 0.6f
    }

    private fun showManualEntryDialog() {
        openDialogs.incrementAndGet()
        val dialog = ManualScanDialog(this) { manualAwb ->
            openDialogs.decrementAndGet()
            executeLookup(manualAwb)
        }
        dialog.setOnDismissListener {
            openDialogs.decrementAndGet()
            resumeCamera()
        }
        dialog.show()
    }

    private fun showRecentScansDialog() {
        openDialogs.incrementAndGet()
        val dialog = RecentScansDialog(this, recentScansList)
        dialog.setOnDismissListener {
            openDialogs.decrementAndGet()
            resumeCamera()
        }
        dialog.show()
    }

    private fun noteActivity() {
        lastActivityAt = SystemClock.elapsedRealtime()
    }

    private fun startIdleWatch() {
        idleJob?.cancel()
        idleJob = lifecycleScope.launch {
            while (isActive) {
                delay(5000)
                val idleFor = SystemClock.elapsedRealtime() - lastActivityAt
                if (cameraRunning && idleFor >= CameraTuning.IDLE_PAUSE_MS && !isRequestInFlight.get() && openDialogs.get() == 0) {
                    pauseCamera()
                }
            }
        }
    }

    private fun pauseCamera() {
        if (!cameraRunning) return
        cameraRunning = false
        cameraProvider?.unbindAll()
        camera = null
        binding.layoutCameraPaused.visibility = View.VISIBLE
        updateKeepScreenOn()
    }

    private fun resumeCamera() {
        noteActivity()
        if (!hasCameraPermission()) return
        binding.layoutCameraPaused.visibility = View.GONE
        if (cameraProvider == null) startCamera() else bindCameraUseCases()
    }

    private fun updateKeepScreenOn() {
        if (cameraRunning) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun goToLogin() {
        startActivity(Intent(this, LoginActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        })
        finish()
    }

    companion object {
        const val EXTRA_ACCOUNT_ID = "extra_account_id"
        const val EXTRA_ACCOUNT_NAME = "extra_account_name"
        const val EXTRA_MARKETPLACE = "extra_marketplace"
        const val EXTRA_COLOR = "extra_color"
    }
}
