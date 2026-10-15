package shop.youthnic.returnscan.data

import org.json.JSONArray
import org.json.JSONObject

data class ClaimScanResult(
    val scanId: Int,
    val marketplaceId: Int,
    val marketplace: String,
    val trackingId: String,
    val orderId: String,
    val scannedAt: String,
    val hasClaim: Boolean,
    val claimId: Int?
) {
    companion object {
        fun fromJson(json: JSONObject) = ClaimScanResult(
            scanId = json.optInt("scanId"),
            marketplaceId = json.optInt("marketplaceId"),
            marketplace = json.optString("marketplace"),
            trackingId = json.optString("trackingId"),
            orderId = json.optString("orderId"),
            scannedAt = json.optString("scannedAt"),
            hasClaim = json.optBoolean("hasClaim"),
            claimId = json.optInt("claimId").takeIf { it > 0 }
        )
    }
}

data class MeeshoClaimIssue(
    val code: String,
    val label: String,
    val description: String
) {
    companion object {
        fun fromJson(json: JSONObject) = MeeshoClaimIssue(
            code = json.optString("code"),
            label = json.optString("label"),
            description = json.optString("description")
        )
    }
}

data class MeeshoMissingItem(
    val label: String,
    val quantity: Int,
    val amountEach: Double,
    val amount: Double
)

data class MeeshoClaimDraft(
    val scanId: Int,
    val marketplaceId: Int,
    val subOrderId: String,
    val orderId: String,
    val awb: String,
    val packetState: String,
    val packetId: String,
    val flyerState: String,
    val returnType: String,
    val receivedDate: String,
    val dueDate: String,
    val daysRemaining: Int,
    val overdue: Boolean,
    val productNames: List<String>,
    val missingItems: List<MeeshoMissingItem>,
    val missingAmount: Double,
    val issueOptions: List<MeeshoClaimIssue>
) {
    companion object {
        fun fromJson(json: JSONObject): MeeshoClaimDraft {
            val products = json.optJSONArray("productNames").strings()
            val missing = mutableListOf<MeeshoMissingItem>()
            val missingArray = json.optJSONArray("missingItems") ?: JSONArray()
            for (index in 0 until missingArray.length()) {
                val item = missingArray.optJSONObject(index) ?: continue
                missing += MeeshoMissingItem(
                    label = item.optString("label"),
                    quantity = item.optInt("quantity"),
                    amountEach = item.optDouble("amountEach"),
                    amount = item.optDouble("amount")
                )
            }
            val issues = mutableListOf<MeeshoClaimIssue>()
            val issueArray = json.optJSONArray("issueOptions") ?: JSONArray()
            for (index in 0 until issueArray.length()) {
                issueArray.optJSONObject(index)?.let { issues += MeeshoClaimIssue.fromJson(it) }
            }
            return MeeshoClaimDraft(
                scanId = json.optInt("scanId"),
                marketplaceId = json.optInt("marketplaceId"),
                subOrderId = json.optString("subOrderId"),
                orderId = json.optString("orderId"),
                awb = json.optString("awb"),
                packetState = json.optString("packetState", "Tampered"),
                packetId = json.optString("packetId"),
                flyerState = json.optString("flyerState"),
                returnType = json.optString("returnType"),
                receivedDate = json.optString("receivedDate"),
                dueDate = json.optString("dueDate"),
                daysRemaining = json.optInt("daysRemaining"),
                overdue = json.optBoolean("overdue"),
                productNames = products,
                missingItems = missing,
                missingAmount = json.optDouble("missingAmount"),
                issueOptions = issues
            )
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Comprehensive Multi-Marketplace Return Claim Models
// ---------------------------------------------------------------------------------------------------------------

data class ClaimFieldTemplate(
    val fieldKey: String,
    val fieldLabel: String,
    val fieldType: String, // "image", "video", "file"
    val required: Boolean,
    val minCount: Int,
    val maxCount: Int,
    val maxFileSizeMb: Int
) {
    companion object {
        fun fromJson(json: JSONObject) = ClaimFieldTemplate(
            fieldKey = json.optString("fieldKey"),
            fieldLabel = json.optString("fieldLabel"),
            fieldType = json.optString("fieldType", "image"),
            required = json.optBoolean("required", false),
            minCount = json.optInt("minCount", if (json.optBoolean("required")) 1 else 0),
            maxCount = json.optInt("maxCount", 1),
            maxFileSizeMb = json.optInt("maxFileSizeMb", 25)
        )
    }
}

data class ClaimTemplate(
    val id: Int,
    val name: String,
    val description: String,
    val fields: List<ClaimFieldTemplate>
) {
    companion object {
        fun fromJson(json: JSONObject): ClaimTemplate {
            val fieldsList = mutableListOf<ClaimFieldTemplate>()
            val arr = json.optJSONArray("fields") ?: JSONArray()
            for (i in 0 until arr.length()) {
                arr.optJSONObject(i)?.let { fieldsList += ClaimFieldTemplate.fromJson(it) }
            }
            return ClaimTemplate(
                id = json.optInt("id"),
                name = json.optString("name"),
                description = json.optString("description"),
                fields = fieldsList
            )
        }
    }
}

data class ClaimProductItem(
    val itemId: Int,
    val sku: String,
    val masterSku: String,
    val title: String,
    val quantity: Int,
    val imageUrl: String
) {
    companion object {
        fun fromJson(json: JSONObject) = ClaimProductItem(
            itemId = json.optInt("itemId"),
            sku = json.optString("sku"),
            masterSku = json.optString("masterSku"),
            title = json.optString("title"),
            quantity = json.optInt("quantity", 1),
            imageUrl = json.optString("imageUrl")
        )
    }
}

data class ClaimStandardReason(
    val code: String,
    val label: String,
    val suggestedTitle: String,
    val suggestedContent: String
) {
    companion object {
        fun fromJson(json: JSONObject) = ClaimStandardReason(
            code = json.optString("code"),
            label = json.optString("label"),
            suggestedTitle = json.optString("suggestedTitle"),
            suggestedContent = json.optString("suggestedContent")
        )
    }
}

data class ExistingClaimSummary(
    val id: Int,
    val status: String,
    val reason: String,
    val title: String,
    val mediaCount: Int
) {
    companion object {
        fun fromJson(json: JSONObject) = ExistingClaimSummary(
            id = json.optInt("id"),
            status = json.optString("status"),
            reason = json.optString("reason"),
            title = json.optString("title"),
            mediaCount = json.optInt("mediaCount")
        )
    }
}

data class ClaimReturnLookup(
    val found: Boolean,
    val scanId: Int?,
    val expectedReturnId: Int,
    val marketplace: String,
    val marketplaceId: Int,
    val orderId: String,
    val trackingNumber: String,
    val packetId: String,
    val customerName: String,
    val totalPrice: Double,
    val totalAmount: Double,
    val returnStatus: String,
    val shippedDate: String?,
    val daysSinceShipped: Int,
    val existingClaim: ExistingClaimSummary?,
    val items: List<ClaimProductItem>,
    val templates: List<ClaimTemplate>,
    val standardReasons: List<ClaimStandardReason>
) {
    companion object {
        fun fromJson(json: JSONObject): ClaimReturnLookup {
            val itemsList = mutableListOf<ClaimProductItem>()
            val itemsArr = json.optJSONArray("items") ?: JSONArray()
            for (i in 0 until itemsArr.length()) {
                itemsArr.optJSONObject(i)?.let { itemsList += ClaimProductItem.fromJson(it) }
            }

            val templatesList = mutableListOf<ClaimTemplate>()
            val tplArr = json.optJSONArray("templates") ?: JSONArray()
            for (i in 0 until tplArr.length()) {
                tplArr.optJSONObject(i)?.let { templatesList += ClaimTemplate.fromJson(it) }
            }

            val reasonsList = mutableListOf<ClaimStandardReason>()
            val rsnArr = json.optJSONArray("standardReasons") ?: JSONArray()
            for (i in 0 until rsnArr.length()) {
                rsnArr.optJSONObject(i)?.let { reasonsList += ClaimStandardReason.fromJson(it) }
            }

            val existingObj = json.optJSONObject("existingClaim")
            val existing = if (existingObj != null) ExistingClaimSummary.fromJson(existingObj) else null

            return ClaimReturnLookup(
                found = json.optBoolean("found", true),
                scanId = json.optInt("scanId").takeIf { it > 0 },
                expectedReturnId = json.optInt("expectedReturnId"),
                marketplace = json.optString("marketplace"),
                marketplaceId = json.optInt("marketplaceId"),
                orderId = json.optString("orderId"),
                trackingNumber = json.optString("trackingNumber"),
                packetId = json.optString("packetId"),
                customerName = json.optString("customerName", "Customer"),
                totalPrice = json.optDouble("totalPrice", 0.0),
                totalAmount = json.optDouble("totalAmount", 0.0),
                returnStatus = json.optString("returnStatus", "Return Initiated"),
                shippedDate = json.optString("shippedDate").takeIf { it.isNotBlank() },
                daysSinceShipped = json.optInt("daysSinceShipped", 0),
                existingClaim = existing,
                items = itemsList,
                templates = templatesList,
                standardReasons = reasonsList
            )
        }
    }
}

data class UnifiedClaimResult(
    val claimId: Int,
    val jobId: Int?
)

private fun JSONArray?.strings(): List<String> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) {
            optString(index).takeIf { it.isNotBlank() }?.let(::add)
        }
    }
}
