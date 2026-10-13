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

    fun generateClientScanKey(account: Any, tracking: String): String {
        val ts = System.currentTimeMillis()
        val rand = UUID.randomUUID().toString().replace("-", "").take(8).uppercase()
        return "SYN-MOBILE-$account-$tracking-$ts-$rand"
    }

    fun looksLikeQr(raw: String?): Boolean {
        if (raw == null) return true
        val trimmed = raw.trim()
        if (trimmed.length < 4 || trimmed.length > 64) return true
        if (trimmed.contains(" ")) return true
        val lower = trimmed.lowercase()
        if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("upi://") || lower.startsWith("wifi:")) return true
        return false
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
