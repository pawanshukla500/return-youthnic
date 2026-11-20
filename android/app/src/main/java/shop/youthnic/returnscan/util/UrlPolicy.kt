package shop.youthnic.returnscan.util

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import shop.youthnic.returnscan.BuildConfig

/**
 * Which addresses the app may use: the server address (it receives the password and the session token) and the update
 * download and page links (they install code). A release build accepts https only. A debug build also accepts http to
 * this phone or the local network, so it still works against a LAN test server. The manifest's usesCleartextTraffic
 * follows the same build-type split (build.gradle). No Android classes here, so UrlPolicyTest covers it.
 */
object UrlPolicy {

    private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

    fun isAllowed(url: String?, allowCleartext: Boolean = BuildConfig.DEBUG): Boolean {
        val parsed = url?.trim()?.toHttpUrlOrNull() ?: return false
        if (parsed.isHttps) return true
        return allowCleartext && isLocalHost(parsed.host)
    }

    /**
     * Product image links come from uploaded sheets and catalogs and may be http://. A build that may not fetch one over
     * http asks for it over https instead, the way browsers upgrade images on the https web console.
     */
    fun forImage(url: String, allowCleartext: Boolean = BuildConfig.DEBUG): String =
        if (url.startsWith("http://", ignoreCase = true) && !isAllowed(url, allowCleartext)) "https://" + url.substring(7) else url

    /** localhost, loopback (127/8, ::1), private (10/8, 172.16/12, 192.168/16) and link-local (169.254/16) addresses. */
    fun isLocalHost(host: String): Boolean {
        val h = host.lowercase()
        if (h == "localhost" || h == "::1") return true
        val octets = IPV4.matchEntire(h)?.groupValues?.drop(1)?.map { it.toInt() } ?: return false
        if (octets.any { it > 255 }) return false
        val (a, b) = octets
        return a == 127 || a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
    }
}
