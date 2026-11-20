package shop.youthnic.returnscan.claim

import java.io.File
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Rules for queued evidence uploads and the files they use. Pure Kotlin with no Android classes, so JVM tests cover
 * it; [ClaimEvidenceUploadWorker] runs the uploads and ClaimCaptureActivity shows their progress.
 */
object EvidenceUploads {

    /** Folder under filesDir that holds captured evidence until it is uploaded. */
    const val DIR = "claim-evidence"

    /** File under filesDir that holds the claim screen's [EvidenceDraft]. */
    const val DRAFT_FILE = "claim-evidence-draft.json"

    private const val FILE_TAG_PREFIX = "claim-evidence-file:"

    /** An evidence file that no draft or unfinished upload uses is deleted at start-up once it is this old. */
    val MAX_UNUSED_AGE_MS: Long = TimeUnit.DAYS.toMillis(3)

    fun claimTag(claimId: Int): String = "claim-evidence-claim-$claimId"

    /** Names the file a job uploads, so the start-up clean-up can keep it (WorkInfo does not expose input data). */
    fun fileTag(fileName: String): String = FILE_TAG_PREFIX + fileName

    fun fileNameFromTags(tags: Collection<String>): String? =
        tags.firstOrNull { it.startsWith(FILE_TAG_PREFIX) }?.removePrefix(FILE_TAG_PREFIX)?.takeIf { it.isNotBlank() }

    /** One unique job per claim and file: queueing the same file again never uploads it twice. */
    fun workName(claimId: Int, fileName: String): String = "claim-evidence-$claimId-$fileName"

    /** A 4xx other than 408 (timeout) and 429 (rate limit) would be refused again, so the upload stops and says why. */
    fun isPermanentFailure(httpCode: Int): Boolean = httpCode in 400..499 && httpCode != 408 && httpCode != 429

    /** At most this many evidence files upload at once, so on a slow network the photos do not starve the video. */
    const val PARALLEL_UPLOADS = 2

    /** A file this big (an unpacking video) uploads as foreground work, which Android's ~10-minute limit does not stop. */
    const val FOREGROUND_MIN_BYTES: Long = 2L * 1024 * 1024

    fun needsForeground(fileBytes: Long): Boolean = fileBytes >= FOREGROUND_MIN_BYTES

    /** Byte progress is saved every 1% of a file and never closer than this, so a 25 MB video makes ~100 updates, not thousands. */
    const val MIN_PROGRESS_STEP_BYTES: Long = 128L * 1024

    /** True when [sent] has moved far enough past the [lastReported] count to save, and always for the last byte. */
    fun shouldReportBytes(lastReported: Long, sent: Long, total: Long): Boolean =
        (total > 0 && sent >= total) || sent - lastReported >= maxOf(total / 100, MIN_PROGRESS_STEP_BYTES)

    /** [done] out of [total] as a whole percent from 0 to 100; nothing to do counts as done. */
    fun percentOf(done: Long, total: Long): Int = if (total <= 0) 100 else (done * 100 / total).coerceIn(0L, 100L).toInt()

    /**
     * One upload job as the screen sees it. [error] is the server's reason when the job failed. [bytesSent] is how much
     * of the file has gone: the running count while it uploads, the whole file once it succeeded.
     */
    data class Upload(
        val finished: Boolean,
        val succeeded: Boolean,
        val claimId: Int = 0,
        val fieldKey: String = "",
        val error: String = "",
        val bytesSent: Long = 0
    )

    /** [failures] holds one line per refused upload: claim, evidence slot and reason. [bytesSent] leaves refused files out. */
    data class Summary(val uploaded: Int, val waiting: Int, val failures: List<String>, val bytesSent: Long = 0) {
        val total: Int get() = uploaded + waiting + failures.size
    }

    fun summarize(uploads: List<Upload>): Summary = Summary(
        uploaded = uploads.count { it.finished && it.succeeded },
        waiting = uploads.count { !it.finished },
        failures = uploads.filter { it.finished && !it.succeeded }.map { failureLine(it) },
        bytesSent = uploads.filter { !it.finished || it.succeeded }.sumOf { it.bytesSent }
    )

    private fun failureLine(upload: Upload): String {
        val claim = if (upload.claimId > 0) "Claim #${upload.claimId} " else ""
        val slot = upload.fieldKey.ifBlank { "evidence" }
        return "$claim$slot: ${upload.error.ifBlank { "not uploaded" }}"
    }

    /** True once every one of the [expected] jobs has finished (the job list can arrive before all are saved). */
    fun isDone(summary: Summary, expected: Int): Boolean = summary.waiting == 0 && summary.total >= expected

    /** Progress by bytes when the files' total size [expectedBytes] is known, otherwise by finished files. */
    fun percent(summary: Summary, expected: Int, expectedBytes: Long = 0): Int =
        if (expectedBytes > 0) percentOf(summary.bytesSent, expectedBytes) else percentOf(summary.uploaded.toLong(), expected.toLong())

    fun progressText(summary: Summary, expected: Int, expectedBytes: Long = 0): String = buildString {
        append("Uploaded ${summary.uploaded} of $expected evidence file(s).")
        if (expectedBytes > 0) append("\nSent ${megabytes(minOf(summary.bytesSent, expectedBytes))} of ${megabytes(expectedBytes)}.")
        val waiting = expected - summary.uploaded - summary.failures.size
        if (waiting > 0) append("\n$waiting still uploading. They carry on if this screen or the app is closed.")
        appendFailures(summary)
    }

    /** "12.3 MB", with a dot whatever the phone's language, in the same 1024-based MB as the evidence cards. */
    fun megabytes(bytes: Long): String = String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))

    fun resultMessage(claimId: Int, summary: Summary): String = buildString {
        append("Meesho claim #$claimId created. ")
        if (summary.waiting == 0 && summary.failures.isEmpty()) {
            append("All ${summary.uploaded} evidence files uploaded.")
        } else {
            append("${summary.uploaded} of ${summary.total} evidence files uploaded.")
        }
        if (summary.waiting > 0) {
            append(" ${summary.waiting} still uploading in the background; they finish on their own once the phone is online and signed in.")
        }
        appendFailures(summary)
        if (summary.failures.isNotEmpty()) append("\nThe claim waits for evidence until these are added.")
    }

    /** What the claim screen shows about uploads still queued or refused, or null when there are none. */
    fun pendingNotice(summary: Summary): String? {
        if (summary.waiting == 0 && summary.failures.isEmpty()) return null
        return buildString {
            append("Evidence uploads: ")
            append(if (summary.waiting > 0) "${summary.waiting} still uploading in the background." else "none waiting.")
            appendFailures(summary)
        }
    }

    private fun StringBuilder.appendFailures(summary: Summary) {
        if (summary.failures.isEmpty()) return
        append("\n${summary.failures.size} refused by the server:")
        for (line in summary.failures.take(3)) append("\n• $line")
        if (summary.failures.size > 3) append("\n• and ${summary.failures.size - 3} more")
    }

    /**
     * Deletes files in [dir] older than [maxAgeMs] whose names are not in [keepNames] (the open draft's files and
     * those of unfinished uploads): leftovers of a failed upload, a recording that never finished, an abandoned
     * capture. Returns how many were deleted.
     */
    fun purgeUnused(dir: File, keepNames: Set<String>, nowMs: Long, maxAgeMs: Long = MAX_UNUSED_AGE_MS): Int {
        val files = dir.listFiles() ?: return 0
        var deleted = 0
        for (file in files) {
            if (!file.isFile || file.name in keepNames) continue
            if (nowMs - file.lastModified() < maxAgeMs) continue
            if (file.delete()) deleted++
        }
        return deleted
    }
}
