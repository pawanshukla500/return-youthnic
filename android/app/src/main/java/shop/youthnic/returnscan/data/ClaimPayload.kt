package shop.youthnic.returnscan.data

import org.json.JSONObject

/** What the claim form shows when the operator taps Submit. Every value is read from the form itself. */
data class ClaimFormInput(
    val subOrderId: String,
    val awb: String,
    val packetId: String,
    val packetState: String,
    val issueCode: String,
    val issueLabel: String,
    val title: String,
    val content: String,
    val templateId: Int? = null
)

/**
 * Builds the body of POST /api/claims/unified-create (server/claim-automation-routes.ts).
 *
 * The return's own details (its scan, expected return, customer, price, SKU and missing amount) come only from a server
 * lookup that found the return the form shows. Without one there is no body, so the claim is not sent. The app used to
 * invent a lookup when the real one failed (a found Meesho return with a remembered customer and price) and fall back to
 * an earlier return's SKU, and those values reached the Meesho ticket.
 */
object ClaimPayload {

    /** What the claim form identifies its return by: the sub order, or the AWB when there is none. */
    private fun formKey(subOrderId: String, awb: String): String = subOrderId.trim().ifBlank { awb.trim() }

    /**
     * [lookup] when it found a return and the form still shows the sub order (or AWB) that lookup filled in, otherwise
     * null. A search that found nothing, or a lookup for a sub order the operator has since changed, supplies nothing.
     */
    fun confirmedLookup(lookup: ClaimReturnLookup?, subOrderId: String, awb: String): ClaimReturnLookup? {
        if (lookup == null || !lookup.found) return null
        val key = formKey(subOrderId, awb)
        val lookupKey = formKey(lookup.subOrderId.ifBlank { lookup.orderId }, lookup.awb.ifBlank { lookup.trackingNumber })
        return lookup.takeIf { key.isNotBlank() && key.equals(lookupKey, ignoreCase = true) }
    }

    /** The SKU a claim names: the looked-up return's first item, master SKU first. Blank without a lookup. */
    fun sku(lookup: ClaimReturnLookup?): String {
        val item = lookup?.items?.firstOrNull() ?: return ""
        return item.masterSku.ifBlank { item.sku }
    }

    /** The request body, or null when [lookup] is not a confirmed lookup for the return on [form]. */
    fun build(lookup: ClaimReturnLookup?, form: ClaimFormInput): JSONObject? {
        val found = confirmedLookup(lookup, form.subOrderId, form.awb) ?: return null
        return JSONObject().apply {
            val scanId = found.scanId
            if (scanId != null && scanId > 0) put("receiptScanId", scanId)
            if (found.expectedReturnId > 0) put("expectedReturnId", found.expectedReturnId)
            put("claimReason", form.issueLabel)
            put("marketplaceIssueCode", form.issueCode)
            put("claimTitle", form.title)
            put("claimDescription", form.content)
            put("claimContent", form.content)
            put("remarks", "")
            val templateId = form.templateId
            if (templateId != null && templateId > 0) put("claimTemplateId", templateId)
            put("customerName", found.customerName)
            put("totalPrice", found.totalPrice)
            put("shippedDate", found.shippedDate ?: "")
            put("sku", sku(found))
            put("subOrderId", form.subOrderId)
            put("packetState", form.packetState)
            put("packetId", form.packetId)
            put("awb", form.awb)
            put("missingAmount", found.missingAmount)
        }
    }
}
