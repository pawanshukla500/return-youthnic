package shop.youthnic.returnscan.ui

import android.graphics.Matrix
import android.graphics.PointF
import android.os.Bundle
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.databinding.ActivityImageViewerBinding

class ImageViewerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityImageViewerBinding

    private val matrix = Matrix()
    private val savedMatrix = Matrix()
    private val start = PointF()
    private val mid = PointF()
    private var mode = NONE
    private var oldDist = 1f

    private lateinit var scaleDetector: ScaleGestureDetector

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityImageViewerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val imageUrl = intent.getStringExtra(EXTRA_IMAGE_URL).orEmpty()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()

        binding.tvImageTitle.text = title.ifBlank { "Product Image" }
        binding.btnCloseViewer.setOnClickListener { finish() }

        scaleDetector = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val scaleFactor = detector.scaleFactor
                matrix.postScale(scaleFactor, scaleFactor, detector.focusX, detector.focusY)
                binding.ivZoomableImage.imageMatrix = matrix
                return true
            }
        })

        setupTouchListener()

        if (imageUrl.isBlank()) {
            binding.progressImageLoading.visibility = View.GONE
            binding.tvImageError.visibility = View.VISIBLE
        } else {
            loadImage(imageUrl)
        }
    }

    private fun loadImage(url: String) {
        binding.progressImageLoading.visibility = View.VISIBLE
        binding.tvImageError.visibility = View.GONE

        val imageCache = (application as ReturnScanApp).imageCache
        lifecycleScope.launch {
            val bitmap = imageCache.getOrFetch(url)
            binding.progressImageLoading.visibility = View.GONE
            if (bitmap != null) {
                binding.ivZoomableImage.setImageBitmap(bitmap)
                fitCenter(bitmap.width, bitmap.height)
            } else {
                binding.tvImageError.visibility = View.VISIBLE
            }
        }
    }

    private fun fitCenter(bmpW: Int, bmpH: Int) {
        binding.ivZoomableImage.post {
            val viewW = binding.ivZoomableImage.width.toFloat()
            val viewH = binding.ivZoomableImage.height.toFloat()
            if (viewW <= 0 || viewH <= 0 || bmpW <= 0 || bmpH <= 0) return@post

            val scale = minOf(viewW / bmpW, viewH / bmpH)
            val dx = (viewW - bmpW * scale) / 2f
            val dy = (viewH - bmpH * scale) / 2f

            matrix.reset()
            matrix.postScale(scale, scale)
            matrix.postTranslate(dx, dy)
            binding.ivZoomableImage.imageMatrix = matrix
        }
    }

    private fun setupTouchListener() {
        binding.ivZoomableImage.setOnTouchListener { _, event ->
            scaleDetector.onTouchEvent(event)

            when (event.action and MotionEvent.ACTION_MASK) {
                MotionEvent.ACTION_DOWN -> {
                    savedMatrix.set(matrix)
                    start.set(event.x, event.y)
                    mode = DRAG
                }
                MotionEvent.ACTION_POINTER_DOWN -> {
                    oldDist = spacing(event)
                    if (oldDist > 10f) {
                        savedMatrix.set(matrix)
                        midPoint(mid, event)
                        mode = ZOOM
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                    mode = NONE
                }
                MotionEvent.ACTION_MOVE -> {
                    if (mode == DRAG && !scaleDetector.isInProgress) {
                        matrix.set(savedMatrix)
                        matrix.postTranslate(event.x - start.x, event.y - start.y)
                        binding.ivZoomableImage.imageMatrix = matrix
                    }
                }
            }
            true
        }
    }

    private fun spacing(event: MotionEvent): Float {
        val x = event.getX(0) - event.getX(1)
        val y = event.getY(0) - event.getY(1)
        return kotlin.math.sqrt((x * x + y * y).toDouble()).toFloat()
    }

    private fun midPoint(point: PointF, event: MotionEvent) {
        val x = event.getX(0) + event.getX(1)
        val y = event.getY(0) + event.getY(1)
        point.set(x / 2, y / 2)
    }

    companion object {
        const val EXTRA_IMAGE_URL = "extra_image_url"
        const val EXTRA_TITLE = "extra_title"

        private const val NONE = 0
        private const val DRAG = 1
        private const val ZOOM = 2
    }
}
