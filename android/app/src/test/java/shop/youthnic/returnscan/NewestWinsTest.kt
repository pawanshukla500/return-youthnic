package shop.youthnic.returnscan

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import shop.youthnic.returnscan.util.NewestWins
import java.io.File

/**
 * The claim screen's return lookups and camera photos finish off the main thread, in any order. Only the newest for a
 * key may fill the form or a one-file evidence slot. Keys are synthetic or the app's own slot names.
 */
class NewestWinsTest {

    private val appDir: File = listOf(File("."), File("app"), File("android/app"))
        .first { File(it, "src/main/res/values/strings.xml").isFile }

    private fun claimScreen(): String =
        File(appDir, "src/main/java/shop/youthnic/returnscan/ui/ClaimCaptureActivity.kt").readText()

    @Test
    fun aLateAnswerFromEarlierWorkIsStale() {
        val order = NewestWins()
        val first = order.next("SYN-lookup")
        assertTrue(order.isNewest("SYN-lookup", first))
        val second = order.next("SYN-lookup")
        // The first lookup answers after the second started: it is stale, whichever of the two answers first.
        assertFalse(order.isNewest("SYN-lookup", first))
        assertTrue(order.isNewest("SYN-lookup", second))
    }

    @Test
    fun eachKeyIsOrderedOnItsOwn() {
        val order = NewestWins()
        val waybill = order.next("reverse_waybill")
        order.next("barcode_image")
        assertTrue("a capture in another slot does not make this one stale", order.isNewest("reverse_waybill", waybill))
        assertFalse("a key with no work has no newest ticket", order.isNewest("SYN-unused", waybill))
    }

    @Test
    fun onlyTheNewestLookupFillsTheClaimForm() {
        // The screen cannot be inflated in a unit test, so read its source: every lookup takes a ticket, and an answer
        // that is no longer the newest returns before it touches the form, the spinner or lookupData.
        val search = claimScreen().substringAfter("private fun searchReturn(").substringBefore("private fun populateReturnDetails(")
        assertTrue(search.contains("val ticket = lookupOrder.next(LOOKUP)"))
        val answer = search.substringAfter("api.lookupClaimReturn(query)")
        val stale = answer.indexOf("if (!lookupOrder.isNewest(LOOKUP, ticket)) return@launch")
        assertTrue("a stale answer must be dropped", stale >= 0)
        assertTrue("before the spinner is hidden", stale < answer.indexOf("binding.progressClaim.visibility = View.GONE"))
        assertTrue("before the form is filled", stale < answer.indexOf("populateReturnDetails(lookup)"))
    }

    @Test
    fun aPhotoFinishingLateNeverReplacesANewerCaptureInAOneFileSlot() {
        // Read the source: a camera photo takes its slot's ticket when the camera returns, and after shrinking it is
        // recorded into a one-file slot only while no later capture for that slot has started or been recorded.
        val source = claimScreen()
        val accept = source.substringAfter("private fun acceptCameraPhoto(").substringBefore("private var pendingPermissionAction")
        assertTrue(accept.contains("val ticket = slotCaptureOrder.next(fieldKey)"))
        val afterShrink = accept.substringAfter("EvidencePhoto.downscaleInPlace(file)")
        val check = afterShrink.indexOf("slotCaptureOrder.isNewest(fieldKey, ticket)")
        assertTrue("the slot's order is checked after shrinking", check >= 0)
        assertTrue("before the photo is recorded", check < afterShrink.indexOf("recordCapturedEvidence("))
        assertTrue(afterShrink.contains("fieldKey !in EvidenceUploads.REPLACED_SLOTS"))
        // Every capture, gallery picks and videos included, becomes the slot's newest when it is recorded.
        val record = source.substringAfter("private fun recordCapturedEvidence(").substringBefore("private fun renderEvidenceCard(")
        assertTrue(record.contains("slotCaptureOrder.next(fieldKey)"))
    }
}
