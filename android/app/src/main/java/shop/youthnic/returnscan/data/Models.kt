package shop.youthnic.returnscan.data

import org.json.JSONArray
import org.json.JSONObject

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
    val status: String
) {
    companion object {
        fun fromJson(json: JSONObject): MarketplaceAccount {
            val name = json.optString("name", "")
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
                activeRows = json.optInt("activeRows", json.optInt("active_rows", 0)),
                status = json.optString("status", "Active lookup available")
            )
        }
    }
}

data class ShiftProgress(
    val scansToday: Int,
    val issuesToday: Int,
    val clearRate: String
) {
    val scannedToday: Int get() = scansToday
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
    constructor(id: Int, label: String, categoryCode: String) : this(id.toString(), label, categoryCode)
    companion object {
        fun fromJson(json: JSONObject): SubIssue {
            return SubIssue(
                id = json.optString("id", json.optInt("id", 0).toString()),
                name = json.optString("name", json.optString("label", "")),
                categoryCode = json.optString("categoryCode", "")
            )
        }
    }
}

data class ScanSessionData(
    val shift: ShiftProgress,
    val accounts: List<MarketplaceAccount>,
    val categories: List<IssueCategory>,
    val subIssues: List<SubIssue>
) {
    val shiftProgress: ShiftProgress get() = shift
    val missingComponents: List<SubIssue> get() = subIssues.filter { it.categoryCode.contains("MISSING", ignoreCase = true) || it.categoryCode.isEmpty() }
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
    var receivedQty: Int = 1,
    val color: String = "",
    val size: String = "",
    var physicalChecked: Boolean = false,
    var selectedCategoryCode: String = "clear",
    var selectedSubIssueId: Int? = null,
    var itemNotes: String = ""
) {
    val quantity: Int get() = expectedQty
    val masterSku: String get() = productSku

    constructor(
        itemId: String,
        marketplaceSku: String,
        masterSku: String,
        title: String,
        quantity: Int,
        imageUrl: String
    ) : this(
        itemId = itemId,
        orderItemId = "",
        shipmentId = "",
        marketplaceSku = marketplaceSku,
        productSku = masterSku,
        title = title,
        imageUrl = imageUrl,
        expectedQty = quantity,
        receivedQty = quantity,
        color = "",
        size = ""
    )

    companion object {
        fun fromJson(json: JSONObject): LookupItem {
            val exp = json.optInt("expectedQty", json.optInt("expected_units", 1))
            return LookupItem(
                itemId = json.optString("itemId", json.optString("id", "0")),
                orderItemId = json.optString("orderItemId", json.optString("order_item_id", "")),
                shipmentId = json.optString("shipmentId", json.optString("shipment_id", "")),
                marketplaceSku = json.optString("marketplaceSku", json.optString("marketplace_sku", "")),
                productSku = json.optString("productSku", json.optString("sku", "")),
                title = json.optString("title", json.optString("name", "Product Item")),
                imageUrl = json.optString("imageUrl", json.optString("image_url", "")),
                expectedQty = exp,
                receivedQty = exp,
                color = json.optString("color", ""),
                size = json.optString("size", "")
            )
        }
    }
}

data class DuplicateDetails(
    val scannedAt: String,
    val scannedBy: String,
    val outcome: String
)

data class LookupResult(
    val matched: Boolean,
    val matchLeg: String,
    val marketplace: String,
    val account: String,
    val shipmentId: String,
    val tracking: String,
    val orderId: String,
    val shipmentCode: String,
    val carrier: String,
    val returnType: String,
    val returnReason: String,
    val items: List<LookupItem>,
    val duplicate: Boolean,
    val duplicateDetails: DuplicateDetails?
) {
    val status: String
        get() = when {
            duplicate -> "DUPLICATE"
            matched -> "FOUND"
            else -> "NOT_FOUND"
        }

    val trackingNumber: String
        get() = tracking

    val sku: String get() = items.firstOrNull()?.marketplaceSku.orEmpty()
    val masterSku: String get() = items.firstOrNull()?.productSku.orEmpty()
    val productTitle: String get() = items.firstOrNull()?.title.orEmpty()
    val expectedQty: Int get() = items.firstOrNull()?.expectedQty ?: 1
    val imageUrl: String get() = items.firstOrNull()?.imageUrl.orEmpty()

    companion object {
        fun fromJson(json: JSONObject, fallbackTracking: String): LookupResult {
            val itemsArray = json.optJSONArray("items") ?: JSONArray()
            val parsedItems = mutableListOf<LookupItem>()
            for (i in 0 until itemsArray.length()) {
                val itemObj = itemsArray.optJSONObject(i)
                if (itemObj != null) {
                    parsedItems.add(LookupItem.fromJson(itemObj))
                }
            }

            val dupObj = json.optJSONObject("duplicateDetails")
            val duplicateDetails = if (dupObj != null) {
                DuplicateDetails(
                    scannedAt = dupObj.optString("scannedAt", ""),
                    scannedBy = dupObj.optString("scannedBy", ""),
                    outcome = dupObj.optString("outcome", "")
                )
            } else null

            return LookupResult(
                matched = json.optBoolean("matched", false),
                matchLeg = json.optString("matchLeg", "return"),
                marketplace = json.optString("marketplace", ""),
                account = json.optString("account", ""),
                shipmentId = json.optString("shipmentId", json.optString("shipment_id", "0")),
                tracking = json.optString("tracking", fallbackTracking),
                orderId = json.optString("orderId", json.optString("order_id", "")),
                shipmentCode = json.optString("shipmentCode", json.optString("shipment_id", "")),
                carrier = json.optString("carrier", json.optString("courier_partner", "Standard Carrier")),
                returnType = json.optString("returnType", json.optString("type_of_return", "Customer Return")),
                returnReason = json.optString("returnReason", json.optString("reason", "Customer Return")),
                items = parsedItems,
                duplicate = json.optBoolean("duplicate", false),
                duplicateDetails = duplicateDetails
            )
        }
    }
}

data class ScanReceipt(
    val id: Int,
    val scanKey: String,
    val status: String,
    val outcome: String,
    val scannedAt: String
) {
    companion object {
        fun fromJson(json: JSONObject): ScanReceipt {
            return ScanReceipt(
                id = json.optInt("id", 0),
                scanKey = json.optString("scanKey", json.optString("scan_key", "")),
                status = json.optString("status", "Saved"),
                outcome = json.optString("outcome", "clear"),
                scannedAt = json.optString("scannedAt", json.optString("scanned_at", ""))
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

class ApiException(val code: Int, message: String) : Exception("HTTP $code: $message")
class AuthExpiredException(message: String = "Session expired. Sign in again.") : Exception(message)
class NetworkException(message: String, cause: Throwable? = null) : Exception(message, cause)
