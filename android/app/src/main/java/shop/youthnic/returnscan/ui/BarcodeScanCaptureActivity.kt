package shop.youthnic.returnscan.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.BarcodeRules
import shop.youthnic.returnscan.databinding.ActivityBarcodeScanCaptureBinding
import shop.youthnic.returnscan.util.CameraTuning
import shop.youthnic.returnscan.util.Cue
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class BarcodeScanCaptureActivity : AppCompatActivity() {

    private lateinit var binding: ActivityBarcodeScanCaptureBinding
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var isTorchOn = false
    private val cameraExecutor: ExecutorService by lazy { Executors.newSingleThreadExecutor() }
    private var barcodeScanner: BarcodeScanner? = null
    private val scanned = AtomicBoolean(false)
    private var lastAnalyzedAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityBarcodeScanCaptureBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val title = intent.getStringExtra(EXTRA_TITLE)
        if (!title.isNullOrBlank()) {
            binding.tvScanTitle.text = title
        }

        binding.btnScanBack.setOnClickListener { finish() }
        binding.btnScanTorch.setOnClickListener { toggleTorch() }

        initScanner()
        startCamera()
    }

    private fun initScanner() {
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
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            cameraProvider = future.get()
            bindCamera()
        }, ContextCompat.getMainExecutor(this))
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun bindCamera() {
        val provider = cameraProvider ?: return
        provider.unbindAll()

        // Continuous-picture autofocus keeps the lens hunting for a sharp close-up of the
        // barcode. Without it, many warehouse phones lock focus at a fixed distance where the
        // thin bars of a 1D courier barcode blur and ML Kit fails to decode them.
        val previewBuilder = Preview.Builder()
            .setResolutionSelector(CameraTuning.resolutionSelector(CameraTuning.HD.first, CameraTuning.HD.second))
        Camera2Interop.Extender(previewBuilder).setCaptureRequestOption(
            CaptureRequest.CONTROL_AF_MODE,
            CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE
        )
        val preview = previewBuilder.build().also {
            it.setSurfaceProvider(binding.previewScan.surfaceProvider)
        }

        // The analysis stream runs at 1080p: 1D barcodes need more horizontal pixels than a QR
        // code to decode, and the previous default (no ResolutionSelector) often fell back to
        // 640x480, which is why QR codes scanned but CODE_128/Code 39/EAN flyers did not.
        val analysisBuilder = ImageAnalysis.Builder()
            .setResolutionSelector(CameraTuning.resolutionSelector(CameraTuning.ANALYSIS.first, CameraTuning.ANALYSIS.second))
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        Camera2Interop.Extender(analysisBuilder).setCaptureRequestOption(
            CaptureRequest.CONTROL_AF_MODE,
            CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE
        )
        val analysis = analysisBuilder.build()

        analysis.setAnalyzer(cameraExecutor) { imageProxy ->
            processImage(imageProxy)
        }

        try {
            camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        } catch (_: Exception) {
            // Camera bind failed
        }
    }

    @SuppressLint("UnsafeOptInUsageError")
    private fun processImage(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        val scanner = barcodeScanner
        if (mediaImage == null || scanner == null || scanned.get()) {
            imageProxy.close()
            return
        }

        val now = SystemClock.elapsedRealtime()
        if (now - lastAnalyzedAt < 120L) {
            imageProxy.close()
            return
        }
        lastAnalyzedAt = now

        val rotation = imageProxy.imageInfo.rotationDegrees
        val image = InputImage.fromMediaImage(mediaImage, rotation)

        scanner.process(image)
            .addOnSuccessListener { barcodes ->
                if (scanned.get()) return@addOnSuccessListener
                for (barcode in barcodes) {
                    val rawValue = BarcodeRules.normalize(barcode.rawValue)
                    val extracted = BarcodeRules.extractScannedIdentifier(rawValue)
                    if (extracted.isNotBlank()) {
                        if (scanned.compareAndSet(false, true)) {
                            onBarcodeDetected(extracted)
                            break
                        }
                    }
                }
            }
            .addOnCompleteListener {
                imageProxy.close()
            }
    }

    private fun onBarcodeDetected(code: String) {
        runOnUiThread {
            try {
                (application as ReturnScanApp).soundManager.play(Cue.OK)
            } catch (_: Exception) {}
            val resultIntent = Intent().apply {
                putExtra(EXTRA_SCANNED_CODE, code)
            }
            setResult(Activity.RESULT_OK, resultIntent)
            finish()
        }
    }

    private fun toggleTorch() {
        val cam = camera ?: return
        if (cam.cameraInfo.hasFlashUnit()) {
            isTorchOn = !isTorchOn
            cam.cameraControl.enableTorch(isTorchOn)
            binding.btnScanTorch.alpha = if (isTorchOn) 1.0f else 0.7f
        }
    }

    override fun onDestroy() {
        cameraExecutor.shutdown()
        barcodeScanner?.close()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_TITLE = "extra_scan_title"
        const val EXTRA_SCANNED_CODE = "scanned_code"
    }
}
