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
 * and the return it was saved for, by its expected return id (the scanner's shipmentId) and the sub order (or order)
 * and AWB the scanner had. A claim filed from the bench is filed on this scan and on no other.
 */
data class BenchScan(val scanId: Int, val subOrderId: String, val awb: String, val expectedReturnId: Int = 0) {
    /**
     * True when [lookup] is the return this scan was saved for. Several returns can share one parcel AWB (the scanner's
     * "choose" list), so the AWB never decides it when both sides name the return: the expected return id when both
     * have one, else the sub order (or order), and the AWB only when one side has no sub order.
     */
    fun isFor(lookup: ClaimReturnLookup): Boolean {
        if (expectedReturnId > 0 && lookup.expectedReturnId > 0) return expectedReturnId == lookup.expectedReturnId
        val theirSubOrder = lookup.subOrderId.ifBlank { lookup.orderId }
        if (subOrderId.isNotBlank() && theirSubOrder.isNotBlank()) return same(subOrderId, theirSubOrder)
        return same(awb, lookup.awb) || same(awb, lookup.trackingNumber)
    }

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
     * The form's AWB must also be one of the lookup's (either field) when the lookup has one: an AWB scanned or typed
     * over the looked-up one is not checked against the return, and the claim would send it as the ticket's tracking ID.
     */
    fun confirmedLookup(lookup: ClaimReturnLookup?, subOrderId: String, awb: String): ClaimReturnLookup? {
        if (lookup == null || !lookup.found) return null
        val key = formKey(subOrderId, awb)
        val known = listOf(lookup.awb, lookup.trackingNumber).map { it.trim() }.filter { it.isNotBlank() }
        val awbChecked = known.isEmpty() || known.any { it.equals(awb.trim(), ignoreCase = true) }
        return lookup.takeIf { awbChecked && isReturn(key, it) }
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
     * The saved bench scan the claim for the confirmed [lookup] is filed on, or null when there is none. A claim never
     * exists without a saved bench scan (owner decision 2026-11-20), so null blocks Proceed and Submit. File Claim's
     * [bench] scan wins, but only for the return it was saved for; a screen opened another way (the Claims card, no
     * EXTRA_SCAN_ID) files on the scan the lookup found, if the return was saved. An id of 0 or below is no scan.
     */
    fun benchScanIdFor(bench: BenchScan?, lookup: ClaimReturnLookup): Int? {
        if (bench != null) return bench.scanId.takeIf { it > 0 && bench.isFor(lookup) }
        return lookup.scanId?.takeIf { it > 0 }
    }

    /** Said when the return has no saved bench scan and File Claim did not open the screen (the Claims card). */
    const val NO_BENCH_SCAN_MESSAGE =
        "This return has no saved bench scan. Save it on the scanner first (Save or File Claim), then file the claim."

    /**
     * Why the claim for the confirmed [lookup] cannot be filed, or null when it has a saved bench scan ([benchScanIdFor]).
     * On a screen File Claim opened, the form shows another return than the one whose scan File Claim saved. A return
     * that is already saved cannot get File Claim again (a rescan is a duplicate, with no sheet), so the message names
     * the way that works: the Claims card, whose screen files on the searched return's own saved scan.
     */
    fun benchScanBlockMessage(bench: BenchScan?, lookup: ClaimReturnLookup): String? {
        if (benchScanIdFor(bench, lookup) != null) return null
        if (bench == null) return NO_BENCH_SCAN_MESSAGE
        val saved = bench.subOrderId.ifBlank { bench.awb }
        return "File Claim saved the bench scan for $saved, so this screen files the claim for $saved. Search $saved again. " +
            "To claim the other return, open the Claims card and search it there (it needs its own saved bench scan)."
    }

    /**
     * The request body, or null when [lookup] is not a confirmed lookup for the return on [form] or the claim has no saved
     * bench scan to be filed on ([benchScanIdFor]). A screen opened by File Claim passes its [bench] scan: the claim is
     * filed on that scan, never on the one the lookup names, and there is no body when the form shows another return.
     */
    fun build(lookup: ClaimReturnLookup?, form: ClaimFormInput, bench: BenchScan? = null): JSONObject? {
        val found = confirmedLookup(lookup, form.subOrderId, form.awb) ?: return null
        val scanId = benchScanIdFor(bench, found) ?: return null
        return JSONObject().apply {
            put("receiptScanId", scanId)
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
