package shop.youthnic.returnscan

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import shop.youthnic.returnscan.data.IssueCategory
import shop.youthnic.returnscan.data.ItemVerificationState
import shop.youthnic.returnscan.data.ScanPayload

/** The body of POST /api/scan/complete must follow server/register-rules.ts (validateScanSubmission). */
class ScanPayloadTest {

    private val noIssue = IssueCategory("no_issue", "No issue", true, false, false, false, false)
    private val missing = IssueCategory("missing_component", "Missing product or component", false, true, false, true, true)
    private val damaged = IssueCategory("damaged_product", "Damaged product", false, false, false, false, false)
    private val wrong = IssueCategory("wrong_product", "Wrong product", false, false, false, false, false)

    private fun line(
        category: IssueCategory,
        expected: Int = 2,
        received: Int = 2,
        sub: String? = null,
        ticket: String = "",
        notes: String = ""
    ) = ItemVerificationState(
        itemId = "41",
        expectedQty = expected,
        receivedQty = received,
        physicalChecked = true,
        category = category,
        subIssueId = sub,
        ticketCode = ticket,
        notes = notes
    )

    private fun firstIssue(body: JSONObject): JSONObject =
        body.getJSONArray("items").getJSONObject(0).getJSONArray("issues").getJSONObject(0)

    @Test
    fun clearLineSendsNoIssueAtAll() {
        val body = ScanPayload.build(501, "SYN-MOBILE-1-AWB-1", "SYN-AWB-0001", listOf(line(noIssue)))

        assertEquals(501, body.getInt("shipmentId"))
        assertEquals("SYN-MOBILE-1-AWB-1", body.getString("clientScanKey"))
        assertEquals("SYN-AWB-0001", body.getString("scannedTracking"))
        val item = body.getJSONArray("items").getJSONObject(0)
        assertEquals(41, item.getInt("itemId"))
        assertEquals(2, item.getInt("receivedQty"))
        assertTrue(item.getBoolean("verified"))
        assertEquals(0, item.getJSONArray("issues").length())
    }

    @Test
    fun missingLineCoversTheUnitsNotReceived() {
        // 2 expected, 0 received, a missing item chosen: the issue covers the 2 units that did not arrive.
        val whole = ScanPayload.build(501, "SYN-MOBILE-1", "A", listOf(line(missing, received = 0, sub = "7")))
        val issue = firstIssue(whole)
        assertEquals("missing_component", issue.getString("categoryCode"))
        assertEquals(7, issue.getInt("subIssueId"))
        assertEquals(2, issue.getInt("qty"))
        assertEquals(0, whole.getJSONArray("items").getJSONObject(0).getInt("receivedQty"))

        // 2 expected, 1 received: the issue covers the 1 unit that did not arrive.
        val partial = ScanPayload.build(501, "SYN-MOBILE-1", "A", listOf(line(missing, received = 1, sub = "7")))
        assertEquals(1, firstIssue(partial).getInt("qty"))
    }

    @Test
    fun otherIssuesCoverTheReceivedUnitsAndTakeNoSubIssue() {
        val body = ScanPayload.build(501, "SYN-MOBILE-1", "A", listOf(line(damaged, sub = "7", ticket = "SYN-T-1", notes = " torn ")))
        val issue = firstIssue(body)

        assertEquals("damaged_product", issue.getString("categoryCode"))
        assertEquals(2, issue.getInt("qty"))
        assertTrue(issue.isNull("subIssueId"))
        // The server refuses a ticket on a category that does not take one.
        assertEquals("", issue.getString("ticketCode"))
        assertEquals("torn", issue.getString("notes"))
    }

    @Test
    fun anIssueOnSomeUnitsOnlyCountsThoseUnits() {
        // 2 units arrived and 1 is damaged: the issue covers 1 unit, not both.
        val some = line(damaged).also { it.affectedUnits = 1 }
        val body = ScanPayload.build(501, "SYN-MOBILE-1", "A", listOf(some))
        assertEquals(1, firstIssue(body).getInt("qty"))
        assertEquals(2, body.getJSONArray("items").getJSONObject(0).getInt("receivedQty"))
        assertNull(ScanPayload.problemWith(some, "item #1"))

        // The number of units affected cannot be 0 or more than the units received.
        assertNotNull(ScanPayload.problemWith(line(damaged).also { it.affectedUnits = 0 }, "item #1"))
        assertNotNull(ScanPayload.problemWith(line(damaged).also { it.affectedUnits = 3 }, "item #1"))
    }

    @Test
    fun ticketIsSentOnlyWhenTheCategoryRequiresIt() {
        val ticketed = damaged.copy(requiresTicket = true)
        val body = ScanPayload.build(501, "SYN-MOBILE-1", "A", listOf(line(ticketed, ticket = " SYN-T-1 ")))
        assertEquals("SYN-T-1", firstIssue(body).getString("ticketCode"))
    }

    @Test
    fun problemsAreReportedInPlainWords() {
        assertNull(ScanPayload.problemWith(line(noIssue), "item #1"))
        assertNull(ScanPayload.problemWith(line(missing, received = 0, sub = "7"), "item #1"))
        assertNull(ScanPayload.problemWith(line(wrong, notes = "SYN other kurta"), "item #1"))

        val unchecked = line(noIssue).also { it.physicalChecked = false }
        assertTrue(ScanPayload.problemWith(unchecked, "item #1")!!.contains("physical"))

        // A clear return with units missing must be reported as a missing item, not saved as clear.
        assertTrue(ScanPayload.problemWith(line(noIssue, received = 1), "item #1")!!.contains("Missing Component"))

        // A missing item that did not lower the received quantity covers no units.
        assertNotNull(ScanPayload.problemWith(line(missing, received = 2, sub = "7"), "item #1"))

        // A missing item needs the component.
        assertTrue(ScanPayload.problemWith(line(missing, received = 0), "item #1")!!.contains("missing"))

        // Wrong product and other issue need a written reason.
        assertTrue(ScanPayload.problemWith(line(wrong), "item #1")!!.contains("notes"))

        val ticketed = damaged.copy(requiresTicket = true)
        assertTrue(ScanPayload.problemWith(line(ticketed), "item #1")!!.contains("ticket"))
        assertNull(ScanPayload.problemWith(line(ticketed, ticket = "SYN-T-2"), "item #1"))
    }
}
