package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import shop.youthnic.returnscan.util.EvidencePhotoSizing
import shop.youthnic.returnscan.util.replaceFileSafely
import java.io.File
import kotlin.math.abs

class EvidencePhotoSizingTest {

    private val appDir: File = listOf(File("."), File("app"), File("android/app"))
        .first { File(it, "src/main/res/values/strings.xml").isFile }

    @get:Rule
    val folder = TemporaryFolder()

    /** Where the matrix [m] (android.graphics.Matrix.setValues order) sends the point ([x], [y]). */
    private fun landing(m: FloatArray, x: Float, y: Float): Pair<Float, Float> =
        (m[0] * x + m[1] * y + m[2]) to (m[3] * x + m[4] * y + m[5])

    /** Which corner of the stored photo the source point lands on: T or B, then L or R ("?" when on none). */
    private fun corner(plan: EvidencePhotoSizing.Plan, m: FloatArray, x: Float, y: Float): String {
        val (px, py) = landing(m, x, y)
        fun near(value: Float, edge: Int) = abs(value - edge) < 0.01f
        val vertical = when { near(py, 0) -> "T"; near(py, plan.finalHeight) -> "B"; else -> "?" }
        val horizontal = when { near(px, 0) -> "L"; near(px, plan.finalWidth) -> "R"; else -> "?" }
        return vertical + horizontal
    }

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
    fun aTwelveMegapixelCaptureHeldUprightIsDrawnUprightAt1200By1600() {
        // The sampled decoder halves a 4000 x 3000 capture for a 1600 x 1200 target (inSampleSize 2).
        val plan = EvidencePhotoSizing.plan(4000, 3000, exifOrientation = 6)
        val m = plan.matrixValues(2000, 1500)
        // Bitmap.createBitmap sizes its result from where the source corners land.
        val landed = listOf(0f to 0f, 2000f to 0f, 0f to 1500f, 2000f to 1500f).map { (x, y) -> landing(m, x, y) }
        assertEquals(0f, landed.minOf { it.first }, 0.01f)
        assertEquals(0f, landed.minOf { it.second }, 0.01f)
        assertEquals(1200f, landed.maxOf { it.first }, 0.01f)
        assertEquals(1600f, landed.maxOf { it.second }, 0.01f)
    }

    @Test
    fun everyExifOrientationPutsTheStoredCornersWhereTheExifStandardSays() {
        // From the EXIF orientation tag's meaning (which side row 0 and column 0 belong on), not from the code:
        // where the stored image's top-left, top-right and bottom-left corners end up in the upright photo.
        val expected = mapOf(
            1 to listOf("TL", "TR", "BL"),
            2 to listOf("TR", "TL", "BR"),
            3 to listOf("BR", "BL", "TR"),
            4 to listOf("BL", "BR", "TL"),
            5 to listOf("TL", "BL", "TR"),
            6 to listOf("TR", "BR", "TL"),
            7 to listOf("BR", "TR", "BL"),
            8 to listOf("BL", "TL", "BR")
        )
        for ((orientation, want) in expected) {
            val plan = EvidencePhotoSizing.plan(4000, 3000, orientation)
            val m = plan.matrixValues(2000, 1500)
            val got = listOf(0f to 0f, 2000f to 0f, 0f to 1500f).map { (x, y) -> corner(plan, m, x, y) }
            assertEquals("EXIF orientation $orientation", want, got)
        }
    }

    @Test
    fun aShrunkPhotoReplacesTheOriginalAndLeavesNoTempFile() {
        val photo = folder.newFile("SYN-photo.jpg").apply { writeText("SYN-original 12 MP photo") }
        assertTrue(replaceFileSafely(photo) { it.write("SYN-shrunk photo".toByteArray()); true })
        assertEquals("SYN-shrunk photo", photo.readText())
        assertFalse(File(photo.path + ".tmp").exists())
    }

    @Test
    fun theOriginalPhotoIsKeptWhenShrinkingFails() {
        val photo = folder.newFile("SYN-photo.jpg").apply { writeText("SYN-original 12 MP photo") }
        // The JPEG encoder reports failure after writing part of the file.
        assertFalse(replaceFileSafely(photo) { it.write("SYN-partial".toByteArray()); false })
        // Nothing was written.
        assertFalse(replaceFileSafely(photo) { true })
        // Out of memory mid-write reaches EvidencePhoto's catch, which keeps the photo.
        assertThrows(OutOfMemoryError::class.java) {
            replaceFileSafely(photo) { it.write("SYN-partial".toByteArray()); throw OutOfMemoryError("SYN-test") }
        }
        assertEquals("SYN-original 12 MP photo", photo.readText())
        assertFalse(File(photo.path + ".tmp").exists())
    }

    @Test
    fun theStoredPhotoUsesTheTestedMatrixAndTheSafeReplace() {
        val source = File(appDir, "src/main/java/shop/youthnic/returnscan/util/EvidencePhoto.kt").readText()
        val downscale = source.substringAfter("fun downscaleInPlace(").substringBefore("internal fun replaceFileSafely(")
        assertTrue(downscale.contains("setValues(plan.matrixValues(src.width, src.height))"))
        assertTrue(downscale.contains("replaceFileSafely(file)"))
        assertFalse("the photo must only be replaced through replaceFileSafely", downscale.contains("renameTo("))
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
