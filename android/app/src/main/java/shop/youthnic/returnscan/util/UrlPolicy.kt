package shop.youthnic.returnscan.util

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import shop.youthnic.returnscan.BuildConfig
import java.net.URLEncoder

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
     * The address ImageCache fetches for a product image link. Links come from uploaded sheets and catalogs and may be
     * http://. An https link, or an http one this build may use (a LAN address in a debug build), is fetched as it is.
     * Any other http link goes through the server's image proxy, `GET /api/catalog-image?url=<link>` on [serverUrl]:
     * the web console sends every image through that route, and the server fetches the link itself (over plain http if
     * it must) and serves only links the product master or a saved SKU stores. So the phone never fetches an image in
     * clear text, and an image the web console shows also shows here when its host has no working https.
     */
    fun forImage(url: String, serverUrl: String, allowCleartext: Boolean = BuildConfig.DEBUG): String =
        if (url.startsWith("http://", ignoreCase = true) && !isAllowed(url, allowCleartext)) {
            serverUrl.trim().trimEnd('/') + "/api/catalog-image?url=" + URLEncoder.encode(url, "UTF-8")
        } else {
            url
        }

    /**
     * True when [url] is on the app's own server (same scheme, host and port as [serverUrl]). ImageCache sends the
     * session token only then, never to a marketplace or CDN host.
     */
    fun isOnServer(url: String, serverUrl: String): Boolean {
        val target = url.toHttpUrlOrNull() ?: return false
        val server = serverUrl.trim().toHttpUrlOrNull() ?: return false
        return target.scheme == server.scheme && target.host == server.host && target.port == server.port
    }

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
