package shop.youthnic.returnscan.claim

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.ApiException
import java.io.File

class ClaimEvidenceUploadWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val claimId = inputData.getInt(KEY_CLAIM_ID, 0)
        val fieldKey = inputData.getString(KEY_FIELD_KEY).orEmpty()
        val filePath = inputData.getString(KEY_FILE_PATH).orEmpty()
        val mimeType = inputData.getString(KEY_MIME_TYPE).orEmpty()
        if (claimId <= 0 || fieldKey.isBlank() || filePath.isBlank() || mimeType.isBlank()) return Result.failure()

        val file = File(filePath)
        if (!file.exists()) return Result.failure()
        val app = applicationContext as ReturnScanApp
        val upload = app.apiClient.uploadClaimEvidence(claimId, fieldKey, file, mimeType)
        if (upload.isSuccess) {
            file.delete()
            return Result.success()
        }
        val error = upload.exceptionOrNull()
        if (error is ApiException && error.code in 400..499 && error.code != 408 && error.code != 429) {
            return Result.failure()
        }
        return Result.retry()
    }

    companion object {
        const val KEY_CLAIM_ID = "claim_id"
        const val KEY_FIELD_KEY = "field_key"
        const val KEY_FILE_PATH = "file_path"
        const val KEY_MIME_TYPE = "mime_type"
    }
}
