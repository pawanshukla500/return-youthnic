package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression test for the crash that closed the scanner as soon as a marketplace was tapped: strings that take a
 * formatted count ("1,234" from Ui.count) were declared with %d, and Android throws IllegalFormatConversionException
 * when a String meets %d. A unit test cannot inflate the screen, so this reads the sources and the string file.
 */
class StringFormatsTest {

    private val appDir: File = listOf(File("."), File("app"), File("android/app"))
        .first { File(it, "src/main/res/values/strings.xml").isFile }

    private fun stringsXml(): String = File(appDir, "src/main/res/values/strings.xml").readText()

    private fun valueOf(name: String): String {
        val match = Regex("""<string name="$name">(.*?)</string>""").find(stringsXml())
        assertTrue("string $name is missing", match != null)
        return match!!.groupValues[1]
    }

    @Test
    fun countStringsTakeTextNotNumbers() {
        assertEquals("%1\$s scanned today", valueOf("scanned_today_format"))
        assertEquals("%1\$s scannable", valueOf("scannable_badge_format"))
    }

    @Test
    fun noStringFedWithUiCountUsesANumericPlaceholder() {
        val numeric = Regex("""%(\d+\$)?[dxXfeEgG]""")
        val feeds = Regex("""getString\(\s*R\.string\.(\w+)\s*,\s*Ui\.count\(""")
        val offenders = mutableListOf<String>()
        File(appDir, "src/main/java").walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { file ->
            for (hit in feeds.findAll(file.readText())) {
                val name = hit.groupValues[1]
                if (numeric.containsMatchIn(valueOf(name))) offenders.add("${file.name}: $name")
            }
        }
        assertTrue("Ui.count returns text, so these strings need %s: $offenders", offenders.isEmpty())
    }

    @Test
    fun updateProgressStringTakesThePercentAndTwoSizes() {
        val format = valueOf("update_progress_format")
        assertTrue(format.contains("%1\$d"))
        assertTrue(format.contains("%2\$s"))
        assertTrue(format.contains("%3\$s"))
    }
}
