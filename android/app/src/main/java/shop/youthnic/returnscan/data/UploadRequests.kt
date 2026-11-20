package shop.youthnic.returnscan.data

import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer
import java.util.concurrent.TimeUnit

/** HTTP settings for evidence uploads. Pure OkHttp with no Android classes, so JVM tests cover it. */
object UploadRequests {

    /**
     * Other calls give up after 20 s without a reply. The server replies to an upload only once it has stored the
     * whole file, which can take minutes for a video, and a timeout there would send the whole file again.
     */
    const val READ_TIMEOUT_MINUTES = 3L

    /** [base] with the upload read timeout. It shares [base]'s connection pool, dispatcher and cookie jar. */
    fun client(base: OkHttpClient): OkHttpClient =
        base.newBuilder().readTimeout(READ_TIMEOUT_MINUTES, TimeUnit.MINUTES).build()
}

/**
 * [delegate] that reports how many of its bytes have been written to the connection, so an upload can show progress
 * by bytes. A new attempt at the same request counts from zero again.
 */
class ProgressRequestBody(
    private val delegate: RequestBody,
    private val onBytes: (sent: Long, total: Long) -> Unit
) : RequestBody() {

    override fun contentType(): MediaType? = delegate.contentType()

    override fun contentLength(): Long = delegate.contentLength()

    override fun isOneShot(): Boolean = delegate.isOneShot()

    override fun writeTo(sink: BufferedSink) {
        val total = contentLength()
        var sent = 0L
        val counting = object : ForwardingSink(sink) {
            override fun write(source: Buffer, byteCount: Long) {
                super.write(source, byteCount)
                sent += byteCount
                onBytes(sent, total)
            }
        }.buffer()
        delegate.writeTo(counting)
        // Flush, never close: closing would close the multipart body's sink under the parts that follow.
        counting.flush()
    }
}
