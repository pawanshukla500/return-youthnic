package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import shop.youthnic.returnscan.claim.DraftFile
import shop.youthnic.returnscan.claim.EvidenceDraft
import shop.youthnic.returnscan.claim.EvidenceDraftStore
import shop.youthnic.returnscan.data.ClaimPayload
import shop.youthnic.returnscan.data.ClaimReturnLookup
import java.io.File

/**
 * The claim screen saves its captured evidence (and the photo the camera app is taking) on every change, and restores it
 * when the screen opens again after the app was killed. Each save stands for a fresh process: a new store reads the file.
 * Test data is synthetic: every key, path and name starts with SYN-.
 */
class EvidenceDraftTest {

    @get:Rule
    val folder = TemporaryFolder()

    private fun evidence(name: String, content: String = "SYN-evidence bytes"): File =
        File(folder.root, "claim-evidence").apply { mkdirs() }.let { File(it, name).apply { writeText(content) } }

    private fun store() = EvidenceDraftStore(File(folder.root, "claim-evidence-draft.json"))

    @Test
    fun capturedEvidenceAndThePendingPhotoComeBackAfterTheAppIsKilled() {
        val photo = evidence("SYN-product_images-1.jpg")
        val waybill = evidence("SYN-reverse_waybill-1.jpg")
        val video = evidence("SYN-unpacking-1.mp4")
        val pending = File(photo.parentFile, "SYN-product_images-2.jpg")
        val draft = EvidenceDraft(
            returnKey = "SYN-SUB-1",
            files = listOf(
                DraftFile(photo.absolutePath, "image/jpeg", "product_images"),
                DraftFile(waybill.absolutePath, "image/jpeg", "reverse_waybill"),
                DraftFile(video.absolutePath, "video/mp4", "unboxing_video")
            ),
            pendingPhotoPath = pending.absolutePath,
            pendingFieldKey = "product_images"
        )
        store().save(draft)

        val restored = store().load()
        assertEquals(draft, restored)
        assertEquals(draft.files, restored!!.restorableFiles())
        // The camera app had not written its photo yet, so there is none to take.
        assertNull(restored.takenPendingPhoto())
    }

    @Test
    fun aPhotoTheCameraSavedAfterTheAppWasKilledIsTakenIntoItsSlot() {
        val pending = evidence("SYN-reverse_waybill-2.jpg", "SYN-jpeg written by the camera app")
        store().save(EvidenceDraft("SYN-SUB-1", emptyList(), pending.absolutePath, "reverse_waybill"))

        val restored = store().load()!!
        assertEquals(pending.absolutePath, restored.takenPendingPhoto()?.absolutePath)
        assertEquals("reverse_waybill", restored.pendingFieldKey)
    }

    @Test
    fun anEmptyFileTheCameraLeftOnCancelIsNotTaken() {
        val pending = evidence("SYN-barcode_image-1.jpg", "")
        val draft = EvidenceDraft("SYN-SUB-1", emptyList(), pending.absolutePath, "barcode_image")
        assertNull(draft.takenPendingPhoto())
        // Nor a photo whose slot is unknown.
        val written = evidence("SYN-barcode_image-2.jpg")
        assertNull(EvidenceDraft("SYN-SUB-1", emptyList(), written.absolutePath, "").takenPendingPhoto())
    }

    @Test
    fun aFileGoneOrEmptiedSinceTheSaveIsNotRestored() {
        val kept = evidence("SYN-product_images-1.jpg")
        val uploaded = evidence("SYN-product_images-2.jpg")
        val emptied = evidence("SYN-reverse_waybill-1.jpg")
        store().save(
            EvidenceDraft(
                "SYN-SUB-1",
                listOf(
                    DraftFile(kept.absolutePath, "image/jpeg", "product_images"),
                    DraftFile(uploaded.absolutePath, "image/jpeg", "product_images"),
                    DraftFile(emptied.absolutePath, "image/jpeg", "reverse_waybill")
                )
            )
        )
        assertTrue(uploaded.delete())
        emptied.writeText("")

        assertEquals(listOf(DraftFile(kept.absolutePath, "image/jpeg", "product_images")), store().load()!!.restorableFiles())
    }

    @Test
    fun eachSaveReplacesTheLastAndAnEmptyDraftLeavesNoFile() {
        val first = evidence("SYN-product_images-1.jpg")
        val second = evidence("SYN-product_images-2.jpg")
        store().save(EvidenceDraft("SYN-SUB-1", listOf(DraftFile(first.absolutePath, "image/jpeg", "product_images"))))
        store().save(EvidenceDraft("SYN-SUB-1", listOf(DraftFile(second.absolutePath, "image/jpeg", "product_images"))))
        assertEquals(listOf(second.absolutePath), store().load()!!.files.map { it.path })
        assertFalse(File(folder.root, "claim-evidence-draft.json.tmp").exists())

        // Once the files are handed to upload jobs the screen saves an empty draft: nothing is restored next time.
        store().save(EvidenceDraft("SYN-SUB-1", emptyList()))
        assertFalse(store().exists())
        assertNull(store().load())
    }

    @Test
    fun theSlotBeingFilledIsSavedEvenBeforeAnyFileIsCaptured() {
        // The gallery or the recorder is open for a slot: a result that arrives after a restart must land in that slot.
        store().save(EvidenceDraft("SYN-SUB-1", emptyList(), pendingFieldKey = "unboxing_video"))
        assertEquals("unboxing_video", store().load()!!.pendingFieldKey)
    }

    @Test
    fun aDamagedOrMissingDraftRestoresNothing() {
        assertNull(store().load())
        File(folder.root, "claim-evidence-draft.json").writeText("{ SYN-not json")
        assertNull(store().load())
        assertNull(EvidenceDraft.fromJson("[]"))
        // An entry without its path, type or slot is skipped rather than restored into a blank slot.
        val partial = EvidenceDraft.fromJson(
            """{"returnKey":"SYN-SUB-1","files":[{"path":"/SYN/a.jpg","mimeType":"image/jpeg"},""" +
                """{"path":"/SYN/b.jpg","mimeType":"image/jpeg","fieldKey":"product_images"}]}"""
        )
        assertEquals(listOf("/SYN/b.jpg"), partial!!.files.map { it.path })
    }

    @Test
    fun aPhotoStillBeingShrunkComesBackAfterTheAppIsKilled() {
        // Restored from the camera's pending photo, the photo is shrunk in the background and the draft is saved at once.
        // That save used to have no pending photo and no file for it, so a second kill during the shrink lost the photo.
        val shrinking = evidence("SYN-reverse_waybill-3.jpg", "SYN-jpeg still being shrunk")
        val saving = DraftFile(shrinking.absolutePath, "image/jpeg", "reverse_waybill")
        val draft = EvidenceDraft("SYN-SUB-1", emptyList(), photosBeingSaved = listOf(saving))
        assertFalse("a draft holding only a photo being shrunk is not empty", draft.isEmpty)
        store().save(draft)

        val restored = store().load()!!
        assertEquals(listOf(saving), restored.photosToShrink())
        assertEquals("the start-up clean-up keeps it", setOf("SYN-reverse_waybill-3.jpg"), restored.fileNames())
        // Gone or emptied since the save (deleted as a stale capture): nothing to shrink.
        assertTrue(shrinking.delete())
        assertEquals(emptyList<DraftFile>(), store().load()!!.photosToShrink())
        // A draft saved by an older build has no photos being shrunk.
        assertEquals(emptyList<DraftFile>(), EvidenceDraft.fromJson("""{"returnKey":"SYN-SUB-1","files":[]}""")!!.photosBeingSaved)
    }

    @Test
    fun theClaimScreenKeepsAPhotoInTheDraftUntilItIsRecorded() {
        // The screen cannot be inflated in a unit test, so read its source.
        val appDir = listOf(File("."), File("app"), File("android/app"))
            .first { File(it, "src/main/res/values/strings.xml").isFile }
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/ui/ClaimCaptureActivity.kt").readText()
        val accept = source.substringAfter("private fun acceptCameraPhoto(").substringBefore("private var pendingPermissionAction")
        val beforeShrink = accept.substringBefore("lifecycleScope.launch")
        assertTrue("listed before the shrink starts", beforeShrink.contains("photosBeingSaved.add(saving)"))
        assertTrue("and saved in the draft", beforeShrink.indexOf("photosBeingSaved.add(saving)") < beforeShrink.indexOf("saveEvidenceDraft()"))
        val afterShrink = accept.substringAfter("EvidencePhoto.downscaleInPlace(file)")
        assertTrue(
            "taken off the list before it is recorded, so the draft never names it twice",
            afterShrink.indexOf("photosBeingSaved.remove(saving)") in 0 until afterShrink.indexOf("recordCapturedEvidence(")
        )
        val save = source.substringAfter("private fun saveEvidenceDraft(").substringBefore("private fun restoreEvidenceDraft(")
        assertTrue("every draft save lists the photos still being shrunk", save.contains("photosBeingSaved.toList()"))
        val restore = source.substringAfter("private fun restoreEvidenceDraft(").substringBefore("private fun observeQueuedUploads(")
        assertTrue("a restore shrinks them again", restore.contains("for (saving in shrinking) acceptCameraPhoto(File(saving.path), saving.fieldKey)"))
        assertTrue(restore.contains("val shrinking = draft.photosToShrink()"))
        val clear = source.substringAfter("private fun clearCapturedEvidence(").substringBefore("private fun saveEvidenceDraft(")
        assertTrue(
            "cleared evidence drops them from the draft, so a kill cannot restore them onto the next return",
            clear.indexOf("photosBeingSaved.clear()") in 0 until clear.indexOf("saveEvidenceDraft()")
        )
    }

    @Test
    fun theDraftNamesEveryFileTheStartUpCleanUpMustKeep() {
        val draft = EvidenceDraft(
            "SYN-SUB-1",
            listOf(DraftFile("/data/SYN/claim-evidence/SYN-a.jpg", "image/jpeg", "product_images")),
            pendingPhotoPath = "/data/SYN/claim-evidence/SYN-b.jpg",
            pendingFieldKey = "product_images"
        )
        assertEquals(setOf("SYN-a.jpg", "SYN-b.jpg"), draft.fileNames())
        assertEquals(emptySet<String>(), EvidenceDraft("SYN-SUB-1", emptyList()).fileNames())
    }

    @Test
    fun restoredEvidenceBelongsOnlyToTheReturnItWasCapturedFor() {
        val lookup = ClaimReturnLookup(
            found = true,
            subOrderId = "SYN-SUB-1",
            orderId = "SYN-ORDER-1",
            trackingNumber = "SYN-AWB-0001",
            awb = "SYN-AWB-0001"
        )
        val key = ClaimPayload.returnKey(lookup)
        assertEquals("SYN-SUB-1", key)
        assertTrue(ClaimPayload.isReturn(key, lookup))
        assertTrue(ClaimPayload.isReturn("syn-sub-1", lookup))
        assertFalse(ClaimPayload.isReturn("SYN-SUB-2", lookup))
        // A draft saved without a return (never expected) is never kept.
        assertFalse(ClaimPayload.isReturn("", lookup))
    }

    @Test
    fun everyEvidenceCardShowsItsSlotsRealMaximum() {
        // The screen cannot be inflated in a unit test, so read its source.
        val appDir = listOf(File("."), File("app"), File("android/app"))
            .first { File(it, "src/main/res/values/strings.xml").isFile }
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/ui/ClaimCaptureActivity.kt").readText()
        assertFalse(
            "a card must say its count / its maxCount (Product images 10, Attachments 5), never a hard-coded / 1",
            source.contains("/ 1\"")
        )
        val build = source.substringAfter("private fun buildDynamicEvidenceCards(").substringBefore("private fun startCaptureFor(")
        assertTrue(build.contains("evidenceMaxCounts[field.fieldKey] = field.maxCount"))
        val render = source.substringAfter("private fun renderEvidenceCard(").substringBefore("private fun removeEvidence(")
        assertTrue("an empty card", render.contains("\"0 / \${evidenceMaxCounts[fieldKey]"))
        // A filled card used to say 3 / 1 for three product images; it says 3 / 10.
        assertTrue("a filled card", render.contains("\"\${list.size} / \${evidenceMaxCounts[fieldKey]"))
    }
}
