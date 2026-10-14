package shop.youthnic.returnscan.data

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Reads a count the server may send as a number or as formatted text such as "1,234".
 * The scan session sends its shift counts as text (see presentShift in server/register-service.ts).
 */
internal fun JSONObject.countOf(vararg keys: String): Int {
    for (key in keys) {
        if (!has(key) || isNull(key)) continue
        val value = opt(key)
        if (value is Number) return value.toInt()
        val digits = value.toString().filter { it.isDigit() }
        if (digits.isNotEmpty()) return digits.toIntOrNull() ?: 0
    }
    return 0
}

data class User(
    val id: Int,
    val name: String,
    val email: String,
    val role: String,
    val sidebarLabel: String
) {
    val fullName: String get() = name
    companion object {
        fun fromJson(json: JSONObject): User {
            return User(
                id = json.optInt("id", 0),
                name = json.optString("name", json.optString("fullName", "")),
                email = json.optString("email", ""),
                role = json.optString("role", "Scanner"),
                sidebarLabel = json.optString("sidebarLabel", json.optString("sidebar_label", ""))
            )
        }
    }
}

data class LoginResponse(
    val token: String,
    val user: User,
    val expiresAt: String,
    val rememberDevice: Boolean
) {
    companion object {
        fun fromJson(json: JSONObject): LoginResponse {
            val userObj = json.optJSONObject("user") ?: JSONObject()
            return LoginResponse(
                token = json.optString("token", ""),
                user = User.fromJson(userObj),
                expiresAt = json.optString("expiresAt", ""),
                rememberDevice = json.optBoolean("rememberDevice", false)
            )
        }
    }
}

data class MarketplaceAccount(
    val id: Int,
    val name: String,
    val color: String,
    val activeRows: Int,
    val status: String,
    val marketplace: String = ""
) {
    /** Scannable returns for the account, or -1 when the server does not report it (GET /api/accounts sends id and name only). */
    val scannableCount: Int get() = activeRows
    val hasScannableCount: Boolean get() = activeRows >= 0
    val accountIdStr: String get() = id.toString()

    companion object {
        fun fromJson(json: JSONObject): MarketplaceAccount {
            val name = json.optString("name", "")
            val marketplace = json.optString("marketplace", name)
            val color = when {
                name.contains("meesho", ignoreCase = true) -> "#E01A59"
                name.contains("flipkart", ignoreCase = true) -> "#2874F0"
                name.contains("amazon", ignoreCase = true) -> "#FF9900"
                name.contains("myntra", ignoreCase = true) -> "#F13AB1"
                name.contains("ajio", ignoreCase = true) -> "#2C4152"
                else -> "#0E5847"
            }
            return MarketplaceAccount(
                id = json.optInt("id", 0),
                name = name,
                color = json.optString("color", color),
                activeRows = json.optInt("activeRows", json.optInt("active_rows", -1)),
                status = json.optString("status", "Active lookup available"),
                marketplace = marketplace
            )
        }
    }
}

data class ShiftProgress(
    val scansToday: Int,
    val issuesToday: Int,
    val clearRate: String,
    /** Units sent for ironing today. Iron Send is operational: those returns are counted as correct, not as issues. */
    val ironSendToday: Int = 0
) {
    val scannedToday: Int get() = scansToday

    companion object {
        /** Parses the `shift` object of GET /api/scan/session: scanned, correct, issues, accuracy (all text). */
        fun fromJson(json: JSONObject?): ShiftProgress {
            if (json == null) return ShiftProgress(0, 0, "100%")
            return ShiftProgress(
                scansToday = json.countOf("scanned", "scansToday"),
                issuesToday = json.countOf("issues", "issuesToday"),
                clearRate = json.optString("accuracy", json.optString("clearRate", "100%")),
                ironSendToday = json.countOf("ironSend")
            )
        }
    }
}

data class IssueCategory(
    val code: String,
    val label: String,
    val isClear: Boolean,
    val isMissing: Boolean,
    val requiresTicket: Boolean,
    val allowsSubIssue: Boolean,
    val requiresSubIssue: Boolean
) {
    companion object {
        /** The category the server seeds as "no issue" (is_clear). It is never sent as an issue. */
        const val CODE_NO_ISSUE = "no_issue"
        const val CODE_IRON_SEND = "iron_send"
        const val CODE_MISSING = "missing_component"
        const val CODE_WRONG = "wrong_product"
        const val CODE_DAMAGED = "damaged_product"
        const val CODE_SKU_CHANGE = "sku_change"
        const val CODE_SIZE_CHANGE = "size_change"
        const val CODE_OTHER = "other_issue"

        fun fromJson(json: JSONObject): IssueCategory {
            return IssueCategory(
                code = json.optString("code", ""),
                label = json.optString("label", ""),
                isClear = json.optBoolean("isClear", false),
                isMissing = json.optBoolean("isMissing", false),
                requiresTicket = json.optBoolean("requiresTicket", false),
                allowsSubIssue = json.optBoolean("allowsSubIssue", false),
                requiresSubIssue = json.optBoolean("requiresSubIssue", false)
            )
        }
    }
}

data class SubIssue(
    val id: String,
    val name: String,
    val categoryCode: String = ""
) {
    val label: String get() = name

    companion object {
        fun fromJson(json: JSONObject): SubIssue {
            return SubIssue(
                id = json.optString("id", "0"),
                name = json.optString("label", json.optString("name", "")),
                categoryCode = json.optString("categoryCode", "")
            )
        }
    }
}

data class ScanSessionData(
    val shift: ShiftProgress = ShiftProgress(0, 0, "100%"),
    val accounts: List<MarketplaceAccount> = emptyList(),
    val categories: List<IssueCategory> = emptyList(),
    val subIssues: List<SubIssue> = emptyList()
) {
    val shiftProgress: ShiftProgress get() = shift

    fun categoryOf(code: String): IssueCategory? = categories.firstOrNull { it.code == code }

    fun subIssuesFor(categoryCode: String): List<SubIssue> = subIssues.filter { it.categoryCode == categoryCode }
}

data class LookupItem(
    val itemId: String,
    val orderItemId: String = "",
    val shipmentId: String = "",
    val marketplaceSku: String = "",
    val productSku: String = "",
    val title: String = "",
    val imageUrl: String = "",
    val expectedQty: Int = 1,
    val color: String = "",
    val keyDetail: String = ""
) {
    val quantity: Int get() = expectedQty
    val masterSku: String get() = productSku

    /** Colour and key detail (for example the size), for the line under the SKU. */
    val detailLine: String get() = listOf(color, keyDetail).filter { it.isNotBlank() }.joinToString(" · ")

    companion object {
        fun fromJson(json: JSONObject): LookupItem {
            return LookupItem(
                itemId = json.optString("itemId", json.optString("id", "0")),
                orderItemId = json.optString("orderItemId", ""),
                shipmentId = json.optString("shipmentId", ""),
                marketplaceSku = json.optString("marketplaceSku", ""),
                productSku = json.optString("productSku", ""),
                title = json.optString("productName", json.optString("title", "")),
                imageUrl = json.optString("imageUrl", ""),
                expectedQty = json.optInt("expectedQty", 1),
                color = json.optString("colorName", ""),
                keyDetail = json.optString("keyDetail", "")
            )
        }
    }
}

data class DuplicateDetails(
    val scannedAt: String,
    val scannedBy: String,
    val outcome: String
)

/** One of several returns that share an AWB. The scanner picks one, and the lookup is repeated with its shipmentId. */
data class LookupCandidate(
    val shipmentId: Int,
    val accountName: String,
    val orderId: String,
    val itemCount: Int,
    val alreadyReceived: Boolean,
    val receivedAt: String,
    val scannedBy: String
) {
    companion object {
        fun fromJson(json: JSONObject): LookupCandidate {
            return LookupCandidate(
                shipmentId = json.optInt("shipmentId", 0),
                accountName = json.optString("accountName", ""),
                orderId = json.optString("orderId", ""),
                itemCount = json.optInt("itemCount", 0),
                alreadyReceived = json.optBoolean("alreadyReceived", false),
                receivedAt = json.optString("receivedAt", ""),
                scannedBy = json.optString("scannedBy", "")
            )
        }
    }
}

/**
 * The answer of POST /api/scan/lookup. The server sends one of
 *   {status: "found", trackingId, shipment: {...}}
 *   {status: "duplicate", trackingId, marketplace, time, scannedBy}
 *   {status: "choose", trackingId, candidates: [...]}
 *   {status: "not_found", trackingId}
 */
data class LookupResult(
    val status: String,
    val tracking: String,
    val shipmentId: String = "",
    val marketplace: String = "",
    val orderId: String = "",
    val carrier: String = "",
    val returnType: String = "",
    val returnReason: String = "",
    val matchLeg: String = "",
    val items: List<LookupItem> = emptyList(),
    val duplicateDetails: DuplicateDetails? = null,
    val candidates: List<LookupCandidate> = emptyList()
) {
    val trackingNumber: String get() = tracking
    val matched: Boolean get() = status == STATUS_FOUND
    val duplicate: Boolean get() = status == STATUS_DUPLICATE

    companion object {
        const val STATUS_FOUND = "FOUND"
        const val STATUS_DUPLICATE = "DUPLICATE"
        const val STATUS_CHOOSE = "CHOOSE"
        const val STATUS_NOT_FOUND = "NOT_FOUND"

        fun fromJson(json: JSONObject, fallbackTracking: String): LookupResult {
            val status = json.optString("status", "not_found").trim().uppercase(Locale.ROOT)
            val tracking = json.optString("trackingId", fallbackTracking)
            val shipment = json.optJSONObject("shipment") ?: JSONObject()

            val items = ArrayList<LookupItem>()
            val itemsArray = shipment.optJSONArray("items") ?: JSONArray()
            for (i in 0 until itemsArray.length()) {
                val itemObj = itemsArray.optJSONObject(i)
                if (itemObj != null) items.add(LookupItem.fromJson(itemObj))
            }

            val candidates = ArrayList<LookupCandidate>()
            val candidateArray = json.optJSONArray("candidates") ?: JSONArray()
            for (i in 0 until candidateArray.length()) {
                val candidateObj = candidateArray.optJSONObject(i)
                if (candidateObj != null) candidates.add(LookupCandidate.fromJson(candidateObj))
            }

            val duplicateDetails = if (status == STATUS_DUPLICATE) {
                DuplicateDetails(
                    scannedAt = json.optString("time", ""),
                    scannedBy = json.optString("scannedBy", ""),
                    outcome = ""
                )
            } else {
                null
            }

            return LookupResult(
                status = status,
                tracking = tracking,
                shipmentId = shipment.optString("shipmentId", ""),
                marketplace = shipment.optString("marketplace", json.optString("marketplace", "")),
                orderId = shipment.optString("orderId", ""),
                carrier = shipment.optString("courier", ""),
                returnType = shipment.optString("returnType", ""),
                returnReason = shipment.optString("returnReason", ""),
                matchLeg = shipment.optString("matchedLeg", ""),
                items = items,
                duplicateDetails = duplicateDetails,
                candidates = candidates
            )
        }
    }
}

/** The answer of POST /api/scan/complete: {replayed, scan: {id, status, scannedAt, ...}, itemCount, issueCount, shift}. */
data class ScanReceipt(
    val id: Int,
    val scanKey: String,
    val status: String,
    val outcome: String,
    val scannedAt: String,
    val issueCount: Int = 0,
    val replayed: Boolean = false,
    /** Units sent for ironing in this scan. Iron Send is not an issue (issueCount does not include it). */
    val ironSendQty: Int = 0,
    val scannedToday: Int = -1
) {
    companion object {
        fun fromJson(json: JSONObject): ScanReceipt {
            val scan = json.optJSONObject("scan") ?: json
            val issues = json.optInt("issueCount", 0)
            val shift = json.optJSONObject("shift")
            return ScanReceipt(
                id = scan.optInt("id", 0),
                scanKey = scan.optString("scanKey", scan.optString("scan_key", "")),
                status = scan.optString("status", "Saved"),
                outcome = if (issues > 0) "issue" else "clear",
                scannedAt = scan.optString("scannedAt", scan.optString("scanned_at", "")),
                issueCount = issues,
                replayed = json.optBoolean("replayed", false),
                ironSendQty = json.optInt("ironSendQty", 0),
                scannedToday = shift?.countOf("scanned", "scansToday") ?: -1
            )
        }
    }
}

data class RecentScan(
    val id: Int = 0,
    val awb: String,
    val marketplace: String,
    val carrier: String = "",
    val outcome: String = "clear",
    val timestamp: String = "",
    val units: Int = 1,
    val courier: String = carrier,
    val itemsSummary: String = ""
)

data class AppRelease(
    val versionCode: Int,
    val versionName: String,
    val downloadUrl: String,
    val notes: String = "",
    val minRequiredVersionCode: Int = 10000,
    val minSupportedVersionCode: Int = minRequiredVersionCode,
    val sha256: String = "",
    val sizeBytes: Long = 0L,
    val publishedAt: String = "",
    val pageUrl: String = ""
) {
    fun isNewerThan(currentCode: Int): Boolean = versionCode > currentCode
    fun isRequiredFor(currentCode: Int): Boolean = currentCode < minRequiredVersionCode

    companion object {
        fun fromJson(json: JSONObject): AppRelease {
            val minReq = json.optInt("minRequiredVersionCode", json.optInt("minSupportedVersionCode", 10000))
            return AppRelease(
                versionCode = json.optInt("versionCode", 10001),
                versionName = json.optString("versionName", "1.0.1"),
                downloadUrl = json.optString("downloadUrl", ""),
                notes = json.optString("notes", ""),
                minRequiredVersionCode = minReq,
                minSupportedVersionCode = minReq,
                sha256 = json.optString("sha256", ""),
                sizeBytes = json.optLong("sizeBytes", 0L),
                publishedAt = json.optString("publishedAt", ""),
                pageUrl = json.optString("pageUrl", "")
            )
        }
    }
}

class ApiException(val code: Int, message: String) : Exception(message)
class AuthExpiredException(message: String = "Session expired. Sign in again.") : Exception(message)
class NetworkException(message: String, cause: Throwable? = null) : Exception(message, cause)
