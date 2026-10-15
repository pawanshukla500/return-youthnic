package shop.youthnic.returnscan.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import shop.youthnic.returnscan.BuildConfig

class SessionManager(private val context: Context) {

    private val prefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "return_secure_session",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (_: Exception) {
        // Fallback to standard private mode SharedPreferences if Keystore is unavailable
        context.getSharedPreferences("return_session_prefs", Context.MODE_PRIVATE)
    }

    var serverUrl: String
        get() {
            val saved = prefs.getString("server_url", "")
            return if (!saved.isNullOrBlank()) saved else BuildConfig.DEFAULT_API_URL
        }
        set(value) {
            val clean = value.trim().trimEnd('/')
            prefs.edit().putString("server_url", clean).apply()
        }

    var authToken: String?
        get() = prefs.getString("auth_token", null)
        set(value) = prefs.edit().putString("auth_token", value).apply()

    var userId: Int
        get() = prefs.getInt("user_id", 0)
        set(value) = prefs.edit().putInt("user_id", value).apply()

    var userName: String
        get() = prefs.getString("user_name", "") ?: ""
        set(value) = prefs.edit().putString("user_name", value).apply()

    var userEmail: String
        get() = prefs.getString("user_email", "") ?: ""
        set(value) = prefs.edit().putString("user_email", value).apply()

    var userRole: String
        get() = prefs.getString("user_role", "Scanner") ?: "Scanner"
        set(value) = prefs.edit().putString("user_role", value).apply()

    var lastMarketplaceId: Int
        get() = prefs.getInt("last_marketplace_id", -1)
        set(value) = prefs.edit().putInt("last_marketplace_id", value).apply()

    var lastMarketplaceName: String
        get() = prefs.getString("last_marketplace_name", "") ?: ""
        set(value) = prefs.edit().putString("last_marketplace_name", value).apply()

    var lastAccountId: String
        get() = prefs.getString("last_account_id", "") ?: ""
        set(value) = prefs.edit().putString("last_account_id", value).apply()

    var lastAccountName: String
        get() = prefs.getString("last_account_name", "") ?: ""
        set(value) = prefs.edit().putString("last_account_name", value).apply()

    var lastMarketplace: String
        get() = prefs.getString("last_marketplace", "") ?: ""
        set(value) = prefs.edit().putString("last_marketplace", value).apply()

    var lastColor: String
        get() = prefs.getString("last_color", "") ?: ""
        set(value) = prefs.edit().putString("last_color", value).apply()

    // Last Scanned Return Details (for pre-filling Claims and seamless offline/instant form population)
    var lastScannedAwb: String
        get() = prefs.getString("last_scanned_awb", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_awb", value.trim()).apply()

    var lastScannedOrderId: String
        get() = prefs.getString("last_scanned_order_id", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_order_id", value.trim()).apply()

    var lastScannedSubOrderId: String
        get() = prefs.getString("last_scanned_sub_order_id", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_sub_order_id", value.trim()).apply()

    var lastScannedFlyerId: String
        get() = prefs.getString("last_scanned_flyer_id", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_flyer_id", value.trim()).apply()

    var lastScannedMarketplace: String
        get() = prefs.getString("last_scanned_marketplace", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_marketplace", value.trim()).apply()

    var lastScannedProductTitle: String
        get() = prefs.getString("last_scanned_product_title", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_product_title", value.trim()).apply()

    var lastScannedSku: String
        get() = prefs.getString("last_scanned_sku", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_sku", value.trim()).apply()

    var lastScannedMasterSku: String
        get() = prefs.getString("last_scanned_master_sku", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_master_sku", value.trim()).apply()

    var lastScannedImageUrl: String
        get() = prefs.getString("last_scanned_image_url", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_image_url", value.trim()).apply()

    var lastScannedIssueCode: String
        get() = prefs.getString("last_scanned_issue_code", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_issue_code", value.trim()).apply()

    var lastScannedCustomerName: String
        get() = prefs.getString("last_scanned_customer_name", "") ?: ""
        set(value) = prefs.edit().putString("last_scanned_customer_name", value.trim()).apply()

    var lastScannedTotalPrice: Double
        get() = prefs.getFloat("last_scanned_total_price", 0f).toDouble()
        set(value) = prefs.edit().putFloat("last_scanned_total_price", value.toFloat()).apply()

    fun saveLastScannedReturn(
        awb: String,
        orderId: String = "",
        subOrderId: String = "",
        flyerId: String = "",
        marketplace: String = "",
        productTitle: String = "",
        sku: String = "",
        masterSku: String = "",
        imageUrl: String = "",
        issueCode: String = "",
        customerName: String = "",
        totalPrice: Double = 0.0
    ) {
        val editor = prefs.edit()
        if (awb.isNotBlank()) editor.putString("last_scanned_awb", awb.trim())
        if (orderId.isNotBlank()) editor.putString("last_scanned_order_id", orderId.trim())
        if (subOrderId.isNotBlank()) editor.putString("last_scanned_sub_order_id", subOrderId.trim())
        if (flyerId.isNotBlank()) editor.putString("last_scanned_flyer_id", flyerId.trim())
        if (marketplace.isNotBlank()) editor.putString("last_scanned_marketplace", marketplace.trim())
        if (productTitle.isNotBlank()) editor.putString("last_scanned_product_title", productTitle.trim())
        if (sku.isNotBlank()) editor.putString("last_scanned_sku", sku.trim())
        if (masterSku.isNotBlank()) editor.putString("last_scanned_master_sku", masterSku.trim())
        if (imageUrl.isNotBlank()) editor.putString("last_scanned_image_url", imageUrl.trim())
        if (issueCode.isNotBlank()) editor.putString("last_scanned_issue_code", issueCode.trim())
        if (customerName.isNotBlank()) editor.putString("last_scanned_customer_name", customerName.trim())
        if (totalPrice > 0.0) editor.putFloat("last_scanned_total_price", totalPrice.toFloat())
        editor.apply()
    }

    var askedNotificationPermission: Boolean
        get() = prefs.getBoolean("asked_notification_permission", false)
        set(value) = prefs.edit().putBoolean("asked_notification_permission", value).apply()

    /** True once our own explanation of the camera permission has been shown, so it is never repeated at every start. */
    var cameraRationaleShown: Boolean
        get() = prefs.getBoolean("camera_rationale_shown", false)
        set(value) = prefs.edit().putBoolean("camera_rationale_shown", value).apply()

    /** True once the camera permission dialog has been shown at least once. Used to tell "never asked" from "blocked". */
    var askedCameraPermission: Boolean
        get() = prefs.getBoolean("asked_camera_permission", false)
        set(value) = prefs.edit().putBoolean("asked_camera_permission", value).apply()

    fun getUser(): User? {
        if (!isLoggedIn) return null
        return User(
            id = userId,
            name = userName,
            email = userEmail,
            role = userRole,
            sidebarLabel = ""
        )
    }

    var soundEnabled: Boolean
        get() = prefs.getBoolean("sound_enabled", true)
        set(value) = prefs.edit().putBoolean("sound_enabled", value).apply()

    var vibrationEnabled: Boolean
        get() = prefs.getBoolean("vibration_enabled", true)
        set(value) = prefs.edit().putBoolean("vibration_enabled", value).apply()

    var flashEnabled: Boolean
        get() = prefs.getBoolean("flash_enabled", true)
        set(value) = prefs.edit().putBoolean("flash_enabled", value).apply()

    var screenFlashEnabled: Boolean
        get() = flashEnabled
        set(value) { flashEnabled = value }

    val isLoggedIn: Boolean
        get() = !authToken.isNullOrBlank()

    fun hasSession(): Boolean = isLoggedIn

    fun saveLogin(response: LoginResponse) {
        prefs.edit()
            .putString("auth_token", response.token)
            .putInt("user_id", response.user.id)
            .putString("user_name", response.user.name)
            .putString("user_email", response.user.email)
            .putString("user_role", response.user.role)
            .apply()
    }

    fun clearSession() {
        prefs.edit()
            .remove("auth_token")
            .remove("user_id")
            .remove("user_name")
            .remove("user_email")
            .remove("user_role")
            .apply()
    }
}
