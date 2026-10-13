package shop.youthnic.returnscan.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * One returned line while the scanner verifies it. [category] is a server category (GET /api/scan/session), so the
 * code sent back is always one the server knows. [IssueCategory.isClear] means "no issue".
 */
data class ItemVerificationState(
    val itemId: String,
    val expectedQty: Int,
    var receivedQty: Int,
    var physicalChecked: Boolean,
    var category: IssueCategory,
    var subIssueId: String?,
    var ticketCode: String,
    var notes: String
) {
    val hasIssue: Boolean get() = !category.isClear

    /**
     * The units an issue covers, as the server counts them: the units not received for a missing-item issue,
     * otherwise the units received (the same rule the web scan screen follows).
     */
    val issueQty: Int get() = if (category.isMissing) expectedQty - receivedQty else receivedQty
}

data class VerificationSubmitData(
    val shipmentId: String,
    val scannedTracking: String,
    val items: List<ItemVerificationState>
)

/** Builds and checks the body of POST /api/scan/complete the way server/register-rules.ts expects it. */
object ScanPayload {

    /** Issue categories whose reason the scanner must type, so the claim team can read what happened. */
    private val NOTES_REQUIRED = setOf(IssueCategory.CODE_WRONG, IssueCategory.CODE_OTHER)

    /** The first problem with a line, in words for the scanner, or null when the line can be saved. */
    fun problemWith(item: ItemVerificationState, label: String): String? {
        val category = item.category
        if (!item.physicalChecked) return "Please check physical condition inspected for $label"
        if (item.receivedQty < 0 || item.receivedQty > item.expectedQty) {
            return "$label: received quantity must be from 0 to ${item.expectedQty}"
        }
        if (category.isMissing) {
            if (item.receivedQty >= item.expectedQty) {
                return "$label: lower the received quantity to the units that are missing"
            }
        } else if (item.receivedQty != item.expectedQty) {
            return "$label: ${item.expectedQty - item.receivedQty} unit(s) not received. Choose Missing Component to report them"
        }
        if (category.requiresSubIssue && item.subIssueId.isNullOrBlank()) {
            return "Please select which component is missing for $label"
        }
        if (category.requiresTicket && item.ticketCode.isBlank()) {
            return "$label: ${category.label} needs a ticket ID"
        }
        if (category.code in NOTES_REQUIRED && item.notes.isBlank()) {
            return "Please enter notes explaining the issue for $label"
        }
        return null
    }

    fun build(
        shipmentId: Int,
        clientScanKey: String,
        scannedTracking: String,
        items: List<ItemVerificationState>
    ): JSONObject {
        val itemsArray = JSONArray()
        for (item in items) {
            val issues = JSONArray()
            if (item.hasIssue) {
                val category = item.category
                val subIssue = item.subIssueId?.toIntOrNull()
                val issue = JSONObject()
                issue.put("categoryCode", category.code)
                if (category.allowsSubIssue && subIssue != null) {
                    issue.put("subIssueId", subIssue)
                } else {
                    issue.put("subIssueId", JSONObject.NULL)
                }
                issue.put("qty", item.issueQty)
                issue.put("ticketCode", if (category.requiresTicket) item.ticketCode.trim() else "")
                issue.put("notes", item.notes.trim())
                issues.put(issue)
            }
            val line = JSONObject()
            line.put("itemId", item.itemId.toIntOrNull() ?: 0)
            line.put("receivedQty", item.receivedQty)
            line.put("verified", item.physicalChecked)
            line.put("issues", issues)
            itemsArray.put(line)
        }

        val body = JSONObject()
        body.put("shipmentId", shipmentId)
        body.put("clientScanKey", clientScanKey)
        body.put("scannedTracking", scannedTracking)
        body.put("notes", "")
        body.put("photoCount", 0)
        body.put("hasVideo", false)
        body.put("items", itemsArray)
        return body
    }
}
