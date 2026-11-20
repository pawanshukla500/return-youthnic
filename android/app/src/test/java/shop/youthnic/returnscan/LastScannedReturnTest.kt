package shop.youthnic.returnscan

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import shop.youthnic.returnscan.data.LastScannedReturn
import java.io.File

/**
 * The remembered "last scanned" return pre-fills the claim screen. It used to be written field by field, skipping
 * blanks, so a scan without a flyer kept the previous return's flyer (and SKU, issue, ...) beside the new AWB, and that
 * mix was typed into the Meesho ticket. Logout kept it too. Test data is synthetic: every value starts with SYN-, apart
 * from the protocol issue code.
 */
class LastScannedReturnTest {

    private val store = mutableMapOf<String, Any?>()
    private val editor = MapEditor(store)

    private val appDir: File = listOf(File("."), File("app"), File("android/app"))
        .first { File(it, "src/main/res/values/strings.xml").isFile }

    private fun writeFirstReturn() {
        LastScannedReturn.write(
            editor,
            awb = " SYN-AWB-0001 ",
            orderId = "SYN-ORDER-1",
            subOrderId = "SYN-SUB-1",
            flyerId = "SYN-FLYER-1",
            marketplace = "SYN-Meesho",
            productTitle = "SYN Cotton Kurta",
            sku = "SYN-LISTING-1",
            masterSku = "SYN-MASTER-1",
            imageUrl = "https://example.invalid/syn.jpg",
            issueCode = "missing_component"
        )
    }

    @Test
    fun eachFieldIsStoredUnderItsOwnKeyTrimmed() {
        writeFirstReturn()

        assertEquals("SYN-AWB-0001", store[LastScannedReturn.AWB])
        assertEquals("SYN-ORDER-1", store[LastScannedReturn.ORDER_ID])
        assertEquals("SYN-SUB-1", store[LastScannedReturn.SUB_ORDER_ID])
        assertEquals("SYN-FLYER-1", store[LastScannedReturn.FLYER_ID])
        assertEquals("SYN-Meesho", store[LastScannedReturn.MARKETPLACE])
        assertEquals("SYN Cotton Kurta", store[LastScannedReturn.PRODUCT_TITLE])
        assertEquals("SYN-LISTING-1", store[LastScannedReturn.SKU])
        assertEquals("SYN-MASTER-1", store[LastScannedReturn.MASTER_SKU])
        assertEquals("https://example.invalid/syn.jpg", store[LastScannedReturn.IMAGE_URL])
        assertEquals("missing_component", store[LastScannedReturn.ISSUE_CODE])
    }

    @Test
    fun aScanWithoutAFlyerClearsThePreviousFlyer() {
        writeFirstReturn()

        // The next return has no flyer, and the scanner knows only its AWB and order so far.
        LastScannedReturn.write(editor, awb = "SYN-AWB-0002", orderId = "SYN-ORDER-2")

        assertEquals("SYN-AWB-0002", store[LastScannedReturn.AWB])
        assertEquals("SYN-ORDER-2", store[LastScannedReturn.ORDER_ID])
        assertEquals("", store[LastScannedReturn.FLYER_ID])
        // Nothing else of the first return is left beside the second one either.
        for (key in LastScannedReturn.KEYS - LastScannedReturn.AWB - LastScannedReturn.ORDER_ID) {
            assertEquals("$key kept the previous return's value", "", store[key])
        }
    }

    @Test
    fun aSaveRemovesTheCustomerAndPriceAnOlderBuildStored() {
        store["last_scanned_customer_name"] = "SYN-Customer"
        store["last_scanned_total_price"] = 499f

        LastScannedReturn.write(editor, awb = "SYN-AWB-0003")

        for (key in LastScannedReturn.RETIRED_KEYS) assertFalse("$key was kept", store.containsKey(key))
    }

    @Test
    fun logoutClearsEveryLastScannedKeyAndNothingElse() {
        store["sound_enabled"] = true
        writeFirstReturn()
        store["last_scanned_customer_name"] = "SYN-Customer"
        store["last_scanned_total_price"] = 499f

        LastScannedReturn.clear(editor)

        for (key in LastScannedReturn.KEYS + LastScannedReturn.RETIRED_KEYS) {
            assertFalse("$key survived logout", store.containsKey(key))
        }
        assertEquals(true, store["sound_enabled"])
    }

    @Test
    fun clearSessionClearsTheLastScannedReturn() {
        // SessionManager needs the Android Keystore, so a unit test reads its source: logout (and an expired session,
        // which also ends in clearSession) must clear the remembered return.
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/data/SessionManager.kt").readText()
        val clearSession = source.substringAfter("fun clearSession()").substringBefore("\n    }")
        assertTrue("clearSession must call LastScannedReturn.clear", clearSession.contains("LastScannedReturn.clear("))
    }

    /** A SharedPreferences.Editor over a plain map, so the real write code runs without a device. */
    private class MapEditor(private val store: MutableMap<String, Any?>) : SharedPreferences.Editor {
        override fun putString(key: String, value: String?): SharedPreferences.Editor {
            store[key] = value
            return this
        }

        override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor {
            store[key] = values
            return this
        }

        override fun putInt(key: String, value: Int): SharedPreferences.Editor {
            store[key] = value
            return this
        }

        override fun putLong(key: String, value: Long): SharedPreferences.Editor {
            store[key] = value
            return this
        }

        override fun putFloat(key: String, value: Float): SharedPreferences.Editor {
            store[key] = value
            return this
        }

        override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor {
            store[key] = value
            return this
        }

        override fun remove(key: String): SharedPreferences.Editor {
            store.remove(key)
            return this
        }

        override fun clear(): SharedPreferences.Editor {
            store.clear()
            return this
        }

        override fun commit(): Boolean = true

        override fun apply() {}
    }
}
