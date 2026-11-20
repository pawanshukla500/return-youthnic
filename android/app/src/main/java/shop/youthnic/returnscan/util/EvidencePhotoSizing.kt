package shop.youthnic.returnscan.util

import kotlin.math.roundToInt

/**
 * Size and orientation rules for claim evidence photos. Pure Kotlin with no Android classes, so JVM
 * unit tests cover it; [EvidencePhoto] applies a [Plan] to the file the camera wrote.
 */
object EvidencePhotoSizing {

    /** Long edge of a stored camera photo: a label stays readable, and a 12 MP capture is about 6x fewer pixels. */
    const val MAX_LONG_EDGE = 1600

    const val JPEG_QUALITY = 80

    /** Requested size for the 56dp evidence-card thumbnail (224 px at xxxhdpi). */
    const val THUMBNAIL_PX = 256

    /**
     * How one photo is stored. [targetWidth] x [targetHeight] is the scaled size before turning;
     * [finalWidth] x [finalHeight] is the stored size after [rotationDegrees] clockwise and then [mirror].
     */
    data class Plan(
        val targetWidth: Int,
        val targetHeight: Int,
        val rotationDegrees: Int,
        val mirror: Boolean,
        val rewrite: Boolean
    ) {
        val finalWidth: Int get() = if (rotationDegrees % 180 == 0) targetWidth else targetHeight
        val finalHeight: Int get() = if (rotationDegrees % 180 == 0) targetHeight else targetWidth

        /**
         * The 3x3 matrix, in `android.graphics.Matrix.setValues` order, that takes a [srcWidth] x [srcHeight]
         * decode to the stored photo: scale to [targetWidth] x [targetHeight], turn [rotationDegrees] clockwise,
         * then mirror left to right if [mirror], shifted so the result covers (0, 0) to ([finalWidth], [finalHeight]).
         */
        fun matrixValues(srcWidth: Int, srcHeight: Int): FloatArray {
            val sx = targetWidth.toFloat() / srcWidth
            val sy = targetHeight.toFloat() / srcHeight
            // A clockwise turn in y-down image coordinates: (x, y) -> (x cos - y sin, x sin + y cos).
            val (cos, sin) = when (rotationDegrees) {
                90 -> 0f to 1f
                180 -> -1f to 0f
                270 -> 0f to -1f
                else -> 1f to 0f
            }
            val flip = if (mirror) -1f else 1f
            val a = flip * cos * sx
            val b = -flip * sin * sy
            val c = sin * sx
            val d = cos * sy
            val tx = -(minOf(0f, a * srcWidth) + minOf(0f, b * srcHeight))
            val ty = -(minOf(0f, c * srcWidth) + minOf(0f, d * srcHeight))
            return floatArrayOf(a, b, tx, c, d, ty, 0f, 0f, 1f)
        }
    }

    /**
     * Plans the stored photo for a [width] x [height] capture tagged with EXIF [exifOrientation] (values 1-8;
     * anything else counts as upright). Never upscales. A photo already small and upright, or one whose size
     * could not be read, is left as it is ([Plan.rewrite] is false).
     */
    fun plan(width: Int, height: Int, exifOrientation: Int, maxLongEdge: Int = MAX_LONG_EDGE): Plan {
        if (width <= 0 || height <= 0) return Plan(width, height, 0, mirror = false, rewrite = false)
        val longEdge = maxOf(width, height)
        val scale = if (longEdge > maxLongEdge) maxLongEdge.toDouble() / longEdge else 1.0
        val rotation = rotationDegrees(exifOrientation)
        val mirror = isMirrored(exifOrientation)
        return Plan(
            targetWidth = (width * scale).roundToInt().coerceAtLeast(1),
            targetHeight = (height * scale).roundToInt().coerceAtLeast(1),
            rotationDegrees = rotation,
            mirror = mirror,
            rewrite = scale < 1.0 || rotation != 0 || mirror
        )
    }

    /** Clockwise turn for an EXIF orientation, applied before [isMirrored] (Glide's order). */
    fun rotationDegrees(exifOrientation: Int): Int = when (exifOrientation) {
        3, 4 -> 180 // ROTATE_180, FLIP_VERTICAL
        5, 6 -> 90 // TRANSPOSE, ROTATE_90
        7, 8 -> 270 // TRANSVERSE, ROTATE_270
        else -> 0 // NORMAL, FLIP_HORIZONTAL, UNDEFINED
    }

    /** Whether the turned image is then mirrored left to right: FLIP_HORIZONTAL, FLIP_VERTICAL, TRANSPOSE, TRANSVERSE. */
    fun isMirrored(exifOrientation: Int): Boolean = exifOrientation == 2 || exifOrientation == 4 ||
        exifOrientation == 5 || exifOrientation == 7
}
