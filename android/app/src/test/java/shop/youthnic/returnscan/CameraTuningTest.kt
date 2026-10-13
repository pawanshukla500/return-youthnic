package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import shop.youthnic.returnscan.util.CameraTuning

class CameraTuningTest {

    @Test
    fun testResolutions() {
        assertEquals(1280 to 720, CameraTuning.HD)
        assertEquals(1920 to 1080, CameraTuning.FULL_HD)
        assertEquals(CameraTuning.HD, CameraTuning.PREVIEW)
        assertEquals(CameraTuning.HD, CameraTuning.analysisSize(sharp = false))
        assertEquals(CameraTuning.FULL_HD, CameraTuning.analysisSize(sharp = true))
    }

    @Test
    fun testPickFpsRange() {
        val ranges = listOf(
            15 to 15,
            15 to 24,
            15 to 30,
            30 to 30
        )
        val picked = CameraTuning.pickFpsRange(ranges)
        assertNotNull(picked)
        assertEquals(15 to 24, picked)
    }

    @Test
    fun testPickFpsRangeWhenNoMatchingUpper() {
        val ranges = listOf(
            30 to 30,
            60 to 60
        )
        val picked = CameraTuning.pickFpsRange(ranges)
        assertNull(picked)
    }

    @Test
    fun testDescribe() {
        val text = CameraTuning.describe(1280, 720, 15 to 24)
        assertEquals("1280×720 · up to 24 fps", text)

        val textNoFps = CameraTuning.describe(1280, 720, null)
        assertEquals("1280×720", textNoFps)
    }
}
