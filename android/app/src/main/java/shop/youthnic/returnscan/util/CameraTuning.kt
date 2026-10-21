package shop.youthnic.returnscan.util

import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy

/**
 * Camera and performance tuning parameters for continuous warehouse barcode scanning.
 */
object CameraTuning {

    /** Default resolution: 720p 16:9 for fast barcode decoding without excessive CPU/battery drain. */
    val HD = 1280 to 720

    /** Full HD 1080p for dense or distant barcodes. */
    val FULL_HD = 1920 to 1080

    val PREVIEW = HD

    /**
     * Resolution used for the ML Kit barcode analysis stream. 1D barcodes (CODE_128, Code 39,
     * EAN-13, ITF) carry information along the horizontal axis and need more pixels than a QR
     * code to decode reliably, especially when printed small on a courier flyer. 1080p gives
     * ML Kit enough horizontal resolution to read these without making the preview heavier.
     */
    val ANALYSIS = FULL_HD

    /** ML Kit analysis interval in ms (~10 fps cap). */
    const val ANALYZE_EVERY_MS = 100L

    /** Inactivity timeout before camera pauses to save battery. */
    const val IDLE_PAUSE_MS = 2 * 60_000L
    const val IDLE_PAUSE_MINUTES = 2

    const val MAX_FPS = 24
    const val MIN_UPPER_FPS = 15
    const val MIN_LOWER_FPS = 10

    fun analysisSize(sharp: Boolean): Pair<Int, Int> = if (sharp) FULL_HD else HD

    /**
     * Builds a [ResolutionSelector] that prefers [width]x[height] and falls back to the closest
     * available size (higher first, then lower). Used for both preview and the analysis stream.
     */
    fun resolutionSelector(width: Int, height: Int): ResolutionSelector {
        val target = android.util.Size(width, height)
        return ResolutionSelector.Builder()
            .setResolutionStrategy(ResolutionStrategy(target, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
            .build()
    }

    fun pickFpsRange(ranges: List<Pair<Int, Int>>): Pair<Int, Int>? =
        ranges
            .filter { (lower, upper) -> upper in MIN_UPPER_FPS..MAX_FPS && lower >= MIN_LOWER_FPS && lower <= upper }
            .sortedWith(compareByDescending<Pair<Int, Int>> { it.second }.thenBy { it.first })
            .firstOrNull()

    fun describe(width: Int, height: Int, fps: Pair<Int, Int>?): String {
        val long = maxOf(width, height)
        val short = minOf(width, height)
        return if (fps != null) "$long×$short · up to ${fps.second} fps" else "$long×$short"
    }
}
