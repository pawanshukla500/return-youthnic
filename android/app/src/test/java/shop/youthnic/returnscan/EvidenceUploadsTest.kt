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
 * Queued evidence uploads: one unique job per file, a 4xx shown to the operator instead of dropped, old evidence
 * files cleaned up at start-up without touching any that a draft or an unfinished upload still needs, progress by
 * bytes, two files at a time and the video as foreground work. Test data is synthetic: every file name and server
 * message starts with SYN-.
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
    fun progressMovesWithTheBytesOfTheVideoNotOnlyWhenAFileFinishes() {
        val photo = 512L * 1024
        val video = 25L * 1024 * 1024
        val expectedBytes = photo + photo + video // 26.0 MB
        val halfway = EvidenceUploads.summarize(
            listOf(
                Upload(finished = true, succeeded = true, bytesSent = photo),
                Upload(finished = false, succeeded = false), // waiting for one of the two upload slots
                Upload(finished = false, succeeded = false, bytesSent = video / 2)
            )
        )
        assertEquals(photo + video / 2, halfway.bytesSent)
        assertEquals(50, EvidenceUploads.percent(halfway, expected = 3, expectedBytes = expectedBytes))
        assertEquals("by files it would still read 33%", 33, EvidenceUploads.percent(halfway, expected = 3))
        val text = EvidenceUploads.progressText(halfway, 3, expectedBytes)
        assertTrue(text, text.contains("Uploaded 1 of 3 evidence file(s).\nSent 13.0 MB of 26.0 MB."))

        val later = EvidenceUploads.summarize(
            listOf(
                Upload(finished = true, succeeded = true, bytesSent = photo),
                Upload(finished = false, succeeded = false, bytesSent = 100L * 1024),
                Upload(finished = false, succeeded = false, bytesSent = video / 2 + 300L * 1024)
            )
        )
        assertTrue(EvidenceUploads.percent(later, 3, expectedBytes) > EvidenceUploads.percent(halfway, 3, expectedBytes))
    }

    @Test
    fun aRefusedFileAddsNoBytesAndTheBarNeverPassesTheEnd() {
        val refused = EvidenceUploads.summarize(
            listOf(
                Upload(finished = true, succeeded = true, bytesSent = 1_000),
                Upload(finished = true, succeeded = false, error = "SYN-refused", bytesSent = 999)
            )
        )
        assertEquals(1_000L, refused.bytesSent)
        assertEquals(50, EvidenceUploads.percent(refused, expected = 2, expectedBytes = 2_000))

        val mb = 1024L * 1024
        val over = EvidenceUploads.summarize(listOf(Upload(finished = true, succeeded = true, bytesSent = 3 * mb)))
        assertEquals(100, EvidenceUploads.percent(over, expected = 1, expectedBytes = 2 * mb))
        val text = EvidenceUploads.progressText(over, 1, 2 * mb)
        assertTrue(text, text.contains("Sent 2.0 MB of 2.0 MB."))

        assertEquals(100, EvidenceUploads.percentOf(0, 0))
        assertEquals(0, EvidenceUploads.percentOf(-5, 10))
        assertEquals(99, EvidenceUploads.percentOf(999, 1_000))
    }

    @Test
    fun aBigVideoSavesAboutAHundredProgressUpdatesNotThousands() {
        val video = 25L * 1024 * 1024
        var reported = 0L
        var updates = 0
        var sent = 0L
        while (sent < video) {
            sent = minOf(video, sent + 8 * 1024) // OkHttp writes about 8 KiB at a time: ~3,200 writes
            if (EvidenceUploads.shouldReportBytes(reported, sent, video)) {
                reported = sent
                updates++
            }
        }
        assertTrue("updates: $updates", updates in 90..101)
        assertEquals("the last byte is always reported", video, reported)

        // A photo still moves in steps of at least 128 KiB, and its last byte is reported.
        val photo = 300_000L
        assertFalse(EvidenceUploads.shouldReportBytes(0, 131_071, photo))
        assertTrue(EvidenceUploads.shouldReportBytes(0, 131_072, photo))
        assertTrue(EvidenceUploads.shouldReportBytes(262_144, photo, photo))
    }

    @Test
    fun twoFilesUploadAtOnceAndTheVideoRunsAsForegroundWork() {
        assertEquals(2, EvidenceUploads.PARALLEL_UPLOADS)
        assertTrue("a 25 MB unpacking video", EvidenceUploads.needsForeground(25L * 1024 * 1024))
        assertTrue(EvidenceUploads.needsForeground(2L * 1024 * 1024))
        assertFalse("a downscaled photo", EvidenceUploads.needsForeground(600_000))

        // WorkManager and the manifest cannot run in a unit test, so read them. Without the dataSync type and its
        // permission, Android 14 refuses the foreground service.
        val manifest = File(appDir, "src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE\""))
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_DATA_SYNC"))
        val service = manifest.substringAfter("androidx.work.impl.foreground.SystemForegroundService").substringBefore("/>")
        assertTrue(service.contains("android:foregroundServiceType=\"dataSync\""))
        assertTrue(service.contains("tools:node=\"merge\""))

        val worker = File(appDir, "src/main/java/shop/youthnic/returnscan/claim/ClaimEvidenceUploadWorker.kt").readText()
        assertTrue(worker.contains("Semaphore(EvidenceUploads.PARALLEL_UPLOADS)"))
        val work = worker.substringAfter("override suspend fun doWork()").substringBefore("private suspend fun promoteToForeground(")
        assertTrue("every upload waits for a slot", work.contains("uploadSlots.withPermit {"))
        val promote = work.indexOf("EvidenceUploads.needsForeground(fileBytes) && promoteToForeground(")
        assertTrue(
            "a big file asks for foreground as its job starts, not after waiting for a slot (the app may be in the background by then)",
            promote >= 0 && promote < work.indexOf("uploadSlots.withPermit {")
        )
        val onBytes = work.substringAfter("uploadClaimEvidence(").substringBefore("EvidenceUploads.shouldReportBytes(")
        assertTrue("a stopped job fails its write, so the blocking call ends and frees its slot", onBytes.contains("if (isStopped) throw IOException("))
        assertTrue(worker.contains("ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC"))
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
    fun aSlotTakesNoCapturePastItsMaximum() {
        // The server refuses an 11th product image (max 10) with a 409, so that photo would be left off the claim.
        assertTrue(EvidenceUploads.canCapture("product_images", 9, 10))
        assertFalse(EvidenceUploads.canCapture("product_images", 10, 10))
        assertFalse(EvidenceUploads.canCapture("attachments", 5, 5))
        // A one-file slot of any other name is full at 1 too.
        assertFalse(EvidenceUploads.canCapture("SYN-extra-slot", 1, 1))
        // The video, waybill and barcode slots replace their one file, so a new capture always fits.
        for (key in listOf("unboxing_video", "reverse_waybill", "barcode_image")) {
            assertTrue(key, EvidenceUploads.canCapture(key, 1, 1))
        }
    }

    @Test
    fun photosStillBeingSavedCountTowardsTheSlotsMaximum() {
        // Product images holds 9 of 10 and the 10th photo is still being shrunk: a second Take Photo or Gallery tap would
        // make 11, which Submit refuses and the card's X can only fix by deleting all of them.
        assertFalse(EvidenceUploads.canCapture("product_images", 9, 10, beingSaved = 1))
        assertTrue(EvidenceUploads.canCapture("product_images", 8, 10, beingSaved = 1))
        assertFalse(EvidenceUploads.canCapture("attachments", 3, 5, beingSaved = 2))
        // A one-file slot replaces its file, so a capture still fits.
        assertTrue(EvidenceUploads.canCapture("reverse_waybill", 1, 1, beingSaved = 1))
        // The screen counts the photos still being shrunk into that slot (read from source: it cannot be inflated here).
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/ui/ClaimCaptureActivity.kt").readText()
        val start = source.substringAfter("private fun startCaptureFor(").substringBefore("private fun launchCameraPhoto(")
        assertTrue(start.contains("val saving = photosBeingSaved.count { it.fieldKey == fieldKey }"))
        assertTrue(start.contains("EvidenceUploads.canCapture(fieldKey, capturedFiles[fieldKey]?.size ?: 0, max, saving)"))
    }

    @Test
    fun submitFindsASlotPastItsMaximum() {
        val max = mapOf("product_images" to 10, "attachments" to 5, "unboxing_video" to 1)
        assertNull(EvidenceUploads.overfullSlot(mapOf("product_images" to 10, "attachments" to 5, "unboxing_video" to 1), max))
        assertEquals("product_images", EvidenceUploads.overfullSlot(mapOf("product_images" to 11, "attachments" to 2), max))
        assertEquals("attachments", EvidenceUploads.overfullSlot(mapOf("product_images" to 3, "attachments" to 6), max))
        // A slot the template does not list has no card to fix it from, so it never blocks the claim.
        assertNull(EvidenceUploads.overfullSlot(mapOf("SYN-unknown-slot" to 3), max))
    }

    @Test
    fun theClaimScreenRefusesACapturePastTheSlotsMaximum() {
        // The screen cannot be inflated in a unit test, so read its source.
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/ui/ClaimCaptureActivity.kt").readText()
        val cards = source.substringAfter("private fun buildDynamicEvidenceCards(").substringBefore("    private fun startCaptureFor(")
        val starts = Regex("""startCaptureFor\(field\.fieldKey\)""").findAll(cards).count()
        assertEquals("Take Photo, Record Video and both Gallery buttons", 4, starts)
        assertEquals(
            "every capture button stops when the slot is full",
            starts,
            Regex("""if \(!startCaptureFor\(field\.fieldKey\)\) return@setOnClickListener""").findAll(cards).count()
        )
        val start = source.substringAfter("private fun startCaptureFor(").substringBefore("private fun launchCameraPhoto(")
        assertTrue(start.contains("EvidenceUploads.canCapture(fieldKey, capturedFiles[fieldKey]?.size ?: 0, max, saving)"))
        val record = source.substringAfter("private fun recordCapturedEvidence(").substringBefore("private fun renderEvidenceCard(")
        assertTrue("one list of replaced slots", record.contains("fieldKey in EvidenceUploads.REPLACED_SLOTS"))
        val submit = source.substringAfter("private fun submitCompleteClaim(").substringBefore("lifecycleScope.launch {")
        val check = submit.indexOf("EvidenceUploads.overfullSlot(")
        assertTrue("Submit checks every slot against its maximum", check >= 0)
        assertTrue("before anything is sent", submit.substring(check).contains("return"))
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
