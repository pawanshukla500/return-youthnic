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

private fun JSONArray?.strings(): List<String> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) {
            optString(index).takeIf { it.isNotBlank() }?.let(::add)
        }
    }
}
