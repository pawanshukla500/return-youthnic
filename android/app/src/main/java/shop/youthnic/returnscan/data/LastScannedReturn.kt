package shop.youthnic.returnscan.data

import android.content.SharedPreferences

/**
 * The return the scanner handled last, kept so the claim screen can open with it filled in.
 *
 * It is always written whole: every key on every save, blanks included. Writing only the non-blank values let one
 * return's flyer, SKU or issue sit beside the next return's AWB, and that mix reached Meesho on a claim. Logout clears
 * every key, so the next person on the phone never sees the previous person's return.
 */
object LastScannedReturn {
    const val AWB = "last_scanned_awb"
    const val ORDER_ID = "last_scanned_order_id"
    const val SUB_ORDER_ID = "last_scanned_sub_order_id"
    const val FLYER_ID = "last_scanned_flyer_id"
    const val MARKETPLACE = "last_scanned_marketplace"
    const val PRODUCT_TITLE = "last_scanned_product_title"
    const val SKU = "last_scanned_sku"
    const val MASTER_SKU = "last_scanned_master_sku"
    const val IMAGE_URL = "last_scanned_image_url"
    const val ISSUE_CODE = "last_scanned_issue_code"

    /** The keys a save writes. */
    val KEYS: List<String> = listOf(
        AWB, ORDER_ID, SUB_ORDER_ID, FLYER_ID, MARKETPLACE, PRODUCT_TITLE, SKU, MASTER_SKU, IMAGE_URL, ISSUE_CODE
    )

    /**
     * Customer name and price, stored by older builds and only ever read to fill a claim whose lookup had failed. They
     * are no longer stored, and every save and logout removes what an older build left behind.
     */
    val RETIRED_KEYS: List<String> = listOf("last_scanned_customer_name", "last_scanned_total_price")

    /** Writes one return over the previous one. A value left out is stored blank, never kept from an earlier return. */
    fun write(
        editor: SharedPreferences.Editor,
        awb: String,
        orderId: String = "",
        subOrderId: String = "",
        flyerId: String = "",
        marketplace: String = "",
        productTitle: String = "",
        sku: String = "",
        masterSku: String = "",
        imageUrl: String = "",
        issueCode: String = ""
    ): SharedPreferences.Editor {
        val values = listOf(awb, orderId, subOrderId, flyerId, marketplace, productTitle, sku, masterSku, imageUrl, issueCode)
        KEYS.zip(values).forEach { (key, value) -> editor.putString(key, value.trim()) }
        RETIRED_KEYS.forEach { editor.remove(it) }
        return editor
    }

    /** Removes every last-scanned key, retired ones included. Called at logout. */
    fun clear(editor: SharedPreferences.Editor): SharedPreferences.Editor {
        (KEYS + RETIRED_KEYS).forEach { editor.remove(it) }
        return editor
    }
}
