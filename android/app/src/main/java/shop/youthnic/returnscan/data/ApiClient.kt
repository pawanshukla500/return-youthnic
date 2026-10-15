package shop.youthnic.returnscan.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.File
import java.util.concurrent.TimeUnit

class ApiClient(private val sessionManager: SessionManager) {

    private val cookieStore = mutableMapOf<String, MutableList<Cookie>>()

    val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(2, TimeUnit.MINUTES)
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
                val shift = ShiftProgress.fromJson(json.optJSONObject("shift"))

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

    /**
     * Looks an AWB up in the active return data of one account. [marketplace] is the account name from GET /api/accounts
     * (blank = every account the user may use). [shipmentId] picks one return when the server answered "choose".
     */
    suspend fun lookupAwb(awb: String, marketplace: String, shipmentId: Int? = null): Result<LookupResult> =
        withContext(Dispatchers.IO) {
            try {
                val json = JSONObject().apply {
                    put("tracking", awb.trim())
                    put("marketplace", if (marketplace.isBlank()) "Auto detect" else marketplace)
                    if (shipmentId != null) put("shipmentId", shipmentId)
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

    suspend fun completeScan(
        shipmentId: Int,
        clientScanKey: String,
        scannedTracking: String,
        items: List<ItemVerificationState>,
        flyerId: String = "",
        flyerState: String = "not_required"
    ): Result<ScanReceipt> = withContext(Dispatchers.IO) {
        try {
            val submission = ScanPayload.build(shipmentId, clientScanKey, scannedTracking, items, flyerId, flyerState)
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

    /** The sync cursor (GET /api/sync/state). LiveSync polls it while the WebSocket is not connected. */
    suspend fun getSyncCursor(): Result<Long> = withContext(Dispatchers.IO) {
        try {
            val req = authorizedRequestBuilder("/api/sync/state").get().build()
            execute(req) { json -> json.optLong("cursor", 0L) }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun searchClaimScans(search: String): Result<List<ClaimScanResult>> = withContext(Dispatchers.IO) {
        try {
            val encoded = java.net.URLEncoder.encode(search.trim(), Charsets.UTF_8.name())
            val request = authorizedRequestBuilder("/api/claims/scan-search?search=$encoded").get().build()
            execute(request) { json ->
                val rows = json.optJSONArray("rows") ?: JSONArray()
                buildList {
                    for (index in 0 until rows.length()) {
                        rows.optJSONObject(index)?.let { add(ClaimScanResult.fromJson(it)) }
                    }
                }
            }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun getMeeshoClaimDraft(scanId: Int): Result<MeeshoClaimDraft> = withContext(Dispatchers.IO) {
        try {
            val request = authorizedRequestBuilder("/api/claims/meesho/draft/$scanId").get().build()
            execute(request) { json ->
                MeeshoClaimDraft.fromJson(json.optJSONObject("draft") ?: JSONObject())
            }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun createMeeshoClaim(scanId: Int, issueCode: String): Result<Int> = withContext(Dispatchers.IO) {
        try {
            val json = JSONObject().apply {
                put("receiptScanId", scanId)
                put("marketplaceIssueCode", issueCode)
                put("claimReason", "")
                put("claimTitle", "")
                put("claimDescription", "")
                put("remarks", "")
            }
            val request = authorizedRequestBuilder("/api/claims")
                .post(json.toString().toRequestBody(jsonMediaType))
                .build()
            execute(request) { response ->
                response.optJSONObject("claim")?.optInt("id", 0) ?: 0
            }
        } catch (e: Exception) {
            Result.failure(mapException(e))
        }
    }

    suspend fun uploadClaimEvidence(
        claimId: Int,
        fieldKey: String,
        file: File,
        mimeType: String
    ): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            if (!file.exists() || file.length() == 0L) {
                return@withContext Result.failure(IOException("Captured evidence file is missing."))
            }
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("fieldKey", fieldKey)
                .addFormDataPart(
                    "capturedAt",
                    java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply {
                        timeZone = java.util.TimeZone.getTimeZone("UTC")
                    }.format(java.util.Date(file.lastModified()))
                )
                .addFormDataPart("file", file.name, file.asRequestBody(mimeType.toMediaType()))
                .build()
            val request = authorizedRequestBuilder("/api/claims/$claimId/media/upload")
                .post(body)
                .build()
            execute(request) { Unit }
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
                val base = errObj.optString("error", errObj.optString("message", "Request failed with HTTP ${response.code}"))
                val details = errObj.optJSONArray("details")
                val lines = ArrayList<String>()
                if (details != null) {
                    for (i in 0 until minOf(details.length(), 3)) {
                        val line = details.optString(i, "")
                        if (line.isNotBlank()) lines.add(line)
                    }
                }
                if (lines.isEmpty()) base else base + "\n" + lines.joinToString("\n")
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
