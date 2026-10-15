package shop.youthnic.returnscan.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.content.ContextCompat
import com.google.android.material.snackbar.Snackbar
import shop.youthnic.returnscan.databinding.ActivityClaimVideoBinding
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

class ClaimVideoCaptureActivity : AppCompatActivity() {

    private lateinit var binding: ActivityClaimVideoBinding
    private var recording: Recording? = null
    private var outputFile: File? = null
    private val handler = Handler(Looper.getMainLooper())
    private var startedAt = 0L

    private val monitor = object : Runnable {
        override fun run() {
            val file = outputFile ?: return
            val elapsed = System.currentTimeMillis() - startedAt
            val sizeMb = file.length().toDouble() / (1024.0 * 1024.0)
            binding.tvVideoStatus.text = "Recording 480p SD MP4 · ${TimeUnit.MILLISECONDS.toSeconds(elapsed)}s"
            binding.tvVideoSize.text = String.format("%.1f / 25 MB", sizeMb)
            if (file.length() >= STOP_AT_BYTES || elapsed >= MAX_DURATION_MS) {
                recording?.stop()
            } else {
                handler.postDelayed(this, 250)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityClaimVideoBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.btnStopVideo.setOnClickListener { recording?.stop() }
        startCamera()
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(binding.previewVideo.surfaceProvider)
            }
            val recorder = Recorder.Builder()
                .setQualitySelector(
                    QualitySelector.fromOrderedList(
                        listOf(Quality.SD, Quality.LOWEST),
                        FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)
                    )
                )
                .build()
            val capture = VideoCapture.withOutput(recorder)
            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture)
            startRecording(capture)
        }, ContextCompat.getMainExecutor(this))
    }

    private fun startRecording(capture: VideoCapture<Recorder>) {
        val dir = File(filesDir, "claim-evidence").apply { mkdirs() }
        val file = File(dir, "meesho-unpacking-${UUID.randomUUID()}.mp4")
        outputFile = file
        recording = capture.output
            .prepareRecording(this, FileOutputOptions.Builder(file).build())
            .start(ContextCompat.getMainExecutor(this)) { event ->
                when (event) {
                    is VideoRecordEvent.Start -> {
                        startedAt = System.currentTimeMillis()
                        binding.btnStopVideo.isEnabled = true
                        handler.post(monitor)
                    }
                    is VideoRecordEvent.Finalize -> finishRecording(event)
                }
            }
    }

    private fun finishRecording(event: VideoRecordEvent.Finalize) {
        handler.removeCallbacks(monitor)
        binding.btnStopVideo.isEnabled = false
        val file = outputFile
        recording = null
        if (file == null || event.hasError() || !file.exists() || file.length() == 0L || file.length() > MAX_BYTES) {
            file?.delete()
            Snackbar.make(binding.root, "Video could not be saved under 25 MB. Please record again.", Snackbar.LENGTH_LONG).show()
            binding.root.postDelayed({ startCamera() }, 1800)
            return
        }
        setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_FILE_PATH, file.absolutePath))
        finish()
    }

    override fun onDestroy() {
        handler.removeCallbacks(monitor)
        recording?.close()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_FILE_PATH = "claim_video_file_path"
        const val MAX_BYTES = 25L * 1024L * 1024L
        private const val STOP_AT_BYTES = 24L * 1024L * 1024L
        private const val MAX_DURATION_MS = 150_000L
    }
}
