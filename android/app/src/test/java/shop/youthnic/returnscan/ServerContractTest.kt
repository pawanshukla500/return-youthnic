package shop.youthnic.returnscan

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import shop.youthnic.returnscan.data.LookupResult
import shop.youthnic.returnscan.data.MarketplaceAccount
import shop.youthnic.returnscan.data.ScanReceipt
import shop.youthnic.returnscan.data.ScanSessionData
import shop.youthnic.returnscan.data.ShiftProgress
import shop.youthnic.returnscan.data.SubIssue

/**
 * The JSON below has the shape the server really sends (server/register-service.ts and server/register-routes.ts).
 * The app used to read a different shape, so every lookup came back as "not found" and no save could succeed.
 * Test data is synthetic, as the project rules require: every AWB, order, SKU, name and reason starts with SYN-. The
 * words that are part of the protocol (status, leg and category codes) and the display words (colour, size, time) are
 * the plain values the server uses.
 */
class ServerContractTest {

    private val foundJson = """
        {
          "status": "found",
          "trackingId": "SYN-AWB-0001",
          "shipment": {
            "shipmentId": 501,
            "trackingId": "SYN-AWB-0001",
            "matchedLeg": "return",
            "marketplace": "SYN-Myntra",
            "orderId": "SYN-ORDER-9",
            "courier": "SYN-Courier",
            "returnType": "Customer Return",
            "returnReason": "SYN size issue",
            "items": [
              {
                "itemId": 41,
                "orderItemId": "SYN-LINE-1",
                "marketplaceSku": "SYN-LISTING-1",
                "productSku": "SYN-MASTER-1",
                "productName": "SYN Cotton Kurta",
                "expectedQty": 2,
                "imageUrl": "https://example.invalid/syn.jpg",
                "colorName": "Blue",
                "keyDetail": "M",
                "shipmentId": "SYN-SHIP-1"
              }
            ]
          }
        }
    """.trimIndent()

    @Test
    fun foundResponseIsReadFromTheNestedShipment() {
        val result = LookupResult.fromJson(JSONObject(foundJson), "fallback")

        assertEquals(LookupResult.STATUS_FOUND, result.status)
        assertTrue(result.matched)
        assertFalse(result.duplicate)
        assertEquals("SYN-AWB-0001", result.trackingNumber)
        assertEquals("501", result.shipmentId)
        assertEquals("SYN-Myntra", result.marketplace)
        assertEquals("SYN-ORDER-9", result.orderId)
        assertEquals("SYN-Courier", result.carrier)
        assertEquals("return", result.matchLeg)

        assertEquals(1, result.items.size)
        val item = result.items[0]
        assertEquals("41", item.itemId)
        assertEquals("SYN Cotton Kurta", item.title)
        assertEquals("SYN-LISTING-1", item.marketplaceSku)
        assertEquals("SYN-MASTER-1", item.masterSku)
        assertEquals(2, item.quantity)
        assertEquals("Blue · M", item.detailLine)
    }

    @Test
    fun duplicateResponseCarriesWhoAndWhen() {
        val json = """{"status":"duplicate","trackingId":"SYN-AWB-0002","marketplace":"SYN-Myntra","time":"10:42 AM","scannedBy":"SYN Scanner"}"""
        val result = LookupResult.fromJson(JSONObject(json), "fallback")

        assertEquals(LookupResult.STATUS_DUPLICATE, result.status)
        assertTrue(result.duplicate)
        assertFalse(result.matched)
        assertEquals("SYN Scanner", result.duplicateDetails?.scannedBy)
        assertEquals("10:42 AM", result.duplicateDetails?.scannedAt)
    }

    @Test
    fun notFoundResponseIsNotFound() {
        val result = LookupResult.fromJson(JSONObject("""{"status":"not_found","trackingId":"SYN-AWB-0003"}"""), "fallback")

        assertEquals(LookupResult.STATUS_NOT_FOUND, result.status)
        assertEquals("SYN-AWB-0003", result.trackingNumber)
        assertTrue(result.items.isEmpty())
        assertNull(result.duplicateDetails)
    }

    @Test
    fun chooseResponseListsEveryCandidate() {
        val json = """
            {
              "status": "choose",
              "trackingId": "SYN-AWB-0004",
              "candidates": [
                {"shipmentId": 7, "accountId": 1, "accountName": "SYN-Myntra", "alreadyReceived": false, "orderId": "SYN-O-1", "itemCount": 2, "receivedAt": "", "scannedBy": ""},
                {"shipmentId": null, "accountId": 2, "accountName": "SYN-Flipkart", "alreadyReceived": true, "orderId": "", "itemCount": 0, "receivedAt": "9:05 AM", "scannedBy": "SYN Scanner"}
              ]
            }
        """.trimIndent()
        val result = LookupResult.fromJson(JSONObject(json), "fallback")

        assertEquals(LookupResult.STATUS_CHOOSE, result.status)
        assertEquals(2, result.candidates.size)
        assertEquals(7, result.candidates[0].shipmentId)
        assertEquals(2, result.candidates[0].itemCount)
        // A candidate with a null shipmentId has no active return to open, so it reads as 0 and the scanner skips it.
        assertEquals(0, result.candidates[1].shipmentId)
        assertTrue(result.candidates[1].alreadyReceived)
    }

    @Test
    fun shiftCountsAreReadFromFormattedText() {
        val json = """{"scanned":"1,234","correct":"1,200","issues":"34","accuracy":"97.2%","progress":0,"targetLabel":"No daily target set"}"""
        val shift = ShiftProgress.fromJson(JSONObject(json))

        assertEquals(1234, shift.scannedToday)
        assertEquals(34, shift.issuesToday)
        assertEquals("97.2%", shift.clearRate)
        assertEquals(0, ShiftProgress.fromJson(null).scannedToday)
    }

    @Test
    fun receiptIsReadFromTheScanObject() {
        val json = """
            {
              "replayed": false,
              "scan": {"id": 88, "scannedAt": "2026-10-13T10:00:00.000Z", "status": "Raised", "marketplace": "SYN-Myntra", "trackingId": "SYN-AWB-0001"},
              "itemCount": 1,
              "issueCount": 1,
              "shift": {"scanned": "57", "correct": "50", "issues": "7", "accuracy": "88%", "progress": 0, "targetLabel": "x"},
              "claimsBadge": "3"
            }
        """.trimIndent()
        val receipt = ScanReceipt.fromJson(JSONObject(json))

        assertEquals(88, receipt.id)
        assertEquals("Raised", receipt.status)
        assertEquals("issue", receipt.outcome)
        assertEquals(1, receipt.issueCount)
        assertEquals(57, receipt.scannedToday)
        assertFalse(receipt.replayed)
    }

    @Test
    fun replayedCleanReceiptIsClear() {
        val receipt = ScanReceipt.fromJson(
            JSONObject("""{"replayed":true,"scan":{"id":9,"status":"Clear"},"itemCount":1,"issueCount":0}""")
        )
        assertTrue(receipt.replayed)
        assertEquals("clear", receipt.outcome)
        assertEquals(-1, receipt.scannedToday)
    }

    @Test
    fun accountListHasNoScannableCount() {
        // GET /api/accounts sends only id and name, so the app must not show a made-up "0 scannable".
        val account = MarketplaceAccount.fromJson(JSONObject("""{"id":3,"name":"Myntra VB"}"""))

        assertFalse(account.hasScannableCount)
        assertEquals("Myntra VB", account.marketplace)
        assertEquals("#F13AB1", account.color)
    }

    @Test
    fun sessionRulesFilterSubIssuesByCategory() {
        val data = ScanSessionData(
            subIssues = listOf(
                SubIssue(id = "5", name = "Dupatta", categoryCode = "missing_component"),
                SubIssue(id = "6", name = "Other part", categoryCode = "some_other_category")
            )
        )
        assertEquals(listOf("5"), data.subIssuesFor("missing_component").map { it.id })
    }

    @Test
    fun subIssueReadsTheServerLabelAndNumericId() {
        val sub = SubIssue.fromJson(JSONObject("""{"id":12,"label":"Missing Dupatta","categoryCode":"missing_component"}"""))
        assertEquals("12", sub.id)
        assertEquals("Missing Dupatta", sub.name)
        assertEquals("missing_component", sub.categoryCode)
    }
}
