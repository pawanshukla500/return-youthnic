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
 * The bench scan File Claim saved before it opened the claim screen (ReturnVerificationBottomSheet): its register row id
 * and the return it was saved for, by the sub order (or order) and AWB the scanner had. A claim filed from the bench is
 * filed on this scan and on no other.
 */
data class BenchScan(val scanId: Int, val subOrderId: String, val awb: String) {
    /** True when [lookup] is the return this scan was saved for: the same sub order (or order), or the same AWB. */
    fun isFor(lookup: ClaimReturnLookup): Boolean =
        same(subOrderId, lookup.subOrderId.ifBlank { lookup.orderId }) || same(awb, lookup.awb) || same(awb, lookup.trackingNumber)

    private fun same(mine: String, theirs: String): Boolean =
        mine.isNotBlank() && mine.trim().equals(theirs.trim(), ignoreCase = true)
}

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

    /** The same key for a lookup: the sub order (or order) it fills in, or its AWB when there is none. */
    fun returnKey(lookup: ClaimReturnLookup): String =
        formKey(lookup.subOrderId.ifBlank { lookup.orderId }, lookup.awb.ifBlank { lookup.trackingNumber })

    /** True when [lookup] is the return [key] ([returnKey]) names, such as the one saved evidence was captured for. */
    fun isReturn(key: String, lookup: ClaimReturnLookup): Boolean =
        key.isNotBlank() && key.equals(returnKey(lookup), ignoreCase = true)

    /**
     * [lookup] when it found a return and the form still shows the sub order (or AWB) that lookup filled in, otherwise
     * null. A search that found nothing, or a lookup for a sub order the operator has since changed, supplies nothing.
     */
    fun confirmedLookup(lookup: ClaimReturnLookup?, subOrderId: String, awb: String): ClaimReturnLookup? {
        if (lookup == null || !lookup.found) return null
        val key = formKey(subOrderId, awb)
        return lookup.takeIf { isReturn(key, it) }
    }

    /**
     * True when [next] is the same return as [previous]. Evidence is captured for [previous] (Proceed only opens the
     * evidence step for a confirmed lookup), so it may stay only when the new lookup is that same return; otherwise the
     * screen drops it, or it would be uploaded with another return's claim.
     */
    fun sameReturn(previous: ClaimReturnLookup?, next: ClaimReturnLookup): Boolean =
        previous != null && isReturn(returnKey(previous), next)

    /** The SKU a claim names: the looked-up return's first item, master SKU first. Blank without a lookup. */
    fun sku(lookup: ClaimReturnLookup?): String {
        val item = lookup?.items?.firstOrNull() ?: return ""
        return item.masterSku.ifBlank { item.sku }
    }

    /**
     * The request body, or null when [lookup] is not a confirmed lookup for the return on [form]. A screen opened by File
     * Claim passes its [bench] scan: the claim is filed on that scan, never on the one the lookup names, and there is no
     * body when the bench scan has no id or the form shows another return.
     */
    fun build(lookup: ClaimReturnLookup?, form: ClaimFormInput, bench: BenchScan? = null): JSONObject? {
        val found = confirmedLookup(lookup, form.subOrderId, form.awb) ?: return null
        if (bench != null && (bench.scanId <= 0 || !bench.isFor(found))) return null
        return JSONObject().apply {
            val scanId = bench?.scanId ?: found.scanId
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
