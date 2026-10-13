package shop.youthnic.returnscan.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.ColorRes
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.AuthExpiredException
import shop.youthnic.returnscan.data.BarcodeRules
import shop.youthnic.returnscan.data.DuplicateGuard
import shop.youthnic.returnscan.data.LookupResult
import shop.youthnic.returnscan.data.NetworkException
import shop.youthnic.returnscan.data.RecentScan
import shop.youthnic.returnscan.data.ScanReceipt
import shop.youthnic.returnscan.data.ScanSessionData
import shop.youthnic.returnscan.data.VerificationSubmitData
import shop.youthnic.returnscan.databinding.ActivityScannerBinding
import shop.youthnic.returnscan.update.AppUpdater
import shop.youthnic.returnscan.util.CameraPermission
import shop.youthnic.returnscan.util.CameraTuning
import shop.youthnic.returnscan.util.Cue
import shop.youthnic.returnscan.util.ScanSignals
import shop.youthnic.returnscan.util.Ui
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class ScannerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityScannerBinding
    private var accountId: String = ""
    private var accountName: String = ""
    private var marketplace: String = ""
    private var channelColor: String = ""

    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var isTorchOn = false
    private val cameraExecutor: ExecutorService by lazy { Executors.newSingleThreadExecutor() }
    private var barcodeScanner: BarcodeScanner? = null

    private val duplicateGuard = DuplicateGuard(sameCodeSuppressMs = 8000L, anyCodeCooldownMs = 1500L)
    private val isRequestInFlight = AtomicBoolean(false)
    private val openDialogs = AtomicInteger(0)

    private var cameraRunning = false
    private var cameraStarting = false
    private var scannerEngineFailed = false
    private var lastAnalyzedAt = 0L
    private var lastActivityAt = 0L
    private var idleJob: Job? = null
    private var flashJob: Job? = null

    private lateinit var flashView: View
    private var activeVerificationSheet: ReturnVerificationBottomSheet? = null
    // The sheet whose return was just saved. Compared by identity, so a late reply can only ever close its own sheet.
    private var savedSheet: ReturnVerificationBottomSheet? = null
    private var sessionData = ScanSessionData()
    private val recentScansList = mutableListOf<RecentScan>()
    private var scannedCountToday = 0

    private val sessionManager get() = (application as ReturnScanApp).sessionManager

    // The answer to Android's own camera dialog. A refusal does not close the scanner: Manual AWB still works, and
    // the overlay says how to allow the camera.
    private val requestCameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            resumeCamera()
        } else {
            showCameraNeeded()
            Toast.makeText(this, R.string.camera_denied_toast, Toast.LENGTH_LONG).show()
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

        initFlashOverlay()
        initUi()
        initBarcodeScanner()
        loadSessionData()

        // Build the beep tones once the first frame is up, so the first scan result is not late.
        binding.root.post { (application as ReturnScanApp).soundManager.prepare() }

        if (!CameraPermission.isGranted(this)) requestCameraAccess()
    }

    override fun onResume() {
        super.onResume()
        noteActivity()
        if (CameraPermission.isGranted(this)) resumeCamera() else showCameraNeeded()
        startIdleWatch()
        checkForUpdates()
    }

    override fun onPause() {
        super.onPause()
        idleJob?.cancel()
        pauseCamera(showOverlay = false)
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        barcodeScanner?.close()
    }

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
        binding.tvActiveMarketplace.text = if (marketplace.isNotBlank() && marketplace != accountName) {
            "$accountName ($marketplace)"
        } else {
            accountName
        }
        if (channelColor.isNotBlank()) {
            val color = Ui.parseColor(channelColor, ContextCompat.getColor(this, R.color.colorPrimary))
            Ui.tint(binding.viewChannelColor, color)
        }

        binding.btnBack.setOnClickListener { finish() }
        binding.btnSettings.setOnClickListener { startActivity(Intent(this, SettingsActivity::class.java)) }
        binding.btnTorch.setOnClickListener { toggleTorch() }
        binding.btnManualEntry.setOnClickListener { showManualEntryDialog() }
        binding.btnRecentScans.setOnClickListener { showRecentScansDialog() }
        // The whole overlay is the wake target ("Tap screen to wake camera"), not only the small button.
        binding.btnResumeCamera.setOnClickListener { onOverlayAction() }
        binding.layoutCameraPaused.setOnClickListener { onOverlayAction() }

        updateTorchUi()
        updateCountsUi()
    }

    private fun loadSessionData() {
        lifecycleScope.launch {
            val app = application as ReturnScanApp
            val result = app.apiClient.getSessionData(accountId)
            val data = result.getOrNull()
            if (data != null) {
                applySessionData(data)
                setOnline(true)
            } else if (result.exceptionOrNull() is NetworkException) {
                setOnline(false)
            }
        }
    }

    /** The issue rules are needed to verify a return. A scanner that opened offline loads them again at the first lookup. */
    private suspend fun ensureSessionData() {
        if (sessionData.categories.isNotEmpty()) return
        val app = application as ReturnScanApp
        app.apiClient.getSessionData(accountId).getOrNull()?.let { applySessionData(it) }
    }

    private fun applySessionData(data: ScanSessionData) {
        sessionData = data
        scannedCountToday = data.shiftProgress.scannedToday
        updateCountsUi()
    }

    private fun updateCountsUi() {
        binding.tvProgressScanned.text = getString(R.string.scanned_today_format, Ui.count(scannedCountToday))
        binding.progressBarScans.progress = (scannedCountToday % 100)
    }

    private fun setOnline(online: Boolean) {
        binding.tvConnectionStatus.setText(if (online) R.string.connection_online else R.string.connection_offline)
        if (online) {
            Ui.pillRes(binding.tvConnectionStatus, R.color.verdict_ok, R.color.verdict_ok_bg)
        } else {
            Ui.pillRes(binding.tvConnectionStatus, R.color.verdict_stop, R.color.verdict_stop_bg)
        }
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

    // ---- Camera permission --------------------------------------------------------------------------

    /** Asks for the camera, or says where to allow it when Android no longer shows the dialog. */
    private fun requestCameraAccess() {
        if (CameraPermission.isGranted(this)) {
            resumeCamera()
            return
        }
        if (CameraPermission.isBlocked(this, sessionManager)) {
            showCameraNeeded()
            return
        }
        sessionManager.askedCameraPermission = true
        requestCameraPermission.launch(CameraPermission.PERMISSION)
    }

    private fun onOverlayAction() {
        if (CameraPermission.isGranted(this)) {
            resumeCamera()
        } else if (CameraPermission.isBlocked(this, sessionManager)) {
            CameraPermission.openAppSettings(this)
        } else {
            requestCameraAccess()
        }
    }

    private fun showCameraNeeded() {
        val blocked = CameraPermission.isBlocked(this, sessionManager)
        binding.tvCameraPausedTitle.setText(R.string.camera_needed_title)
        binding.tvCameraPausedSub.setText(if (blocked) R.string.camera_needed_settings_sub else R.string.camera_needed_sub)
        binding.btnResumeCamera.setText(if (blocked) R.string.camera_needed_settings_action else R.string.camera_needed_action)
        binding.layoutCameraPaused.visibility = View.VISIBLE
    }

    private fun showIdleOverlay() {
        binding.tvCameraPausedTitle.setText(R.string.camera_paused_title)
        binding.tvCameraPausedSub.setText(R.string.camera_paused_sub)
        binding.btnResumeCamera.setText(R.string.camera_paused_action)
        binding.layoutCameraPaused.visibility = View.VISIBLE
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
                Barcode.FORMAT_UPC_E,
                Barcode.FORMAT_QR_CODE,
                Barcode.FORMAT_DATA_MATRIX,
                Barcode.FORMAT_PDF417
            )
            .build()
        barcodeScanner = BarcodeScanning.getClient(options)
    }

    private fun startCamera() {
        if (cameraStarting) return
        cameraStarting = true
        binding.tvScannerHint.text = getString(R.string.preparing_scanner)
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            cameraStarting = false
            if (isFinishing || isDestroyed) return@addListener
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
            val bound = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageAnalysis)
            camera = bound
            cameraRunning = true
            binding.layoutCameraPaused.visibility = View.GONE
            binding.tvScannerHint.text = getString(R.string.aim_at_awb)
            // A rebind (after a pause or a dialog) turns the torch off, so bring it back if it was on.
            if (isTorchOn) bound.cameraControl.enableTorch(true)
            updateKeepScreenOn()
        } catch (e: Exception) {
            cameraRunning = false
            binding.tvScannerHint.text = "Camera bind error: ${e.message}"
            showIdleOverlay()
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
                if (scannerEngineFailed) {
                    scannerEngineFailed = false
                    binding.tvScannerHint.text = getString(R.string.aim_at_awb)
                }
                onBarcodesDetected(barcodes)
            }
            .addOnFailureListener {
                // Google Play services may still be fetching the barcode model, or be missing. Say so once.
                if (!scannerEngineFailed) {
                    scannerEngineFailed = true
                    binding.tvScannerHint.text = getString(R.string.scanner_engine_error)
                }
            }
            .addOnCompleteListener {
                imageProxy.close()
            }
    }

    private fun onBarcodesDetected(barcodes: List<Barcode>) {
        if (isRequestInFlight.get() || openDialogs.get() > 0) return

        for (barcode in barcodes) {
            val format = barcode.format
            if (!BarcodeRules.isSupportedBarcodeFormat(format)) continue

            val rawValue = BarcodeRules.normalize(barcode.rawValue)
            val extracted = BarcodeRules.extractScannedIdentifier(rawValue)
            if (extracted.isBlank()) continue

            if (!duplicateGuard.shouldProcess(extracted)) continue

            duplicateGuard.markEmitted(extracted)
            runOnUiThread {
                executeLookup(extracted)
            }
            break
        }
    }

    // ---- Lookup & Verification Workflow ------------------------------------------------------------

    /**
     * Looks the AWB or Order ID up in the chosen marketplace account. [shipmentId] is set only when the server found several
     * returns for the AWB and the scanner picked one.
     */
    private fun executeLookup(rawAwb: String, shipmentId: Int? = null) {
        if (!isRequestInFlight.compareAndSet(false, true)) return
        noteActivity()

        val isOrder = rawAwb.contains("-") || rawAwb.length == 17
        binding.progressSubmitting.visibility = View.VISIBLE
        binding.tvScannerHint.text = if (isOrder) "Looking up Order: $rawAwb" else "Looking up AWB: $rawAwb"

        val app = application as ReturnScanApp
        lifecycleScope.launch {
            val result = app.apiClient.lookupAwb(rawAwb, accountName, shipmentId)

            binding.progressSubmitting.visibility = View.GONE
            binding.tvScannerHint.text = getString(R.string.aim_at_awb)

            val lookup = result.getOrNull()
            if (lookup != null) {
                setOnline(true)
                handleLookupResponse(rawAwb, lookup)
            } else {
                val ex = result.exceptionOrNull()
                if (ex is AuthExpiredException) {
                    isRequestInFlight.set(false)
                    goToLogin()
                    return@launch
                }
                if (ex is NetworkException) setOnline(false)
                failLookup(rawAwb, ex?.message ?: "Lookup request failed")
            }
        }
    }

    /** Ends a lookup that cannot go on, and lets the same AWB be scanned again as soon as the problem is fixed. */
    private fun failLookup(awb: String, message: String) {
        isRequestInFlight.set(false)
        duplicateGuard.forget(awb)
        signal(Cue.STOP)
        showBannerError(awb, message)
    }

    private suspend fun handleLookupResponse(rawAwb: String, lookup: LookupResult) {
        when (lookup.status) {
            LookupResult.STATUS_FOUND -> {
                if (lookup.items.isEmpty()) {
                    failLookup(rawAwb, getString(R.string.no_items_error))
                    return
                }
                ensureSessionData()
                if (sessionData.categories.isEmpty()) {
                    failLookup(rawAwb, getString(R.string.session_rules_error))
                    return
                }
                // Attention / inspection needed - NOT OK yet!
                signal(Cue.CHECK)
                showVerificationSheet(lookup)
            }
            LookupResult.STATUS_DUPLICATE -> {
                isRequestInFlight.set(false)
                signal(Cue.DUPLICATE)
                showBannerDuplicate(rawAwb, lookup)
            }
            LookupResult.STATUS_CHOOSE -> {
                signal(Cue.CHECK)
                showChooseReturnDialog(rawAwb, lookup)
            }
            LookupResult.STATUS_NOT_FOUND -> {
                isRequestInFlight.set(false)
                signal(Cue.NOT_FOUND)
                showBannerNotFound(rawAwb)
            }
            else -> failLookup(rawAwb, "Unexpected status: ${lookup.status}")
        }
    }

    /** Several returns share this AWB (for example two orders in one parcel). The scanner picks one; nothing is guessed. */
    private fun showChooseReturnDialog(rawAwb: String, lookup: LookupResult) {
        val candidates = lookup.candidates.filter { it.shipmentId > 0 }
        if (candidates.isEmpty()) {
            isRequestInFlight.set(false)
            signal(Cue.NOT_FOUND)
            showBannerNotFound(rawAwb)
            return
        }
        val labels = candidates.map { candidate ->
            val parts = ArrayList<String>()
            parts.add(candidate.accountName)
            if (candidate.orderId.isNotBlank()) parts.add("Order ${candidate.orderId}")
            parts.add("${candidate.itemCount} item(s)")
            if (candidate.alreadyReceived) parts.add(getString(R.string.choose_return_received) + " " + candidate.receivedAt)
            parts.joinToString(" · ")
        }

        var picked = false
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.choose_return_title)
            .setItems(labels.toTypedArray()) { _, which ->
                picked = true
                isRequestInFlight.set(false)
                executeLookup(rawAwb, candidates[which].shipmentId)
            }
            .setNegativeButton(R.string.btn_cancel, null)
            .create()
        dialog.setOnDismissListener {
            openDialogs.decrementAndGet()
            if (!picked) {
                isRequestInFlight.set(false)
                duplicateGuard.forget(rawAwb)
            }
            resumeCamera()
        }
        openDialogs.incrementAndGet()
        dialog.show()
    }

    private fun showVerificationSheet(lookup: LookupResult) {
        val idempotencyKey = BarcodeRules.generateClientScanKey(accountId, lookup.trackingNumber)

        val sheet = ReturnVerificationBottomSheet(
            activity = this,
            lookup = lookup,
            sessionData = sessionData,
            onSave = { submitData ->
                // Save is tapped on the sheet that is showing, so that sheet owns this save and its reply.
                commitVerificationSave(activeVerificationSheet, idempotencyKey, lookup, submitData)
            }
        )
        // Every way out of the sheet ends here: Cancel, the close button, a swipe down, the back key, or a tap outside.
        // Counting it in one place is what keeps the scanner from staying blocked after a swipe.
        sheet.setOnDismissListener { onVerificationSheetClosed(sheet, lookup.trackingNumber) }

        activeVerificationSheet = sheet
        openDialogs.incrementAndGet()
        sheet.show()
    }

    private fun onVerificationSheetClosed(sheet: ReturnVerificationBottomSheet, awb: String) {
        if (activeVerificationSheet === sheet) activeVerificationSheet = null
        openDialogs.decrementAndGet()
        if (savedSheet === sheet) {
            // Saved: the delayed resume in onSaveSuccess brings the camera back.
            savedSheet = null
            return
        }
        // Left without saving: free the AWB so it can be scanned again at once.
        isRequestInFlight.set(false)
        duplicateGuard.forget(awb)
        resumeCamera()
    }

    /**
     * [owner] is the sheet the save was started from. The reply may arrive after that sheet was swiped away and after
     * the scanner opened a newer sheet, so the reply only ever touches [owner], never whichever sheet is showing now.
     */
    private fun commitVerificationSave(
        owner: ReturnVerificationBottomSheet?,
        clientScanKey: String,
        lookup: LookupResult,
        data: VerificationSubmitData
    ) {
        val app = application as ReturnScanApp
        val shipmentId = data.shipmentId.toIntOrNull() ?: 0
        lifecycleScope.launch {
            val result = app.apiClient.completeScan(
                shipmentId = shipmentId,
                clientScanKey = clientScanKey,
                scannedTracking = data.scannedTracking,
                items = data.items
            )

            val receipt = result.getOrNull()
            if (receipt != null) {
                setOnline(true)
                onSaveSuccess(owner, lookup, receipt, data)
            } else {
                val err = result.exceptionOrNull()
                if (err is AuthExpiredException) {
                    goToLogin()
                    return@launch
                }
                if (err is NetworkException) setOnline(false)
                val message = err?.message ?: "Failed to save return scan"
                signal(Cue.STOP)
                // The same clientScanKey is reused by the next Save tap, so a retry can never save the return twice.
                if (owner != null && owner === activeVerificationSheet) {
                    owner.showSaveError(message)
                } else {
                    showBannerError(lookup.trackingNumber, message)
                }
            }
        }
    }

    private fun onSaveSuccess(
        owner: ReturnVerificationBottomSheet?,
        lookup: LookupResult,
        receipt: ScanReceipt,
        data: VerificationSubmitData
    ) {
        // Successful PostgreSQL commit confirmed: OK signal!
        signal(Cue.OK)

        // Close the sheet this save came from, if it is still the one showing. A newer sheet is never touched.
        if (owner != null && owner === activeVerificationSheet) {
            savedSheet = owner
            owner.dismiss()
        }

        // The server counts the shift. A replayed save (a retry of one that already went through) is not a new scan.
        scannedCountToday = when {
            receipt.scannedToday >= 0 -> receipt.scannedToday
            receipt.replayed -> scannedCountToday
            else -> scannedCountToday + 1
        }
        updateCountsUi()

        // Record recent scan
        val issueLabels = data.items.filter { it.hasIssue }.map { it.category.label }.distinct()
        val outcome = if (issueLabels.isEmpty()) "CLEAR" else issueLabels.joinToString(", ")
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
            // A newer return may have been opened in the meantime; its sheet keeps the scanner busy until it closes.
            if (activeVerificationSheet == null) isRequestInFlight.set(false)
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

    /**
     * The last-scan card. The verdict colour is the header bar and the status text is white on it, so it reads at arm's
     * length. (The status text used to take the verdict colour itself, which is invisible on a bar of that colour.)
     */
    private fun showBanner(status: String, @ColorRes colorRes: Int, awb: String, line1: String, line2: String) {
        binding.cardScanBanner.visibility = View.VISIBLE
        binding.bannerLastVerdict.setBackgroundColor(ContextCompat.getColor(this, colorRes))
        binding.tvBannerStatus.text = status
        binding.tvLastVerdictTime.setText(R.string.banner_just_now)
        binding.tvBannerAwb.text = awb
        binding.tvBannerOrder.text = line1
        binding.tvBannerDetails.text = line2
    }

    private fun showBannerSuccess(awb: String, orderId: String, outcome: String) {
        val orderLine = if (orderId.isNotBlank()) "Order: $orderId" else "Return scan saved"
        showBanner("SAVED: $outcome", R.color.verdict_ok, awb, orderLine, "Return scan committed to database")
    }

    private fun showBannerDuplicate(awb: String, lookup: LookupResult) {
        val dup = lookup.duplicateDetails
        if (dup != null && (dup.scannedBy.isNotBlank() || dup.scannedAt.isNotBlank())) {
            showBanner(
                "DUPLICATE SCAN", R.color.verdict_duplicate, awb,
                "Previously scanned by ${dup.scannedBy.ifBlank { "another scanner" }}",
                "At ${dup.scannedAt.ifBlank { "an earlier time" }} · AWB already in register"
            )
        } else {
            showBanner("DUPLICATE SCAN", R.color.verdict_duplicate, awb, "AWB already scanned", "Set packet aside")
        }
    }

    private fun showBannerNotFound(awb: String) {
        showBanner(
            "NOT FOUND", R.color.verdict_unverified, awb,
            "Not in active return lookup for $accountName",
            "Verify marketplace report upload"
        )
    }

    private fun showBannerError(awb: String, message: String) {
        showBanner("ERROR", R.color.verdict_stop, awb, message, "Check connection or retry")
    }

    // ---- Dialogs & Controls ------------------------------------------------------------------------

    private fun toggleTorch() {
        val cam = camera
        if (cam == null) {
            Toast.makeText(this, R.string.torch_needs_camera, Toast.LENGTH_SHORT).show()
            return
        }
        if (!cam.cameraInfo.hasFlashUnit()) {
            Toast.makeText(this, R.string.torch_unavailable, Toast.LENGTH_SHORT).show()
            return
        }
        isTorchOn = !isTorchOn
        cam.cameraControl.enableTorch(isTorchOn)
        updateTorchUi()
    }

    private fun updateTorchUi() {
        binding.tvTorchLabel.setText(if (isTorchOn) R.string.torch_on else R.string.torch_off)
        binding.btnTorch.alpha = if (isTorchOn) 1.0f else 0.6f
    }

    private fun showManualEntryDialog() {
        openDialogs.incrementAndGet()
        var submitted: String? = null
        val dialog = ManualScanDialog(this) { manualAwb -> submitted = manualAwb }
        // One place counts the dialog out, however it closes. The AWB (if any) is looked up after that.
        dialog.setOnDismissListener {
            openDialogs.decrementAndGet()
            val awb = submitted
            if (awb != null) executeLookup(awb) else resumeCamera()
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
                    pauseCamera(showOverlay = true)
                }
            }
        }
    }

    private fun pauseCamera(showOverlay: Boolean) {
        if (!cameraRunning) return
        cameraRunning = false
        cameraProvider?.unbindAll()
        camera = null
        if (showOverlay) showIdleOverlay()
        updateKeepScreenOn()
    }

    private fun resumeCamera() {
        noteActivity()
        if (!CameraPermission.isGranted(this)) {
            showCameraNeeded()
            return
        }
        binding.layoutCameraPaused.visibility = View.GONE
        if (cameraRunning || cameraStarting) return
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
        sessionManager.clearSession()
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
