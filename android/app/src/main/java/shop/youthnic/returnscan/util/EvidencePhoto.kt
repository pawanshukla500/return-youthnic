package shop.youthnic.returnscan.util

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import shop.youthnic.returnscan.data.ImageCache
import java.io.File

/** Shrinks a camera photo in place following [EvidencePhotoSizing]. Blocking: call it off the main thread. */
object EvidencePhoto {

    /**
     * Rewrites [file] as an upright JPEG at most [EvidencePhotoSizing.MAX_LONG_EDGE] px on the long edge, quality
     * [EvidencePhotoSizing.JPEG_QUALITY]. The EXIF turn is applied to the pixels, so the photo looks the same in
     * every viewer. Returns true when the file was rewritten. On any failure, out of memory included, the
     * original photo is kept untouched: a large photo is better than lost evidence.
     */
    fun downscaleInPlace(file: File): Boolean {
        val tmp = File(file.parentFile, file.name + ".tmp")
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
            val matrix = Matrix().apply {
                postScale(plan.targetWidth.toFloat() / src.width, plan.targetHeight.toFloat() / src.height)
                postRotate(plan.rotationDegrees.toFloat())
                if (plan.mirror) postScale(-1f, 1f)
            }
            val out = Bitmap.createBitmap(src, 0, 0, src.width, src.height, matrix, true)
            output = out
            val written = tmp.outputStream().use { stream ->
                out.compress(Bitmap.CompressFormat.JPEG, EvidencePhotoSizing.JPEG_QUALITY, stream)
            }
            written && tmp.length() > 0 && tmp.renameTo(file)
        } catch (_: Exception) {
            false
        } catch (_: OutOfMemoryError) {
            false
        } finally {
            if (output !== decoded) output?.recycle()
            decoded?.recycle()
            if (tmp.exists()) tmp.delete()
        }
    }
}
