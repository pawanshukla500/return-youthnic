package shop.youthnic.returnscan.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors

class ImageCache(context: Context, private val okHttpClient: OkHttpClient) {

    private val cacheDir = File(context.cacheDir, "catalog_images").apply { mkdirs() }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor = Executors.newFixedThreadPool(3)

    // In-memory cache capped at 1/8th of available runtime memory
    private val maxMemory = (Runtime.getRuntime().maxMemory() / 1024).toInt()
    private val memCacheSize = maxMemory / 8

    private val memoryCache = object : LruCache<String, Bitmap>(memCacheSize) {
        override fun sizeOf(key: String, bitmap: Bitmap): Int {
            return bitmap.byteCount / 1024
        }
    }

    fun load(url: String?, target: ImageView, placeholderResId: Int? = null) {
        if (url.isNullOrBlank()) {
            target.setImageDrawable(null)
            return
        }

        // Check memory cache first
        val cached = memoryCache.get(url)
        if (cached != null) {
            target.setImageBitmap(cached)
            return
        }

        // Tag view to avoid race conditions with recycled views
        target.tag = url

        executor.execute {
            val bitmap = getFromDiskOrDownload(url)
            if (bitmap != null) {
                memoryCache.put(url, bitmap)
                mainHandler.post {
                    if (target.tag == url) {
                        target.setImageBitmap(bitmap)
                    }
                }
            } else {
                mainHandler.post {
                    if (target.tag == url) {
                        target.setImageDrawable(null)
                    }
                }
            }
        }
    }

    fun getFullBitmapAsync(url: String?, callback: (Bitmap?) -> Unit) {
        if (url.isNullOrBlank()) {
            callback(null)
            return
        }

        executor.execute {
            val bitmap = getFromDiskOrDownload(url, maxDim = 1600)
            mainHandler.post { callback(bitmap) }
        }
    }

    private fun getFromDiskOrDownload(url: String, maxDim: Int = 400): Bitmap? {
        val fileKey = md5(url)
        val file = File(cacheDir, fileKey)

        if (file.exists() && file.length() > 0) {
            val bmp = decodeSampledBitmap(file.absolutePath, maxDim, maxDim)
            if (bmp != null) return bmp
        }

        return try {
            val request = Request.Builder().url(url).build()
            val response = okHttpClient.newCall(request).execute()
            if (!response.isSuccessful) return null

            val bytes = response.body?.bytes() ?: return null
            FileOutputStream(file).use { it.write(bytes) }

            decodeSampledBitmap(file.absolutePath, maxDim, maxDim)
        } catch (_: Exception) {
            null
        }
    }

    private fun decodeSampledBitmap(path: String, reqWidth: Int, reqHeight: Int): Bitmap? {
        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeFile(path, options)

        options.inSampleSize = calculateInSampleSize(options, reqWidth, reqHeight)
        options.inJustDecodeBounds = false
        options.inPreferredConfig = Bitmap.Config.RGB_565 // Low memory footprint

        return BitmapFactory.decodeFile(path, options)
    }

    private fun calculateInSampleSize(options: BitmapFactory.Options, reqWidth: Int, reqHeight: Int): Int {
        val (height: Int, width: Int) = options.run { outHeight to outWidth }
        var inSampleSize = 1

        if (height > reqHeight || width > reqWidth) {
            val halfHeight: Int = height / 2
            val halfWidth: Int = width / 2

            while (halfHeight / inSampleSize >= reqHeight && halfWidth / inSampleSize >= reqWidth) {
                inSampleSize *= 2
            }
        }
        return inSampleSize
    }

    private fun md5(input: String): String {
        val md = MessageDigest.getInstance("MD5")
        return md.digest(input.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
