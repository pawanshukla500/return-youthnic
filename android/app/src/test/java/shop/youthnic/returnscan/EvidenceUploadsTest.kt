package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import shop.youthnic.returnscan.claim.EvidenceUploads
import shop.youthnic.returnscan.claim.EvidenceUploads.Upload
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Queued evidence uploads: one unique job per file, a 4xx shown to the operator instead of dropped, and old evidence
 * files cleaned up at start-up without touching any that a draft or an unfinished upload still needs. Test data is
 * synthetic: every file name and server message starts with SYN-.
 */
class EvidenceUploadsTest {

    private val appDir: File = listOf(File("."), File("app"), File("android/app"))
        .first { File(it, "src/main/res/values/strings.xml").isFile }

    @get:Rule
    val folder = TemporaryFolder()

    private val now = TimeUnit.DAYS.toMillis(30)

    private fun fileAged(dir: File, name: String, ageMs: Long): File =
        File(dir, name).apply { writeText("SYN-evidence"); setLastModified(now - ageMs) }

    @Test
    fun startUpCleanUpRemovesOldUnusedFilesAndKeepsPendingOnes() {
        val dir = folder.newFolder("claim-evidence")
        val oldUnused = fileAged(dir, "SYN-failed-upload.jpg", TimeUnit.DAYS.toMillis(4))
        val oldPartialVideo = fileAged(dir, "SYN-unpacking-partial.mp4", TimeUnit.DAYS.toMillis(10))
        val oldTemp = fileAged(dir, "SYN-photo.jpg.tmp", TimeUnit.DAYS.toMillis(5))
        val oldQueued = fileAged(dir, "SYN-queued-upload.mp4", TimeUnit.DAYS.toMillis(6))
        val oldInDraft = fileAged(dir, "SYN-draft-photo.jpg", TimeUnit.DAYS.toMillis(4))
        val recentUnused = fileAged(dir, "SYN-just-captured.jpg", TimeUnit.HOURS.toMillis(2))
        val folderInside = File(dir, "SYN-folder").apply { mkdirs(); setLastModified(now - TimeUnit.DAYS.toMillis(9)) }

        val deleted = EvidenceUploads.purgeUnused(dir, setOf(oldQueued.name, oldInDraft.name), now)

        assertEquals(3, deleted)
        assertFalse(oldUnused.exists())
        assertFalse(oldPartialVideo.exists())
        assertFalse(oldTemp.exists())
        assertTrue("a file an unfinished upload needs is kept", oldQueued.exists())
        assertTrue("a file the open draft needs is kept", oldInDraft.exists())
        assertTrue("a file younger than the limit is kept", recentUnused.exists())
        assertTrue(folderInside.exists())
    }

    @Test
    fun theCleanUpWaitsThreeDaysAndCopesWithNoFolder() {
        val dir = folder.newFolder("claim-evidence")
        val justUnder = fileAged(dir, "SYN-a.jpg", EvidenceUploads.MAX_UNUSED_AGE_MS - TimeUnit.MINUTES.toMillis(1))
        val justOver = fileAged(dir, "SYN-b.jpg", EvidenceUploads.MAX_UNUSED_AGE_MS + TimeUnit.MINUTES.toMillis(1))
        assertEquals(1, EvidenceUploads.purgeUnused(dir, emptySet(), now))
        assertTrue(justUnder.exists())
        assertFalse(justOver.exists())
        assertEquals(TimeUnit.DAYS.toMillis(3), EvidenceUploads.MAX_UNUSED_AGE_MS)

        assertEquals(0, EvidenceUploads.purgeUnused(File(folder.root, "SYN-missing"), emptySet(), now))
    }

    @Test
    fun eachFileIsItsOwnUniqueJobAndItsTagNamesTheFile() {
        assertEquals("claim-evidence-12-SYN-a.jpg", EvidenceUploads.workName(12, "SYN-a.jpg"))
        assertNotEquals(EvidenceUploads.workName(12, "SYN-a.jpg"), EvidenceUploads.workName(12, "SYN-b.jpg"))
        assertNotEquals(EvidenceUploads.workName(12, "SYN-a.jpg"), EvidenceUploads.workName(13, "SYN-a.jpg"))

        val tags = setOf(
            "shop.youthnic.returnscan.claim.ClaimEvidenceUploadWorker",
            EvidenceUploads.claimTag(12),
            EvidenceUploads.fileTag("SYN-a.jpg")
        )
        assertEquals("SYN-a.jpg", EvidenceUploads.fileNameFromTags(tags))
        // A retry queued by an older build carries only the worker's class name: no file, so the clean-up deletes nothing.
        assertNull(EvidenceUploads.fileNameFromTags(setOf("shop.youthnic.returnscan.claim.ClaimEvidenceUploadWorker")))
        assertNotEquals(EvidenceUploads.claimTag(1), EvidenceUploads.claimTag(12))
    }

    @Test
    fun onlyARefusalThatWouldRepeatStopsTheUpload() {
        for (code in listOf(400, 403, 404, 409, 413, 415, 422)) {
            assertTrue("HTTP $code stops", EvidenceUploads.isPermanentFailure(code))
        }
        for (code in listOf(408, 429, 500, 502, 503, 504, 200, 0)) {
            assertFalse("HTTP $code is retried", EvidenceUploads.isPermanentFailure(code))
        }
    }

    @Test
    fun aRefusedUploadIsShownWithTheServersReason() {
        val summary = EvidenceUploads.summarize(
            listOf(
                Upload(finished = true, succeeded = true),
                Upload(finished = true, succeeded = true),
                Upload(finished = true, succeeded = false, claimId = 12, fieldKey = "reverse_waybill", error = "SYN-File type not allowed"),
                Upload(finished = false, succeeded = false)
            )
        )
        assertEquals(2, summary.uploaded)
        assertEquals(1, summary.waiting)
        assertEquals(listOf("Claim #12 reverse_waybill: SYN-File type not allowed"), summary.failures)
        assertEquals(4, summary.total)

        val result = EvidenceUploads.resultMessage(12, summary)
        assertTrue(result, result.contains("Meesho claim #12 created."))
        assertTrue(result, result.contains("2 of 4 evidence files uploaded."))
        assertTrue(result, result.contains("1 still uploading in the background"))
        assertTrue(result, result.contains("1 refused by the server:\n• Claim #12 reverse_waybill: SYN-File type not allowed"))
        assertTrue(result, result.contains("The claim waits for evidence until these are added."))

        val notice = EvidenceUploads.pendingNotice(summary)!!
        assertTrue(notice, notice.contains("1 still uploading in the background."))
        assertTrue(notice, notice.contains("SYN-File type not allowed"))
    }

    @Test
    fun aRefusalWithoutAReasonStillSaysItWasNotUploaded() {
        val summary = EvidenceUploads.summarize(listOf(Upload(finished = true, succeeded = false)))
        assertEquals(listOf("evidence: not uploaded"), summary.failures)
        assertEquals("Evidence uploads: none waiting.\n1 refused by the server:\n• evidence: not uploaded", EvidenceUploads.pendingNotice(summary))
    }

    @Test
    fun theScreenSaysNothingWhenEveryUploadIsDone() {
        val summary = EvidenceUploads.summarize(listOf(Upload(finished = true, succeeded = true)))
        assertNull(EvidenceUploads.pendingNotice(summary))
        assertNull(EvidenceUploads.pendingNotice(EvidenceUploads.summarize(emptyList())))
        assertEquals("Meesho claim #7 created. All 1 evidence files uploaded.", EvidenceUploads.resultMessage(7, summary))
    }

    @Test
    fun theProgressDialogWaitsForEveryQueuedJob() {
        // The job list can arrive before all five jobs are saved: two seen, both done, is not the end.
        val early = EvidenceUploads.summarize(List(2) { Upload(finished = true, succeeded = true) })
        assertFalse(EvidenceUploads.isDone(early, expected = 5))
        assertEquals(40, EvidenceUploads.percent(early, expected = 5))
        assertTrue(EvidenceUploads.progressText(early, 5), EvidenceUploads.progressText(early, 5).contains("3 still uploading"))

        val running = EvidenceUploads.summarize(List(4) { Upload(finished = true, succeeded = true) } + Upload(finished = false, succeeded = false))
        assertFalse(EvidenceUploads.isDone(running, expected = 5))

        val finished = EvidenceUploads.summarize(
            List(4) { Upload(finished = true, succeeded = true) } + Upload(finished = true, succeeded = false, error = "SYN-refused")
        )
        assertTrue(EvidenceUploads.isDone(finished, expected = 5))
        assertEquals(80, EvidenceUploads.percent(finished, expected = 5))
        assertEquals(100, EvidenceUploads.percent(finished, expected = 0))
    }

    @Test
    fun theClaimScreenSavesEvidenceAndHandsItToUploadJobsWithoutDeletingIt() {
        // The screen cannot be inflated in a unit test, so read its source.
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/ui/ClaimCaptureActivity.kt").readText()
        val onCreate = source.substringAfter("override fun onCreate(").substringBefore("private fun setupMarketplaceDropdown(")
        assertTrue("evidence saved before a kill is restored when the screen opens", onCreate.contains("restoreEvidenceDraft()"))
        val record = source.substringAfter("private fun recordCapturedEvidence(").substringBefore("private fun renderEvidenceCard(")
        assertTrue("each captured file is saved to the draft", record.contains("saveEvidenceDraft()"))
        val camera = source.substringAfter("private fun launchCameraPhoto(").substringBefore("takePhotoLauncher.launch(")
        assertTrue("the photo path is saved before the camera app opens", camera.contains("saveEvidenceDraft()"))

        val submit = source.substringAfter("private fun submitCompleteClaim(").substringBefore("private fun showUploadProgress(")
        assertFalse("evidence is no longer uploaded inline by the screen", source.contains("api.uploadClaimEvidence("))
        val handoff = submit.substringAfter("createResult.onSuccess")
        assertTrue(handoff.contains("ClaimEvidenceUploadWorker.enqueue("))
        assertTrue(
            "the screen lets go of queued files without deleting them, so Start Again cannot delete a queued upload",
            handoff.indexOf("ClaimEvidenceUploadWorker.enqueue(") < handoff.indexOf("capturedFiles.clear()") &&
                handoff.indexOf("capturedFiles.clear()") < handoff.indexOf("saveEvidenceDraft()") &&
                !handoff.substringBefore("showUploadProgress(").contains("clearCapturedEvidence()") &&
                !handoff.substringBefore("showUploadProgress(").contains(".delete()")
        )
    }

    @Test
    fun theUnpackingVideoNeedsNoMicrophonePermission() {
        // The video is recorded without sound, so the app neither declares nor asks for the microphone: a denied
        // microphone permission can never block the evidence step.
        val manifest = File(appDir, "src/main/AndroidManifest.xml").readText()
        assertFalse(manifest.contains("RECORD_AUDIO"))
        val sources = File(appDir, "src/main/java").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        val offenders = sources.filter { it.readText().contains("RECORD_AUDIO") || it.readText().contains("withAudioEnabled") }
        assertTrue("no microphone use expected: ${offenders.map { it.name }}", offenders.isEmpty())
    }
}
