package shop.youthnic.returnscan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * File Claim on the bench (Phase 2 item 2.4, AND-04) saves the scan first, through the same save and with the same
 * clientScanKey as Save, and opens the claim screen on that scan. The sheet, the scanner and the claim screen are Android
 * classes that cannot be built in a JVM unit test, so these tests read their source. The payload rules themselves (the
 * bench scan id wins over the lookup's, no body without it) are tested in ClaimPayloadTest.
 */
class FileClaimBenchScanTest {

    private val appDir: File = listOf(File("."), File("app"), File("android/app"))
        .first { File(it, "src/main/res/values/strings.xml").isFile }

    private fun source(name: String): String =
        File(appDir, "src/main/java/shop/youthnic/returnscan/ui/$name").readText()

    @Test
    fun fileClaimRunsTheSameSaveAsSaveBeforeOpeningTheClaimScreen() {
        val sheet = source("ReturnVerificationBottomSheet.kt")
        val actions = sheet.substringAfter("private fun setupActions()").substringBefore("private fun submitScan(")
        val fileClaim = actions.substringAfter("binding.btnFileClaim.setOnClickListener")
            .substringBefore("binding.btnSaveVerification.setOnClickListener")
        assertTrue(fileClaim.contains("submitScan(afterSave = { receipt -> openClaimCapture(receipt.id) })"))
        assertFalse("File Claim must not close the sheet before the scan is saved", fileClaim.contains("dismiss()"))
        assertFalse("File Claim must not open the claim screen before the save", fileClaim.contains("startActivity("))
        assertTrue(actions.contains("binding.btnSaveVerification.setOnClickListener { submitScan(afterSave = null) }"))
        // One save path: the sheet hands the scan to onSave in one place, and never calls the API itself.
        assertEquals(1, Regex("""\bonSave\(""").findAll(sheet).count())
        assertFalse(sheet.contains("apiClient"))
    }

    @Test
    fun fileClaimRefusesASheetWithNoRealIssueBeforeItSaves() {
        // Every item starts on "No issue". File Claim saves the scan for good, so on that sheet it would save a CLEAR scan
        // and file it under a default issue; the operator marks the issue first.
        val sheet = source("ReturnVerificationBottomSheet.kt")
        val fileClaim = sheet.substringAfter("binding.btnFileClaim.setOnClickListener")
            .substringBefore("binding.btnSaveVerification.setOnClickListener")
        val guard = fileClaim.indexOf("if (!hasRealIssue())")
        val save = fileClaim.indexOf("submitScan(")
        assertTrue("File Claim must check for a real issue", guard >= 0)
        assertTrue("File Claim must check before it saves", guard < save)
        assertTrue("File Claim must stop on a sheet with no real issue", fileClaim.substring(guard, save).contains("return@setOnClickListener"))
        // Save is unchanged: a clear return is still saved with Save.
        assertTrue(sheet.contains("binding.btnSaveVerification.setOnClickListener { submitScan(afterSave = null) }"))
    }

    @Test
    fun aSaveInProgressBlocksASecondTapAndAFailedSaveKeepsTheSheetOpen() {
        val sheet = source("ReturnVerificationBottomSheet.kt")
        val submit = sheet.substringAfter("private fun submitScan(").substringBefore("onSave(")
        assertTrue(submit.contains("binding.btnSaveVerification.isEnabled = false"))
        assertTrue(submit.contains("binding.btnFileClaim.isEnabled = false"))
        assertTrue("a File Claim save cannot be swiped away", submit.contains("setCancelable(false)"))
        val error = sheet.substringAfter("fun showSaveError(").substringBefore("private fun showError(")
        assertTrue(error.contains("binding.btnFileClaim.isEnabled = true"))
        assertTrue(error.contains("setCancelable(true)"))
        assertFalse("a failed save opens no claim screen", error.contains("ClaimCaptureActivity"))
    }

    @Test
    fun theClaimScreenOpensWithTheSavedScansId() {
        val sheet = source("ReturnVerificationBottomSheet.kt")
        val open = sheet.substringAfter("private fun openClaimCapture(scanId: Int)").substringBefore("private fun validateInputs(")
        assertTrue(open.contains("putExtra(ClaimCaptureActivity.EXTRA_SCAN_ID, scanId)"))
        // The expected return the scan was saved on (the save's shipmentId), so a parcel's other return is told apart.
        assertTrue(open.contains("putExtra(ClaimCaptureActivity.EXTRA_EXPECTED_RETURN_ID, lookup.shipmentId.toIntOrNull() ?: 0)"))
        // Only File Claim's afterSave opens the claim screen; nothing else in the sheet does.
        assertEquals(1, Regex("""ClaimCaptureActivity::class\.java""").findAll(sheet).count())
    }

    @Test
    fun saveAndFileClaimShareOneClientScanKeyAndFileClaimWaitsForTheSavedId() {
        val scanner = source("ScannerActivity.kt")
        val show = scanner.substringAfter("private fun showVerificationSheet(").substringBefore("private fun onVerificationSheetClosed(")
        assertEquals("one clientScanKey per opened return", 1, Regex("""generateClientScanKey\(""").findAll(show).count())
        assertTrue(show.contains("commitVerificationSave(activeVerificationSheet, idempotencyKey, lookup, submitData, afterSave)"))

        val commit = scanner.substringAfter("private fun commitVerificationSave(").substringBefore("private fun onSaveSuccess(")
        assertTrue("File Claim needs the saved scan's id", commit.contains("if (receipt != null && (afterSave == null || receipt.id > 0))"))
        assertTrue(
            "the claim screen opens only after the save succeeded",
            commit.indexOf("onSaveSuccess(owner, lookup, receipt, data)") < commit.indexOf("afterSave?.invoke(receipt)")
        )
        assertTrue("a failed save is shown on the sheet it came from", commit.contains("owner.showSaveError(message)"))
    }

    @Test
    fun theClaimScreenFilesOnTheBenchScanFromItsIntent() {
        val claim = source("ClaimCaptureActivity.kt")
        assertTrue(claim.contains("intent.getIntExtra(EXTRA_SCAN_ID, 0)"))
        assertTrue(claim.contains("intent.getIntExtra(EXTRA_EXPECTED_RETURN_ID, 0)"))
        assertTrue(claim.contains("BenchScan(scanId, subOrder, awb, expectedReturnId)"))
        assertTrue(claim.contains("ClaimPayload.build(lookupData, form, benchScan)"))
    }

    @Test
    fun fileNextReturnOpensAFreshScreenSoARecreationCannotBringTheFirstReturnBack() {
        // Clearing the screen in place (benchScan = null) was undone when Android recreated it from the File Claim intent:
        // the first return and its bench scan came back and the next return's evidence was deleted. A fresh screen with
        // no extras has nothing of the first return to restore.
        val claim = source("ClaimCaptureActivity.kt")
        val reset = claim.substringAfter("private fun resetFormForNextClaim(").substringBefore("private fun showInfoDialog(")
        assertTrue(reset.contains("startActivity(Intent(this, ClaimCaptureActivity::class.java))"))
        assertTrue(reset.contains("finish()"))
        assertFalse("the fresh screen carries no extras of the first return", reset.contains("putExtra"))
        // The order and product cards were hidden for every later return and nothing showed them again.
        assertFalse(claim.contains("cardProductPreview.visibility = View.GONE"))
        assertFalse(claim.contains("cardOrderSummary.visibility = View.GONE"))
    }

    @Test
    fun theClaimScreenRefusesAReturnWithNoSavedBenchScanBeforeTheEvidenceStep() {
        // Owner decision (2026-11-20): the Claims card opens this screen with no EXTRA_SCAN_ID, and its return may never have
        // been saved. Proceed (the way into the evidence step) and Submit both stop on ClaimPayload.benchScanIdFor.
        val claim = source("ClaimCaptureActivity.kt")
        val block = claim.substringAfter("private fun benchScanBlockMessage(").substringBefore("private fun showStep(")
        // The rule and its messages are ClaimPayload.benchScanBlockMessage, tested in ClaimPayloadTest.
        assertTrue(block.contains("ClaimPayload.benchScanBlockMessage(benchScan, found)"))
        val proceed = claim.substringAfter("private fun validateStep1(").substringBefore("private fun benchScanBlockMessage(")
        assertTrue("Proceed must refuse a return with no saved bench scan", proceed.contains("benchScanBlockMessage(subOrder, awb)"))
        val submit = claim.substringAfter("private fun submitCompleteClaim(").substringBefore("Validate required evidence fields")
        assertTrue(submit.contains("ClaimPayload.build(lookupData, form, benchScan)"))
        assertTrue("Submit must say why it sent nothing", submit.contains("benchScanBlockMessage(form.subOrderId, form.awb)"))
    }
}
