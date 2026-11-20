package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import shop.youthnic.returnscan.data.ClaimFormInput
import shop.youthnic.returnscan.data.ClaimPayload
import shop.youthnic.returnscan.data.ClaimProductItem
import shop.youthnic.returnscan.data.ClaimReturnLookup
import java.io.File

/**
 * The body of POST /api/claims/unified-create (server/claim-automation-routes.ts). When the return lookup failed, the
 * app used to send an invented lookup with a remembered customer, price and SKU, and that reached the Meesho ticket.
 * Now a claim is sent only with a lookup that found the form's return. Test data is synthetic: every ID, name and SKU
 * starts with SYN-; issue codes, labels and packet states are the protocol values the app and server use.
 */
class ClaimPayloadTest {

    private val form = ClaimFormInput(
        subOrderId = "SYN-SUB-1",
        awb = "SYN-AWB-0001",
        packetId = "SYN-FLYER-1",
        packetState = "Intact",
        issueCode = "missing_items",
        issueLabel = "Item/s are missing in my return",
        title = "SYN claim title",
        content = "SYN claim content",
        templateId = 7
    )

    private val item = ClaimProductItem(
        itemId = 41,
        sku = "SYN-LISTING-1",
        masterSku = "SYN-MASTER-1",
        title = "SYN Cotton Kurta",
        quantity = 1,
        imageUrl = ""
    )

    private val lookup = ClaimReturnLookup(
        found = true,
        scanId = 900,
        expectedReturnId = 501,
        marketplace = "SYN-Meesho",
        subOrderId = "SYN-SUB-1",
        orderId = "SYN-ORDER-1",
        trackingNumber = "SYN-AWB-0001",
        awb = "SYN-AWB-0001",
        packetId = "SYN-FLYER-1",
        customerName = "SYN-Customer",
        totalPrice = 349.0,
        shippedDate = "2026-11-01",
        missingAmount = 120.0,
        items = listOf(item)
    )

    private val appDir: File = listOf(File("."), File("app"), File("android/app"))
        .first { File(it, "src/main/res/values/strings.xml").isFile }

    @Test
    fun aFailedLookupBlocksTheClaim() {
        // No body means no customer, price, SKU or packet ID can be sent, cached or otherwise.
        assertNull(ClaimPayload.build(null, form))
    }

    @Test
    fun aSearchThatFoundNothingBlocksTheClaim() {
        assertNull(ClaimPayload.build(lookup.copy(found = false), form))
    }

    @Test
    fun aLookupForAnotherSubOrderBlocksTheClaim() {
        // The operator changed the sub order after the lookup: that return's scan, customer, price and SKU are not this claim's.
        assertNull(ClaimPayload.build(lookup, form.copy(subOrderId = "SYN-SUB-2")))
        assertNull(ClaimPayload.confirmedLookup(lookup, "SYN-SUB-2", "SYN-AWB-0001"))
    }

    @Test
    fun aConfirmedLookupSuppliesTheReturnAndTheFormSuppliesWhatTheOperatorEntered() {
        val body = requireNotNull(ClaimPayload.build(lookup, form)) { "a confirmed lookup must build a body" }

        assertEquals(900, body.getInt("receiptScanId"))
        assertEquals(501, body.getInt("expectedReturnId"))
        assertEquals("SYN-Customer", body.getString("customerName"))
        assertEquals(349.0, body.getDouble("totalPrice"), 0.0)
        assertEquals("2026-11-01", body.getString("shippedDate"))
        assertEquals("SYN-MASTER-1", body.getString("sku"))
        assertEquals(120.0, body.getDouble("missingAmount"), 0.0)

        assertEquals("SYN-SUB-1", body.getString("subOrderId"))
        assertEquals("SYN-AWB-0001", body.getString("awb"))
        assertEquals("SYN-FLYER-1", body.getString("packetId"))
        assertEquals("Intact", body.getString("packetState"))
        assertEquals("missing_items", body.getString("marketplaceIssueCode"))
        assertEquals("Item/s are missing in my return", body.getString("claimReason"))
        assertEquals("SYN claim title", body.getString("claimTitle"))
        assertEquals("SYN claim content", body.getString("claimDescription"))
        assertEquals("SYN claim content", body.getString("claimContent"))
        assertEquals(7, body.getInt("claimTemplateId"))
    }

    @Test
    fun theFormMatchesItsLookupIgnoringCaseAndSpaces() {
        assertNotNull(ClaimPayload.confirmedLookup(lookup, " syn-sub-1 ", "SYN-AWB-0001"))
    }

    @Test
    fun withoutASubOrderTheAwbIdentifiesTheReturn() {
        val noSubOrder = lookup.copy(subOrderId = "", orderId = "")
        assertNotNull(ClaimPayload.confirmedLookup(noSubOrder, "", "SYN-AWB-0001"))
        assertNull(ClaimPayload.confirmedLookup(noSubOrder, "", "SYN-AWB-0002"))
        assertNull(ClaimPayload.confirmedLookup(noSubOrder, "", ""))
    }

    @Test
    fun theSkuComesOnlyFromTheLookedUpItem() {
        assertEquals("SYN-MASTER-1", ClaimPayload.sku(lookup))
        assertEquals("SYN-LISTING-1", ClaimPayload.sku(lookup.copy(items = listOf(item.copy(masterSku = "")))))
        assertEquals("", ClaimPayload.sku(lookup.copy(items = emptyList())))
        assertEquals("", ClaimPayload.sku(null))
        assertEquals("", ClaimPayload.build(lookup.copy(items = emptyList()), form)!!.getString("sku"))
    }

    @Test
    fun noScanOrTemplateIdIsSentWhenThereIsNone() {
        val body = ClaimPayload.build(lookup.copy(scanId = null, expectedReturnId = 0), form.copy(templateId = null))!!
        assertFalse(body.has("receiptScanId"))
        assertFalse(body.has("expectedReturnId"))
        assertFalse(body.has("claimTemplateId"))
    }

    @Test
    fun evidenceStaysOnlyWhenTheNewLookupIsTheSameReturn() {
        // Evidence is captured for the confirmed lookup. Looking that return up again keeps it; any other return drops it,
        // so one package's photos and video are never uploaded with another package's claim.
        assertTrue(ClaimPayload.sameReturn(lookup, lookup.copy(customerName = "SYN-Customer-2")))
        assertTrue(ClaimPayload.sameReturn(lookup, lookup.copy(subOrderId = " syn-sub-1 ")))
        assertFalse(ClaimPayload.sameReturn(lookup, lookup.copy(subOrderId = "SYN-SUB-2")))
        assertFalse(ClaimPayload.sameReturn(null, lookup))
    }

    @Test
    fun withoutASubOrderTheAwbDecidesWhetherEvidenceStays() {
        val noSubOrder = lookup.copy(subOrderId = "", orderId = "")
        assertTrue(ClaimPayload.sameReturn(noSubOrder, noSubOrder))
        assertFalse(ClaimPayload.sameReturn(noSubOrder, noSubOrder.copy(awb = "SYN-AWB-0002", trackingNumber = "SYN-AWB-0002")))
        val noKey = noSubOrder.copy(awb = "", trackingNumber = "")
        assertFalse(ClaimPayload.sameReturn(noKey, noKey))
    }

    @Test
    fun theClaimScreenDropsEvidenceWhenALookupLoadsAnotherReturn() {
        // The screen cannot be inflated in a unit test, so read its source: before a lookup replaces lookupData, the
        // evidence captured for the old return is checked and, for another return, deleted.
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/ui/ClaimCaptureActivity.kt").readText()
        val beforeReplace = source.substringAfter("private fun populateReturnDetails(").substringBefore("lookupData = data")
        assertTrue("populateReturnDetails must compare the returns first", beforeReplace.contains("ClaimPayload.sameReturn(lookupData, data)"))
        assertTrue("populateReturnDetails must drop another return's evidence", beforeReplace.contains("clearCapturedEvidence()"))
    }

    @Test
    fun theClaimScreenNeverFillsAClaimFromARememberedScan() {
        // The screen cannot be inflated in a unit test, so read its source: no remembered last-scanned value is read
        // (they used to fill blanks in the form, the description and the submit), and no lookup is invented.
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/ui/ClaimCaptureActivity.kt").readText()
        val reads = Regex("""\blastScanned[A-Z]\w*""").findAll(source).map { it.value }.toList()
        assertEquals("ClaimCaptureActivity reads remembered values: $reads", emptyList<String>(), reads)
        assertFalse("ClaimCaptureActivity builds its own ClaimReturnLookup", source.contains("ClaimReturnLookup("))
    }
}
