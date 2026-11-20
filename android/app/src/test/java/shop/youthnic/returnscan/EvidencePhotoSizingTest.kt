package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import shop.youthnic.returnscan.util.EvidencePhotoSizing
import java.io.File

class EvidencePhotoSizingTest {

    private val appDir: File = listOf(File("."), File("app"), File("android/app"))
        .first { File(it, "src/main/res/values/strings.xml").isFile }

    @Test
    fun aTwelveMegapixelCaptureHeldUprightIsStoredUprightAt1600OnTheLongEdge() {
        // A phone held upright saves the 4000 x 3000 sensor image tagged EXIF ROTATE_90 (6).
        val plan = EvidencePhotoSizing.plan(4000, 3000, exifOrientation = 6)
        assertTrue(plan.rewrite)
        assertEquals(1600 to 1200, plan.targetWidth to plan.targetHeight)
        assertEquals(90, plan.rotationDegrees)
        assertFalse(plan.mirror)
        assertEquals(1200 to 1600, plan.finalWidth to plan.finalHeight)
    }

    @Test
    fun aLandscapeCaptureKeepsItsShapeAndAspectRatio() {
        val plan = EvidencePhotoSizing.plan(4032, 3024, exifOrientation = 1)
        assertTrue(plan.rewrite)
        assertEquals(0, plan.rotationDegrees)
        assertEquals(1600 to 1200, plan.finalWidth to plan.finalHeight)

        val wide = EvidencePhotoSizing.plan(4000, 2250, exifOrientation = 1) // 16:9
        assertEquals(1600 to 900, wide.finalWidth to wide.finalHeight)
    }

    @Test
    fun aFiftyMegapixelCaptureIsAlsoCappedAt1600() {
        val plan = EvidencePhotoSizing.plan(8160, 6120, exifOrientation = 8)
        assertEquals(270, plan.rotationDegrees)
        assertEquals(1200 to 1600, plan.finalWidth to plan.finalHeight)
    }

    @Test
    fun aPhotoAlreadySmallAndUprightIsLeftAlone() {
        val plan = EvidencePhotoSizing.plan(1600, 1200, exifOrientation = 1)
        assertFalse(plan.rewrite)
        assertEquals(1600 to 1200, plan.finalWidth to plan.finalHeight)
        // 0 is EXIF "undefined": treated as upright.
        assertFalse(EvidencePhotoSizing.plan(800, 600, exifOrientation = 0).rewrite)
    }

    @Test
    fun aSmallPhotoIsNeverUpscaledButIsStillTurnedUpright() {
        val plan = EvidencePhotoSizing.plan(1280, 720, exifOrientation = 6)
        assertTrue(plan.rewrite)
        assertEquals(1280 to 720, plan.targetWidth to plan.targetHeight)
        assertEquals(720 to 1280, plan.finalWidth to plan.finalHeight)
    }

    @Test
    fun anUnreadableImageIsNeverRewritten() {
        assertFalse(EvidencePhotoSizing.plan(0, 0, exifOrientation = 6).rewrite)
        assertFalse(EvidencePhotoSizing.plan(-1, -1, exifOrientation = 1).rewrite)
    }

    @Test
    fun everyExifOrientationMapsToATurnAndAMirror() {
        // EXIF orientation 1-8, applied as Glide does: turn clockwise, then mirror left to right.
        val expected = mapOf(
            1 to (0 to false), 2 to (0 to true), 3 to (180 to false), 4 to (180 to true),
            5 to (90 to true), 6 to (90 to false), 7 to (270 to true), 8 to (270 to false),
            0 to (0 to false), 99 to (0 to false)
        )
        for ((orientation, want) in expected) {
            val got = EvidencePhotoSizing.rotationDegrees(orientation) to EvidencePhotoSizing.isMirrored(orientation)
            assertEquals("EXIF orientation $orientation", want, got)
        }
    }

    @Test
    fun storedPhotosAreJpegQuality80() {
        assertEquals(1600, EvidencePhotoSizing.MAX_LONG_EDGE)
        assertEquals(80, EvidencePhotoSizing.JPEG_QUALITY)
    }

    @Test
    fun theClaimScreenShrinksCameraPhotosAndDecodesThumbnailsOffTheMainThread() {
        // The screen cannot be inflated in a unit test, so read its source.
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/ui/ClaimCaptureActivity.kt").readText()
        assertFalse("ClaimCaptureActivity decodes a full-size bitmap", source.contains("BitmapFactory.decodeFile("))

        val photoResult = source.substringAfter("ActivityResultContracts.TakePicture()")
            .substringBefore("private var pendingPermissionAction")
        assertTrue(
            "a camera photo must be shrunk on the IO dispatcher before it is recorded",
            photoResult.contains("withContext(Dispatchers.IO) { EvidencePhoto.downscaleInPlace(file) }") &&
                photoResult.indexOf("EvidencePhoto.downscaleInPlace") < photoResult.indexOf("recordCapturedEvidence(")
        )
        val submitStart = source.substringAfter("private fun submitCompleteClaim(").substringBefore("ClaimPayload.build(")
        assertTrue(
            "Submit must wait while a photo is still being shrunk, or that photo is left off the claim",
            photoResult.contains("photosBeingSaved++") && submitStart.contains("if (photosBeingSaved > 0)")
        )

        val record = source.substringAfter("private fun recordCapturedEvidence(").substringBefore("private fun removeEvidence(")
        assertFalse(
            "the thumbnail must not be decoded on the main thread",
            record.substringBefore("withContext(Dispatchers.IO)").contains("decodeSampledBitmap")
        )
        assertTrue(
            "the thumbnail must use the shared sampled decoder on the IO dispatcher",
            record.substringAfter("withContext(Dispatchers.IO)").contains("ImageCache.decodeSampledBitmap(")
        )
        assertTrue(
            "the card must show the placeholder before the async decode, or the previous return's photo shows " +
                "(and stays when the decode fails)",
            record.substringBefore("lifecycleScope.launch").contains("ivEvidenceThumb.setImageResource(R.drawable.ic_camera)")
        )
    }
}
