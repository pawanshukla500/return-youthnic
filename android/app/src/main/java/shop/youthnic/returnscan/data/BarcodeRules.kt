package shop.youthnic.returnscan.data

import android.os.SystemClock
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

    fun generateClientScanKey(accountId: Int, tracking: String): String = generateClientScanKey()
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
    fun shouldProcess(code: String): Boolean {
        val now = SystemClock.elapsedRealtime()
        if (now - anyCodeTimestamp < anyCodeCooldownMs) {
            return false
        }
        if (code == lastCode && (now - lastCodeTimestamp < sameCodeSuppressMs)) {
            return false
        }
        lastCode = code
        lastCodeTimestamp = now
        anyCodeTimestamp = now
        return true
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
