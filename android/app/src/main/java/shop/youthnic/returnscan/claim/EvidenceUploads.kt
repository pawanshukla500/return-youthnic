package shop.youthnic.returnscan.claim

import java.io.File
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

    /** One upload job as the screen sees it. [error] is the server's reason when the job failed. */
    data class Upload(
        val finished: Boolean,
        val succeeded: Boolean,
        val claimId: Int = 0,
        val fieldKey: String = "",
        val error: String = ""
    )

    /** [failures] holds one line per refused upload: claim, evidence slot and reason. */
    data class Summary(val uploaded: Int, val waiting: Int, val failures: List<String>) {
        val total: Int get() = uploaded + waiting + failures.size
    }

    fun summarize(uploads: List<Upload>): Summary = Summary(
        uploaded = uploads.count { it.finished && it.succeeded },
        waiting = uploads.count { !it.finished },
        failures = uploads.filter { it.finished && !it.succeeded }.map { failureLine(it) }
    )

    private fun failureLine(upload: Upload): String {
        val claim = if (upload.claimId > 0) "Claim #${upload.claimId} " else ""
        val slot = upload.fieldKey.ifBlank { "evidence" }
        return "$claim$slot: ${upload.error.ifBlank { "not uploaded" }}"
    }

    /** True once every one of the [expected] jobs has finished (the job list can arrive before all are saved). */
    fun isDone(summary: Summary, expected: Int): Boolean = summary.waiting == 0 && summary.total >= expected

    fun percent(summary: Summary, expected: Int): Int =
        if (expected <= 0) 100 else (summary.uploaded * 100 / expected).coerceIn(0, 100)

    fun progressText(summary: Summary, expected: Int): String = buildString {
        append("Uploaded ${summary.uploaded} of $expected evidence file(s).")
        val waiting = expected - summary.uploaded - summary.failures.size
        if (waiting > 0) append("\n$waiting still uploading. They carry on if this screen or the app is closed.")
        appendFailures(summary)
    }

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
