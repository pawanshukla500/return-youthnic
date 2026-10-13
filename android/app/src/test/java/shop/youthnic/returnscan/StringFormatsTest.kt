package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    // Every java.util.Formatter conversion that needs a number: d o x X e E f g G a A, with an optional argument index,
    // flags (such as , 0 + -), width and precision. So %d, %,d, %1$08d, %o, %a and %.2f are all caught.
    private val numericConversion = Regex("""%(\d+\$)?[-#+ 0,(]*\d*(\.\d+)?[doxXeEfgGaA]""")

    /** True when the format has a placeholder that only a number can fill. A literal percent sign (%%) is not one. */
    private fun hasNumericPlaceholder(format: String): Boolean =
        numericConversion.containsMatchIn(format.replace("%%", ""))

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
        val feeds = Regex("""getString\(\s*R\.string\.(\w+)\s*,\s*Ui\.count\(""")
        val offenders = mutableListOf<String>()
        File(appDir, "src/main/java").walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { file ->
            for (hit in feeds.findAll(file.readText())) {
                val name = hit.groupValues[1]
                if (hasNumericPlaceholder(valueOf(name))) offenders.add("${file.name}: $name")
            }
        }
        assertTrue("Ui.count returns text, so these strings need %s: $offenders", offenders.isEmpty())
    }

    @Test
    fun numericPlaceholderPatternCatchesEveryNumericConversion() {
        for (bad in listOf("%d", "%1\$d", "%,d", "%1\$08d", "%+d", "%o", "%x", "%X", "%a", "%.2f", "%5.1f", "%e")) {
            assertTrue("$bad should be seen as numeric", hasNumericPlaceholder("n: $bad items"))
        }
        for (fine in listOf("%s", "%1\$s", "%2\$s of %3\$s", "100%% of them", "%-10s")) {
            assertFalse("$fine should not be seen as numeric", hasNumericPlaceholder("n: $fine items"))
        }
    }

    @Test
    fun updateProgressStringTakesThePercentAndTwoSizes() {
        val format = valueOf("update_progress_format")
        assertTrue(format.contains("%1\$d"))
        assertTrue(format.contains("%2\$s"))
        assertTrue(format.contains("%3\$s"))
    }
}
