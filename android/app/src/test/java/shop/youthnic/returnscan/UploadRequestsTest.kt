package shop.youthnic.returnscan

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.asRequestBody
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import shop.youthnic.returnscan.data.ProgressRequestBody
import shop.youthnic.returnscan.data.UploadRequests
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Evidence uploads report progress by bytes and wait longer for the server's reply than other calls do, so a 25 MB
 * video on a slow network neither looks stuck nor times out and starts again. Test data is synthetic: every file
 * name and file starts with SYN-.
 */
class UploadRequestsTest {

    private val appDir: File = listOf(File("."), File("app"), File("android/app"))
        .first { File(it, "src/main/res/values/strings.xml").isFile }

    @get:Rule
    val folder = TemporaryFolder()

    private fun synFile(name: String, size: Int): File = folder.newFile(name).apply {
        val bytes = ByteArray(size) { (it % 251).toByte() }
        "SYN-".toByteArray().copyInto(bytes)
        writeBytes(bytes)
    }

    @Test
    fun uploadsWaitLongerForTheReplyThanOtherCallsAndShareTheirConnections() {
        // The same settings as ApiClient's client for every other call.
        val base = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(2, TimeUnit.MINUTES)
            .build()
        val upload = UploadRequests.client(base)

        assertEquals(TimeUnit.MINUTES.toMillis(3).toInt(), upload.readTimeoutMillis)
        assertEquals("other calls keep their 20 s limit", 20_000, base.readTimeoutMillis)
        assertEquals(base.connectTimeoutMillis, upload.connectTimeoutMillis)
        assertEquals(base.writeTimeoutMillis, upload.writeTimeoutMillis)
        assertEquals("no limit on the whole call, so a slow upload that keeps moving is never cut off", 0, upload.callTimeoutMillis)
        assertSame(base.connectionPool, upload.connectionPool)
        assertSame(base.cookieJar, upload.cookieJar)
    }

    @Test
    fun onlyTheEvidenceUploadUsesTheLongerTimeout() {
        // ApiClient needs SessionManager (an Android class), so read its source.
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/data/ApiClient.kt").readText()
        val upload = source.substringAfter("suspend fun uploadClaimEvidence(").substringBefore("suspend fun logout(")
        assertTrue(upload.contains("execute(request, uploadHttpClient)"))
        assertTrue(upload.contains("ProgressRequestBody(file.asRequestBody("))
        val elsewhere = source.replace(upload, "")
        assertEquals(
            "declared once and used only by the upload",
            1,
            Regex("""\buploadHttpClient\b""").findAll(elsewhere).count()
        )
    }

    @Test
    fun progressCountsEveryByteOfTheFileAndSendsItUnchanged() {
        val file = synFile("SYN-unpacking.mp4", 300_000)
        val calls = mutableListOf<Pair<Long, Long>>()
        val body = ProgressRequestBody(file.asRequestBody("video/mp4".toMediaType())) { sent, total -> calls.add(sent to total) }

        assertEquals(300_000L, body.contentLength())
        assertEquals("video/mp4", body.contentType().toString())

        val sink = Buffer()
        body.writeTo(sink)

        assertArrayEquals(file.readBytes(), sink.readByteArray())
        assertTrue("progress moves while the file is sent, not once at the end: ${calls.size}", calls.size > 10)
        assertTrue(calls.all { it.second == 300_000L })
        assertTrue(calls.zipWithNext().all { (a, b) -> b.first > a.first })
        assertEquals(300_000L, calls.last().first)
    }

    @Test
    fun insideTheMultipartUploadOnlyTheFileIsCounted() {
        val file = synFile("SYN-waybill.jpg", 50_000)
        var lastSent = 0L
        var lastTotal = 0L
        val multipart = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("fieldKey", "SYN-reverse_waybill")
            .addFormDataPart("file", file.name, ProgressRequestBody(file.asRequestBody("image/jpeg".toMediaType())) { sent, total ->
                lastSent = sent
                lastTotal = total
            })
            .build()

        val sink = Buffer()
        multipart.writeTo(sink)

        assertEquals(50_000L, lastSent)
        assertEquals(50_000L, lastTotal)
        assertEquals("the parts after the file are still written", multipart.contentLength(), sink.size)
        assertTrue(sink.readUtf8().trimEnd().endsWith("--"))
    }

    @Test
    fun aListenerThatThrowsStopsTheUploadAtOnce() {
        // A stopped upload job throws from its listener so the blocking call ends instead of sending the rest.
        val file = synFile("SYN-unpacking-stopped.mp4", 1_000_000)
        var calls = 0
        val body = ProgressRequestBody(file.asRequestBody("video/mp4".toMediaType())) { _, _ ->
            calls++
            throw IOException("Upload stopped")
        }

        val sink = Buffer()
        val error = assertThrows(IOException::class.java) { body.writeTo(sink) }

        assertEquals("Upload stopped", error.message)
        assertEquals(1, calls)
        assertTrue("only the first chunk went out: ${sink.size}", sink.size in 1L until 1_000_000L)
    }

    @Test
    fun aSecondAttemptCountsFromZeroAgain() {
        val file = synFile("SYN-photo.jpg", 40_000)
        val calls = mutableListOf<Long>()
        val body = ProgressRequestBody(file.asRequestBody("image/jpeg".toMediaType())) { sent, _ -> calls.add(sent) }

        body.writeTo(Buffer())
        val firstAttempt = calls.size
        body.writeTo(Buffer())

        assertEquals(40_000L, calls[firstAttempt - 1])
        assertTrue("the retry starts again below the whole file", calls[firstAttempt] < 40_000L)
        assertEquals(40_000L, calls.last())
    }
}
