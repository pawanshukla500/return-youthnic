package shop.youthnic.returnscan

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import shop.youthnic.returnscan.data.AppRelease

class ReturnModelsTest {

    @Test
    fun testAppReleaseVersionComparison() {
        val release = AppRelease(
            versionCode = 10005,
            versionName = "1.0.5",
            minRequiredVersionCode = 10002,
            downloadUrl = "https://return.youthnic.shop/download/return-scan.apk",
            sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            sizeBytes = 4194304,
            notes = "Bug fixes and faster camera auto-resume",
            publishedAt = "2026-10-12T12:00:00Z",
            pageUrl = "https://github.com/youthnic/return-scan/releases"
        )

        // App running version 10001
        assertTrue(release.isNewerThan(10001))
        assertTrue(release.isRequiredFor(10001))

        // App running version 10003
        assertTrue(release.isNewerThan(10003))
        assertFalse(release.isRequiredFor(10003))

        // App running version 10005 (same)
        assertFalse(release.isNewerThan(10005))
        assertFalse(release.isRequiredFor(10005))

        // App running version 10006 (newer)
        assertFalse(release.isNewerThan(10006))
    }

    @Test
    fun testReleaseJsonParsing() {
        val json = """
            {
                "versionCode": 10002,
                "versionName": "1.0.2",
                "minRequiredVersionCode": 10001,
                "downloadUrl": "https://return.youthnic.shop/download/return-scan.apk",
                "sha256": "abcdef123456",
                "sizeBytes": 3500000,
                "notes": "Added missing component options",
                "publishedAt": "2026-10-12T10:00:00Z",
                "pageUrl": "https://github.com/youthnic/return-scan/releases/v1.0.2"
            }
        """.trimIndent()

        val obj = JSONObject(json)
        val release = AppRelease.fromJson(obj)

        assertEquals(10002, release.versionCode)
        assertEquals("1.0.2", release.versionName)
        assertEquals(10001, release.minRequiredVersionCode)
        assertEquals("abcdef123456", release.sha256)
        assertEquals(3500000L, release.sizeBytes)
        assertEquals("Added missing component options", release.notes)
    }
}
