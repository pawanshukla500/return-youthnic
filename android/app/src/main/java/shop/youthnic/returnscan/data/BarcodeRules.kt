package shop.youthnic.returnscan.data

import android.os.SystemClock
import com.google.mlkit.vision.barcode.common.Barcode
import java.util.UUID

object BarcodeRules {

    /**
     * Normalizes scanned barcode: trims leading/trailing whitespace, newlines,
     * but strictly preserves all alphanumeric characters and leading zeros.
     */
    fun normalize(raw: String?): String {
        if (raw == null) return ""
        return raw.trim().replace("\r", "").replace("\n", "").replace("\t", "")
    }

    /**
     * Generates a unique, idempotent scan key for submission to the server.
     * Starts with 'SYN-MOBILE-' to follow project safety rules.
     */
    fun generateClientScanKey(): String {
        val ts = System.currentTimeMillis()
        val rand = UUID.randomUUID().toString().replace("-", "").take(8).uppercase()
        return "SYN-MOBILE-$ts-$rand"
    }

    /**
     * The server accepts only [A-Za-z0-9_-] and 8 to 100 characters (isValidClientKey in server/register-rules.ts). An AWB
     * can be up to 80 characters and may hold other symbols, so the readable parts are cleaned and cut to fit.
     */
    fun generateClientScanKey(account: Any, tracking: String): String {
        val ts = System.currentTimeMillis()
        val rand = UUID.randomUUID().toString().replace("-", "").take(8).uppercase()
        val accountPart = account.toString().filter { isKeyChar(it) }.take(10)
        val trackingPart = tracking.filter { isKeyChar(it) }.take(40)
        return "SYN-MOBILE-$accountPart-$trackingPart-$ts-$rand"
    }

    private fun isKeyChar(c: Char): Boolean = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '_' || c == '-'

    private val AMAZON_ORDER_REGEX = Regex("""\b(\d{3}-\d{7}-\d{7})\b""")
    private val AMAZON_CLEAN_NUMERIC_REGEX = Regex("""\b(\d{17})\b""")

    /**
     * Extracts an actionable tracking ID or Amazon Order ID from raw scanned barcode or QR content.
     * Handles Amazon order barcode formats (e.g. 408-1234567-1234567, 17-digit numeric, ORD#..., or URLs).
     */
    fun extractScannedIdentifier(raw: String?): String {
        if (raw == null) return ""
        var text = raw.trim().replace("\r", "").replace("\n", "").replace("\t", "")
        if (text.isEmpty()) return ""

        // Check if string contains standard Amazon Order ID (3-7-7 digits)
        val amzMatch = AMAZON_ORDER_REGEX.find(text)
        if (amzMatch != null) {
            return amzMatch.groupValues[1]
        }

        // Check if string contains 17-digit Amazon Order ID
        val amzNumeric = AMAZON_CLEAN_NUMERIC_REGEX.find(text)
        if (amzNumeric != null) {
            val digits = amzNumeric.groupValues[1]
            return "${digits.substring(0, 3)}-${digits.substring(3, 10)}-${digits.substring(10, 17)}"
        }

        // Reject payments, WiFi or generic text
        val lower = text.lowercase()
        if (lower.startsWith("upi://") || lower.startsWith("wifi:") || lower.startsWith("mailto:")) {
            return ""
        }

        // If URL, check if orderId or awb parameter is embedded
        if (lower.startsWith("http://") || lower.startsWith("https://")) {
            val urlOrder = AMAZON_ORDER_REGEX.find(text)
            if (urlOrder != null) return urlOrder.groupValues[1]
            return ""
        }

        // Strip prefix tags
        if (text.startsWith("#")) text = text.substring(1).trim()
        if (text.startsWith("ORDER:", ignoreCase = true) || text.startsWith("ORDER#", ignoreCase = true)) {
            text = text.substring(6).trim()
        }
        if (text.startsWith("ORD:", ignoreCase = true) || text.startsWith("ORD#", ignoreCase = true)) {
            text = text.substring(4).trim()
        }

        // Standard length check
        if (text.length in 4..80) {
            return text
        }
        return ""
    }

    fun looksLikeQr(raw: String?): Boolean {
        if (raw == null) return true
        val extracted = extractScannedIdentifier(raw)
        return extracted.isBlank()
    }

    fun isAllowed1DFormat(format: Int): Boolean = when (format) {
        Barcode.FORMAT_CODE_128,
        Barcode.FORMAT_CODE_39,
        Barcode.FORMAT_CODE_93,
        Barcode.FORMAT_CODABAR,
        Barcode.FORMAT_ITF,
        Barcode.FORMAT_EAN_13,
        Barcode.FORMAT_EAN_8,
        Barcode.FORMAT_UPC_A,
        Barcode.FORMAT_UPC_E -> true
        else -> false
    }

    fun isSupportedBarcodeFormat(format: Int): Boolean = isAllowed1DFormat(format) || when (format) {
        Barcode.FORMAT_QR_CODE,
        Barcode.FORMAT_DATA_MATRIX,
        Barcode.FORMAT_PDF417 -> true
        else -> false
    }
}

/**
 * Guards against camera stream frame flooding and duplicate rapid triggers.
 */
class DuplicateGuard(
    private val sameCodeSuppressMs: Long = 8000L,
    private val anyCodeCooldownMs: Long = 800L
) {
    private var lastCode: String = ""
    private var lastCodeTimestamp: Long = 0L
    private var anyCodeTimestamp: Long = 0L

    @Synchronized
    fun shouldProcess(code: String, now: Long = SystemClock.elapsedRealtime()): Boolean {
        if (now - anyCodeTimestamp < anyCodeCooldownMs) {
            return false
        }
        if (code == lastCode && (now - lastCodeTimestamp < sameCodeSuppressMs)) {
            return false
        }
        return true
    }

    @Synchronized
    fun markEmitted(code: String, now: Long = SystemClock.elapsedRealtime()) {
        lastCode = code
        lastCodeTimestamp = now
        anyCodeTimestamp = now
    }

    @Synchronized
    fun forget(code: String) {
        if (lastCode == code) {
            lastCode = ""
            lastCodeTimestamp = 0L
        }
        anyCodeTimestamp = 0L
    }

    @Synchronized
    fun reset() {
        lastCode = ""
        lastCodeTimestamp = 0L
        anyCodeTimestamp = 0L
    }

    @Synchronized
    fun releaseLock() {
        anyCodeTimestamp = 0L
    }
}
