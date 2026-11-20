package shop.youthnic.returnscan.util

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import shop.youthnic.returnscan.data.ImageCache
import java.io.File
import java.io.OutputStream

/** Shrinks a camera photo in place following [EvidencePhotoSizing]. Blocking: call it off the main thread. */
object EvidencePhoto {

    /**
     * Rewrites [file] as an upright JPEG at most [EvidencePhotoSizing.MAX_LONG_EDGE] px on the long edge, quality
     * [EvidencePhotoSizing.JPEG_QUALITY]. The EXIF turn is applied to the pixels, so the photo looks the same in
     * every viewer. Returns true when the file was rewritten. On any failure, out of memory included, the
     * original photo is kept untouched: a large photo is better than lost evidence.
     */
    fun downscaleInPlace(file: File): Boolean {
        var decoded: Bitmap? = null
        var output: Bitmap? = null
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            val orientation = ExifInterface(file.absolutePath)
                .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            val plan = EvidencePhotoSizing.plan(bounds.outWidth, bounds.outHeight, orientation)
            if (!plan.rewrite) return false

            // The shared sampled decoder never loads the full 12 MP image; ARGB_8888 keeps the JPEG free of banding.
            val src = ImageCache.decodeSampledBitmap(
                file.absolutePath, plan.targetWidth, plan.targetHeight, Bitmap.Config.ARGB_8888
            ) ?: return false
            decoded = src
            val matrix = Matrix().apply { setValues(plan.matrixValues(src.width, src.height)) }
            val out = Bitmap.createBitmap(src, 0, 0, src.width, src.height, matrix, true)
            output = out
            replaceFileSafely(file) { stream ->
                out.compress(Bitmap.CompressFormat.JPEG, EvidencePhotoSizing.JPEG_QUALITY, stream)
            }
        } catch (_: Exception) {
            false
        } catch (_: OutOfMemoryError) {
            false
        } finally {
            if (output !== decoded) output?.recycle()
            decoded?.recycle()
        }
    }
}

/**
 * Replaces [file] with what [write] produces, through a sibling `.tmp` that is renamed over [file] only when
 * [write] returns true and wrote at least one byte. Otherwise, or when [write] throws, [file] is left untouched
 * and the `.tmp` is removed (an exception still reaches the caller). Plain java.io, so JVM tests cover it.
 */
internal fun replaceFileSafely(file: File, write: (OutputStream) -> Boolean): Boolean {
    val tmp = File(file.parentFile, file.name + ".tmp")
    return try {
        val written = tmp.outputStream().use { stream -> write(stream) }
        written && tmp.length() > 0 && tmp.renameTo(file)
    } finally {
        if (tmp.exists()) tmp.delete()
    }
}
