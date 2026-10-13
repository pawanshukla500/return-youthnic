package shop.youthnic.returnscan.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiClient(private val sessionManager: SessionManager) {

    private val cookieStore = mutableMapOf<String, MutableList<Cookie>>()

    val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .cookieJar(object : CookieJar {
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                val host = url.host
                val list = cookieStore.getOrPut(host) { mutableListOf() }
                list.removeAll { newCookie -> cookies.any { it.name == newCookie.name } }
                list.addAll(cookies)
            }

            override fun loadForRequest(url: HttpUrl): List<Cookie> {
                return cookieStore[url.host] ?: emptyList()
            }
        })
        .build()

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    suspend fun login(email: String, pass: String, rememberDevice: Boolean = true): Result<LoginResponse> =
        withContext(Dispatchers.IO) {
            try {
                val json = JSONObject().apply {
                    put("email", email.trim())
                    put("password", pass)
                    put("rememberDevice", rememberDevice)
                }
                val req = Request.Builder()
                    .url("${sessionManager.serverUrl}/api/auth/login")
                    .post(json.toString().toRequestBody(jsonMediaType))
                    .build()

                execute(req) { resJson ->
                    val resp = LoginResponse.fromJson(resJson)
                    sessionManager.saveLogin(resp)
                    resp
                }
            } catch (e: Exception) {
                Result.failure(mapException(e))
            }
        }

    suspend fun getMe(): Result<User> = withContext(Dispatchers.IO) {
        try {
            val req = authorizedRequestBuilder("/api/auth/me").get().build()
            execute(req) { json ->
                User.fromJson(json.optJSONObject("user") ?: JSONObject())
            }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun getAccounts(): Result<List<MarketplaceAccount>> = withContext(Dispatchers.IO) {
        try {
            val req = authorizedRequestBuilder("/api/accounts").get().build()
            execute(req) { json ->
                val arr = json.optJSONArray("accounts") ?: JSONArray()
                val list = mutableListOf<MarketplaceAccount>()
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i)
                    if (obj != null) list.add(MarketplaceAccount.fromJson(obj))
                }
                list
            }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun getSessionData(accountId: Any? = null): Result<ScanSessionData> = withContext(Dispatchers.IO) {
        try {
            val req = authorizedRequestBuilder("/api/scan/session").get().build()
            execute(req) { json ->
                val shiftObj = json.optJSONObject("shift") ?: JSONObject()
                val shift = ShiftProgress(
                    scansToday = shiftObj.optInt("scansToday", 0),
                    issuesToday = shiftObj.optInt("issuesToday", 0),
                    clearRate = shiftObj.optString("clearRate", "100%")
                )

                val accountsArr = json.optJSONArray("accounts") ?: JSONArray()
                val accounts = mutableListOf<MarketplaceAccount>()
                for (i in 0 until accountsArr.length()) {
                    val obj = accountsArr.optJSONObject(i)
                    if (obj != null) accounts.add(MarketplaceAccount.fromJson(obj))
                }

                val categoriesArr = json.optJSONArray("issueCategories") ?: JSONArray()
                val categories = mutableListOf<IssueCategory>()
                for (i in 0 until categoriesArr.length()) {
                    val obj = categoriesArr.optJSONObject(i)
                    if (obj != null) categories.add(IssueCategory.fromJson(obj))
                }

                val subIssuesArr = json.optJSONArray("subIssues") ?: JSONArray()
                val subIssues = mutableListOf<SubIssue>()
                for (i in 0 until subIssuesArr.length()) {
                    val obj = subIssuesArr.optJSONObject(i)
                    if (obj != null) subIssues.add(SubIssue.fromJson(obj))
                }

                ScanSessionData(shift, accounts, categories, subIssues)
            }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun lookupAwb(awb: String, marketplace: String): Result<LookupResult> =
        withContext(Dispatchers.IO) {
            try {
                val json = JSONObject().apply {
                    put("tracking", awb.trim())
                    put("marketplace", if (marketplace.isBlank()) "Auto detect" else marketplace)
                }
                val req = authorizedRequestBuilder("/api/scan/lookup")
                    .post(json.toString().toRequestBody(jsonMediaType))
                    .build()

                execute(req) { resJson ->
                    LookupResult.fromJson(resJson, awb)
                }
            } catch (e: Exception) {
                Result.failure(mapException(e))
            }
        }

    suspend fun lookup(accountId: Any?, awb: String): Result<LookupResult> = lookupAwb(awb, "")

    suspend fun saveScan(
        shipmentId: Int,
        clientScanKey: String,
        tracking: String,
        notes: String,
        items: List<LookupItem>
    ): Result<ScanReceipt> = withContext(Dispatchers.IO) {
        try {
            val submission = JSONObject().apply {
                put("shipmentId", shipmentId)
                put("clientScanKey", clientScanKey)
                put("scannedTracking", tracking)
                put("notes", notes)
                put("photoCount", 0)
                put("hasVideo", false)

                val itemsArr = JSONArray()
                for (item in items) {
                    val itemObj = JSONObject().apply {
                        put("itemId", item.itemId)
                        put("receivedQty", item.receivedQty)
                        put("verified", item.physicalChecked)

                        val issuesArr = JSONArray()
                        // Only add an issue if not clear
                        if (item.selectedCategoryCode != "clear") {
                            val issueObj = JSONObject().apply {
                                put("categoryCode", item.selectedCategoryCode)
                                if (item.selectedSubIssueId != null) {
                                    put("subIssueId", item.selectedSubIssueId)
                                }
                                put("qty", item.receivedQty)
                                put("ticketCode", "")
                                put("notes", item.itemNotes)
                            }
                            issuesArr.put(issueObj)
                        }
                        put("issues", issuesArr)
                    }
                    itemsArr.put(itemObj)
                }
                put("items", itemsArr)
            }

            val req = authorizedRequestBuilder("/api/scan/complete")
                .post(submission.toString().toRequestBody(jsonMediaType))
                .build()

            execute(req) { resJson ->
                ScanReceipt.fromJson(resJson)
            }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun completeScan(
        accountId: Any,
        shipmentId: Any,
        clientScanKey: String,
        scannedTracking: String,
        items: List<shop.youthnic.returnscan.ui.ItemVerificationState>
    ): Result<ScanReceipt> = withContext(Dispatchers.IO) {
        try {
            val submission = JSONObject().apply {
                put("accountId", accountId.toString().toIntOrNull() ?: 0)
                put("shipmentId", shipmentId.toString().toIntOrNull() ?: 0)
                put("clientScanKey", clientScanKey)
                put("scannedTracking", scannedTracking)
                put("notes", "")
                put("photoCount", 0)
                put("hasVideo", false)

                val itemsArr = JSONArray()
                for (item in items) {
                    val itemObj = JSONObject().apply {
                        put("itemId", item.itemId.toIntOrNull() ?: 0)
                        put("receivedQty", item.receivedQty)
                        put("verified", item.physicalChecked)

                        val issuesArr = JSONArray()
                        if (item.categoryCode != "clear") {
                            val issueObj = JSONObject().apply {
                                put("categoryCode", item.categoryCode)
                                if (!item.subIssueId.isNullOrBlank()) {
                                    put("subIssueId", item.subIssueId?.toIntOrNull())
                                }
                                put("qty", item.receivedQty)
                                put("ticketCode", "")
                                put("notes", item.notes)
                            }
                            issuesArr.put(issueObj)
                        }
                        put("issues", issuesArr)
                    }
                    itemsArr.put(itemObj)
                }
                put("items", itemsArr)
            }

            val req = authorizedRequestBuilder("/api/scan/complete")
                .post(submission.toString().toRequestBody(jsonMediaType))
                .build()

            execute(req) { resJson ->
                ScanReceipt.fromJson(resJson)
            }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun getRecentScans(): Result<List<RecentScan>> = withContext(Dispatchers.IO) {
        try {
            val req = authorizedRequestBuilder("/api/register?pageSize=20").get().build()
            execute(req) { json ->
                val arr = json.optJSONArray("rows") ?: JSONArray()
                val list = mutableListOf<RecentScan>()
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i) ?: continue
                    list.add(
                        RecentScan(
                            id = obj.optInt("id", 0),
                            awb = obj.optString("awb", obj.optString("tracking_id", "")),
                            marketplace = obj.optString("marketplace", ""),
                            carrier = obj.optString("carrier", ""),
                            outcome = obj.optString("outcome", "clear"),
                            timestamp = obj.optString("scannedAt", obj.optString("scanned_at", "")),
                            units = obj.optInt("receivedUnits", 1)
                        )
                    )
                }
                list
            }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun logout(): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            val req = authorizedRequestBuilder("/api/auth/logout")
                .post("{}".toRequestBody(jsonMediaType))
                .build()
            okHttpClient.newCall(req).execute().close()
            sessionManager.clearSession()
            Result.success(Unit)
        } catch (e: Exception) {
            sessionManager.clearSession()
            Result.success(Unit)
        }
    }

    suspend fun checkLatestRelease(): Result<AppRelease?> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("${sessionManager.serverUrl}/api/app/latest")
                .get()
                .build()
            val response = okHttpClient.newCall(req).execute()
            if (!response.isSuccessful) return@withContext Result.success(null)

            val bodyStr = response.body?.string() ?: return@withContext Result.success(null)
            val json = JSONObject(bodyStr)
            Result.success(AppRelease.fromJson(json))
        } catch (_: Exception) {
            Result.success(null)
        }
    }

    suspend fun getLatestRelease(): Result<AppRelease?> = checkLatestRelease()

    private fun authorizedRequestBuilder(endpoint: String): Request.Builder {
        val builder = Request.Builder()
            .url("${sessionManager.serverUrl}$endpoint")
        sessionManager.authToken?.let { token ->
            builder.addHeader("Authorization", "Bearer $token")
        }
        return builder
    }

    private fun <T> execute(request: Request, parser: (JSONObject) -> T): Result<T> {
        val response = okHttpClient.newCall(request).execute()
        val bodyStr = response.body?.string().orEmpty()

        if (response.code == 401) {
            throw AuthExpiredException("Session expired. Please sign in again.")
        }

        if (!response.isSuccessful) {
            val errorMsg = try {
                val errObj = JSONObject(bodyStr)
                errObj.optString("error", errObj.optString("message", "Request failed with HTTP ${response.code}"))
            } catch (_: Exception) {
                "Request failed with HTTP ${response.code}"
            }
            throw ApiException(response.code, errorMsg)
        }

        val json = if (bodyStr.isBlank()) JSONObject() else JSONObject(bodyStr)
        return Result.success(parser(json))
    }

    private fun mapException(e: Exception): Throwable {
        return when (e) {
            is ApiException, is AuthExpiredException -> e
            is IOException -> NetworkException("Cannot connect to server. Check network connection.", e)
            else -> e
        }
    }
}
