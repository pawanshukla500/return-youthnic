package shop.youthnic.returnscan

import com.google.mlkit.vision.barcode.common.Barcode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import shop.youthnic.returnscan.data.BarcodeRules
import shop.youthnic.returnscan.data.DuplicateGuard

class BarcodeRulesTest {

    @Test
    fun testValidAwbBarcodesPassQrCheck() {
        assertFalse(BarcodeRules.looksLikeQr("FMPP0982341278"))
        assertFalse(BarcodeRules.looksLikeQr("DELHIVERY12345678"))
        assertFalse(BarcodeRules.looksLikeQr("1490711818486605"))
        assertFalse(BarcodeRules.looksLikeQr("ECOM9911223344"))
        assertFalse(BarcodeRules.looksLikeQr("BLUEDART-88990011"))
    }

    @Test
    fun testQrAndUrlsAreRejected() {
        assertTrue(BarcodeRules.looksLikeQr("https://return.youthnic.shop/api"))
        assertTrue(BarcodeRules.looksLikeQr("http://example.com"))
        assertTrue(BarcodeRules.looksLikeQr("upi://pay?pa=shop@upi&pn=Store"))
        assertTrue(BarcodeRules.looksLikeQr("WIFI:S:MyNetwork;T:WPA;P:secret;;"))
        assertTrue(BarcodeRules.looksLikeQr("hello world with spaces"))
        assertTrue(BarcodeRules.looksLikeQr(""))
        assertTrue(BarcodeRules.looksLikeQr("   "))
    }

    @Test
    fun testLengthBounds() {
        assertTrue(BarcodeRules.looksLikeQr("123"))
        assertTrue(BarcodeRules.looksLikeQr("AWB"))
        val veryLong = "A".repeat(65)
        assertTrue(BarcodeRules.looksLikeQr(veryLong))
    }

    @Test
    fun testBarcodeFormatsFilter() {
        assertTrue(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_CODE_128))
        assertTrue(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_CODE_39))
        assertTrue(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_CODE_93))
        assertTrue(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_CODABAR))
        assertTrue(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_ITF))
        assertTrue(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_EAN_13))
        assertTrue(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_EAN_8))
        assertTrue(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_UPC_A))
        assertTrue(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_UPC_E))

        assertFalse(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_QR_CODE))
        assertFalse(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_DATA_MATRIX))
        assertFalse(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_PDF417))
        assertFalse(BarcodeRules.isAllowed1DFormat(Barcode.FORMAT_AZTEC))
    }

    @Test
    fun testDuplicateGuardSameCodeSuppression() {
        val guard = DuplicateGuard(sameCodeSuppressMs = 8000L, anyCodeCooldownMs = 1500L)
        val awb = "1490711818486605"
        val t0 = 100000L

        assertTrue(guard.shouldProcess(awb, t0))
        guard.markEmitted(awb, t0)

        // Rescanned immediately (500ms later): suppressed
        assertFalse(guard.shouldProcess(awb, t0 + 500))

        // Rescanned 3 seconds later: still suppressed
        assertFalse(guard.shouldProcess(awb, t0 + 3000))

        // Rescanned 9 seconds after last check: allowed
        assertTrue(guard.shouldProcess(awb, t0 + 12000))
    }

    @Test
    fun testDuplicateGuardAnyCodeCooldown() {
        val guard = DuplicateGuard(sameCodeSuppressMs = 8000L, anyCodeCooldownMs = 1500L)
        val awb1 = "AWB1111111"
        val awb2 = "AWB2222222"
        val t0 = 100000L

        assertTrue(guard.shouldProcess(awb1, t0))
        guard.markEmitted(awb1, t0)

        assertFalse(guard.shouldProcess(awb2, t0 + 500))
        assertTrue(guard.shouldProcess(awb2, t0 + 1600))
    }

    @Test
    fun testClientScanKeyAlwaysFitsTheServerRule() {
        // The server accepts only [A-Za-z0-9_-], 8 to 100 characters (isValidClientKey).
        val rule = Regex("^[A-Za-z0-9_-]{8,100}$")
        val longAwb = "SYN-" + "A1/".repeat(40)
        val key = BarcodeRules.generateClientScanKey(12, longAwb)
        assertTrue(key, rule.matches(key))
        assertTrue(key.startsWith("SYN-MOBILE-12-"))

        val plain = BarcodeRules.generateClientScanKey()
        assertTrue(plain, rule.matches(plain))
    }

    @Test
    fun testGenerateClientScanKeyFormat() {
        val key = BarcodeRules.generateClientScanKey("meesho", "1490711818486605")
        assertTrue(key.startsWith("SYN-MOBILE-meesho-"))
        assertTrue(key.contains("1490711818486605"))
    }

    @Test
    fun testAmazonOrderIdExtraction() {
        // Standard hyphenated Amazon order ID
        assertEquals("408-1234567-1234567", BarcodeRules.extractScannedIdentifier("408-1234567-1234567"))
        assertEquals("408-1234567-1234567", BarcodeRules.extractScannedIdentifier("  408-1234567-1234567  \n"))

        // Prefix stripping (#, ORDER#, ORD:)
        assertEquals("408-1234567-1234567", BarcodeRules.extractScannedIdentifier("#408-1234567-1234567"))
        assertEquals("408-1234567-1234567", BarcodeRules.extractScannedIdentifier("ORDER: 408-1234567-1234567"))
        assertEquals("408-1234567-1234567", BarcodeRules.extractScannedIdentifier("ORD#408-1234567-1234567"))

        // 17-digit numeric unhyphenated Amazon order ID
        assertEquals("408-1234567-1234567", BarcodeRules.extractScannedIdentifier("40812345671234567"))

        // Embedded in URL
        assertEquals("408-1234567-1234567", BarcodeRules.extractScannedIdentifier("https://sellercentral.amazon.in/order/408-1234567-1234567"))

        // Standard AWBs pass through unchanged
        assertEquals("FMPP0982341278", BarcodeRules.extractScannedIdentifier("FMPP0982341278"))
    }

    @Test
    fun testSupportedBarcodeFormatsInclude2D() {
        assertTrue(BarcodeRules.isSupportedBarcodeFormat(Barcode.FORMAT_CODE_128))
        assertTrue(BarcodeRules.isSupportedBarcodeFormat(Barcode.FORMAT_QR_CODE))
        assertTrue(BarcodeRules.isSupportedBarcodeFormat(Barcode.FORMAT_DATA_MATRIX))
        assertTrue(BarcodeRules.isSupportedBarcodeFormat(Barcode.FORMAT_PDF417))
        assertFalse(BarcodeRules.isSupportedBarcodeFormat(Barcode.FORMAT_AZTEC))
    }
}
