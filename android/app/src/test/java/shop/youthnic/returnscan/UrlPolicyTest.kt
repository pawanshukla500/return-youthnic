package shop.youthnic.returnscan

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import shop.youthnic.returnscan.util.UrlPolicy
import java.io.File
import java.net.URLDecoder

/**
 * The manifest allowed unencrypted traffic everywhere, the sign-in screen saved any server address (which then receives
 * the password and the session token), and the updater downloaded any http link. A release build now accepts https
 * only; a debug build also accepts http to this phone or the local network, so it still works against a LAN server.
 */
class UrlPolicyTest {

    private val release = false
    private val debug = true

    @Test
    fun releaseBuildRefusesHttpServerAndDownloadAddresses() {
        assertTrue(UrlPolicy.isAllowed("https://return.youthnic.shop", release))
        assertTrue(UrlPolicy.isAllowed("  HTTPS://return.youthnic.shop/  ", release))
        assertTrue(UrlPolicy.isAllowed("https://github.com/SYN-owner/SYN-repo/releases/download/v1.0.90/ReturnScan-v1.0.90.apk", release))

        assertFalse(UrlPolicy.isAllowed("http://return.youthnic.shop", release))
        assertFalse(UrlPolicy.isAllowed("http://github.com/SYN-owner/SYN-repo/releases/download/v1.0.90/ReturnScan-v1.0.90.apk", release))
        // Not even a LAN server: a release build has no unencrypted traffic at all.
        assertFalse(UrlPolicy.isAllowed("http://192.168.1.20:3001", release))
        assertFalse(UrlPolicy.isAllowed("http://localhost:3001", release))
    }

    @Test
    fun debugBuildStillReachesALanServer() {
        for (lan in listOf(
            "http://192.168.1.20:3001",
            "http://10.0.2.2:3001",
            "http://172.16.0.5",
            "http://172.31.255.254:8080",
            "http://169.254.10.1",
            "http://127.0.0.1:3001",
            "http://localhost:3001",
            "http://[::1]:3001",
        )) {
            assertTrue("$lan should be allowed in a debug build", UrlPolicy.isAllowed(lan, debug))
        }
        assertTrue(UrlPolicy.isAllowed("https://return.youthnic.shop", debug))
    }

    @Test
    fun debugBuildStillRefusesHttpToTheInternet() {
        for (internet in listOf(
            "http://return.youthnic.shop",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://172.15.0.1",
            "http://192.169.1.1",
            "http://192.168.1.20.syn-example.com",
            "http://syn-lan-server",
        )) {
            assertFalse("$internet should be refused even in a debug build", UrlPolicy.isAllowed(internet, debug))
        }
    }

    @Test
    fun junkIsNeverAnAddress() {
        for (junk in listOf(null, "", "   ", "return.youthnic.shop", "ftp://return.youthnic.shop/a.apk",
            "file:///sdcard/Download/SYN-update.apk", "javascript:alert(1)", "https://", "http://")) {
            assertFalse("$junk should be refused", UrlPolicy.isAllowed(junk, debug))
        }
    }

    @Test
    fun localHostNeedsARealPrivateIpv4() {
        assertTrue(UrlPolicy.isLocalHost("192.168.0.1"))
        assertFalse(UrlPolicy.isLocalHost("192.168.0.256"))
        assertFalse(UrlPolicy.isLocalHost("192.168.0"))
        assertFalse(UrlPolicy.isLocalHost("999.10.0.1"))
        assertFalse(UrlPolicy.isLocalHost("10.syn.0.1"))
    }

    // Product images: the web console sends every http(s) image link through the server's GET /api/catalog-image?url=,
    // which fetches the link server-side. A release build does the same for an http link instead of fetching it in clear.
    private val server = "https://syn-server.example"

    @Test
    fun httpProductImagesGoThroughTheServerImageProxyInRelease() {
        val proxied = "https://syn-server.example/api/catalog-image?url=http%3A%2F%2Fsyn-cdn.example%2FSYN-SKU-1.jpg"
        assertEquals(proxied, UrlPolicy.forImage("http://syn-cdn.example/SYN-SKU-1.jpg", server, release))
        assertEquals(proxied, UrlPolicy.forImage("http://syn-cdn.example/SYN-SKU-1.jpg", "$server/", release))
        // A LAN link is proxied too (the server then refuses a private host, as it does for the web console).
        assertTrue(UrlPolicy.forImage("http://192.168.1.20:3001/SYN-SKU-1.jpg", server, release).startsWith("$server/api/catalog-image?url="))
    }

    @Test
    fun theProxiedLinkCarriesTheOriginalLinkIntactAndStaysOnTheServer() {
        for (link in listOf(
            "http://syn-cdn.example/SYN-SKU-1.jpg?w=416&h=416#top",
            "HTTP://syn-cdn.example/SYN SKU+2%20.jpg",
            "http://syn-server.example.syn-evil.example/SYN-SKU-3.jpg",
            "http://syn-evil.example/@syn-server.example/SYN-SKU-4.jpg",
            "http://syn-user:syn-pass@syn-evil.example/SYN-SKU-5.jpg",
            "http://syn-cdn.example/SYN-कुर्ता-6.jpg",
        )) {
            val proxied = UrlPolicy.forImage(link, server, release)
            val parsed = proxied.toHttpUrl()
            assertEquals("https", parsed.scheme)
            assertEquals("syn-server.example", parsed.host)
            assertEquals("/api/catalog-image", parsed.encodedPath)
            assertEquals(setOf("url"), parsed.queryParameterNames)
            // The server reads `url` as Express does (percent-decoding, + as a space) and must get the stored link back.
            assertEquals(link, URLDecoder.decode(proxied.substringAfter("?url="), "UTF-8"))
            assertTrue(UrlPolicy.isOnServer(proxied, server))
        }
    }

    @Test
    fun httpsProductImagesLoadDirectly() {
        for (build in listOf(release, debug)) {
            assertEquals("https://syn-cdn.example/SYN-SKU-1.jpg", UrlPolicy.forImage("https://syn-cdn.example/SYN-SKU-1.jpg", server, build))
            assertEquals("HTTPS://syn-cdn.example/SYN-SKU-1.jpg", UrlPolicy.forImage("HTTPS://syn-cdn.example/SYN-SKU-1.jpg", server, build))
        }
        // Not a link at all: passed on unchanged (the request fails and the placeholder shows), never proxied.
        assertEquals("SYN-not-a-link", UrlPolicy.forImage("SYN-not-a-link", server, release))
    }

    @Test
    fun debugBuildStillLoadsLanImagesDirectly() {
        assertEquals("http://192.168.1.20:3001/SYN-SKU-1.jpg", UrlPolicy.forImage("http://192.168.1.20:3001/SYN-SKU-1.jpg", server, debug))
        assertEquals("http://10.0.2.2:3001/SYN-SKU-1.jpg", UrlPolicy.forImage("http://10.0.2.2:3001/SYN-SKU-1.jpg", "http://10.0.2.2:3001", debug))
        // An http link to the internet goes through the image proxy of the (LAN) debug server.
        assertEquals(
            "http://192.168.1.20:3001/api/catalog-image?url=http%3A%2F%2Fsyn-cdn.example%2FSYN-SKU-1.jpg",
            UrlPolicy.forImage("http://syn-cdn.example/SYN-SKU-1.jpg", "http://192.168.1.20:3001", debug),
        )
    }

    @Test
    fun theSessionTokenGoesOnlyToTheAppServer() {
        assertTrue(UrlPolicy.isOnServer("https://syn-server.example/api/catalog-image?url=SYN-x", server))
        assertTrue(UrlPolicy.isOnServer("https://SYN-SERVER.example:443/SYN-SKU-1.jpg", "$server/"))
        for (other in listOf(
            "https://syn-cdn.example/SYN-SKU-1.jpg",
            "https://syn-server.example.syn-evil.example/SYN-SKU-1.jpg",
            "https://syn-evil.example/syn-server.example/SYN-SKU-1.jpg",
            "http://syn-server.example/SYN-SKU-1.jpg",
            "https://syn-server.example:8443/SYN-SKU-1.jpg",
            "SYN-not-a-link",
            "",
        )) {
            assertFalse("$other must not receive the session token", UrlPolicy.isOnServer(other, server))
        }
        assertFalse(UrlPolicy.isOnServer("https://syn-server.example/SYN-SKU-1.jpg", "SYN-not-a-server"))
    }

    // A unit test cannot build the APK, so this reads the build files (as StringFormatsTest does).
    private val appDir: File by lazy {
        listOf(File("."), File("app"), File("android/app")).first { File(it, "src/main/AndroidManifest.xml").isFile }
    }

    @Test
    fun cleartextFollowsTheBuildType() {
        val manifest = File(appDir, "src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android:usesCleartextTraffic=\"\${usesCleartextTraffic}\""))

        val buildTypes = File(appDir, "build.gradle").readText().substringAfter("buildTypes {")
        val debugBlock = buildTypes.substringAfter("debug {").substringBefore("release {")
        val releaseBlock = buildTypes.substringAfter("release {")
        assertTrue(debugBlock.contains("usesCleartextTraffic: \"true\""))
        assertTrue(releaseBlock.contains("usesCleartextTraffic: \"false\""))
        assertFalse(releaseBlock.contains("usesCleartextTraffic: \"true\""))
    }

    @Test
    fun serverAddressAndUpdateLinksGoThroughThePolicy() {
        val src = File(appDir, "src/main/java/shop/youthnic/returnscan")
        assertTrue(File(src, "ui/LoginActivity.kt").readText().contains("UrlPolicy.isAllowed(inputUrl)"))
        assertTrue(File(src, "data/SessionManager.kt").readText().contains("UrlPolicy.isAllowed("))
        val updater = File(src, "update/AppUpdater.kt").readText()
        assertTrue(updater.contains("UrlPolicy.isAllowed(release.downloadUrl)"))
        assertTrue(updater.contains("UrlPolicy.isAllowed(release.pageUrl)"))
    }

    @Test
    fun imageCacheProxiesHttpLinksAndSendsTheTokenOnlyToTheServer() {
        val imageCache = File(appDir, "src/main/java/shop/youthnic/returnscan/data/ImageCache.kt").readText()
        assertTrue(imageCache.contains("UrlPolicy.forImage(url, serverUrl)"))
        assertTrue(imageCache.contains("UrlPolicy.isOnServer(fetchUrl, serverUrl)) builder.header(\"Authorization\""))
        assertEquals(1, Regex("Authorization").findAll(imageCache).count())
    }
}
