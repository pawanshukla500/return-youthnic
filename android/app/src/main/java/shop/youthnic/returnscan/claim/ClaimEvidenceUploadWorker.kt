package shop.youthnic.returnscan.claim

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.ApiException
import java.io.File
import java.util.concurrent.TimeUnit

class ClaimEvidenceUploadWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val claimId = inputData.getInt(KEY_CLAIM_ID, 0)
        val fieldKey = inputData.getString(KEY_FIELD_KEY).orEmpty()
        val filePath = inputData.getString(KEY_FILE_PATH).orEmpty()
        val mimeType = inputData.getString(KEY_MIME_TYPE).orEmpty()
        if (claimId <= 0 || fieldKey.isBlank() || filePath.isBlank() || mimeType.isBlank()) {
            return failed(claimId, fieldKey, "The upload was queued without its claim, slot or file.")
        }

        val file = File(filePath)
        if (!file.exists() || file.length() == 0L) return failed(claimId, fieldKey, "The evidence file is no longer on this phone.")
        val fileBytes = file.length()
        val app = applicationContext as ReturnScanApp
        val upload = uploadSlots.withPermit {
            val foreground = EvidenceUploads.needsForeground(fileBytes) && promoteToForeground(foregroundInfo(0))
            var reported = 0L
            app.apiClient.uploadClaimEvidence(claimId, fieldKey, file, mimeType) { sent, total ->
                if (EvidenceUploads.shouldReportBytes(reported, sent, total)) {
                    reported = sent
                    setProgressAsync(Data.Builder().putLong(KEY_BYTES_SENT, sent).build())
                    if (foreground) setForegroundAsync(foregroundInfo(EvidenceUploads.percentOf(sent, total)))
                }
            }
        }
        if (upload.isSuccess) {
            try {
                if (file.exists()) {
                    file.delete()
                }
            } catch (_: Exception) {}
            return Result.success(Data.Builder().putLong(KEY_BYTES_SENT, fileBytes).build())
        }
        val error = upload.exceptionOrNull()
        if (error is ApiException && EvidenceUploads.isPermanentFailure(error.code)) {
            // Sending it again would be refused the same way. Stop, and keep the reason for the operator to see.
            return failed(claimId, fieldKey, error.message?.ifBlank { null } ?: "Refused with HTTP ${error.code}")
        }
        return Result.retry()
    }

    /**
     * Makes this job foreground work (creating its quiet notification channel once), so Android's ~10-minute limit
     * cannot stop a big upload half-way. Android 12+ refuses while the app is in the background (a retry, say); the
     * upload then runs as ordinary work.
     */
    private suspend fun promoteToForeground(info: ForegroundInfo): Boolean = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = applicationContext.getSystemService(NotificationManager::class.java)
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, applicationContext.getString(R.string.evidence_upload_channel_name), NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
        setForeground(info)
        true
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        false
    }

    private fun foregroundInfo(percent: Int): ForegroundInfo {
        val context = applicationContext
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(context.getString(R.string.evidence_upload_title))
            .setContentText(context.getString(R.string.evidence_upload_progress, percent))
            .setProgress(100, percent, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
        // One notification per job: two big files can upload at once.
        val notificationId = id.hashCode()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(notificationId, notification)
        }
    }

    private fun failed(claimId: Int, fieldKey: String, reason: String): Result = Result.failure(
        Data.Builder()
            .putInt(KEY_CLAIM_ID, claimId)
            .putString(KEY_FIELD_KEY, fieldKey)
            .putString(KEY_ERROR, reason)
            .build()
    )

    companion object {
        const val KEY_CLAIM_ID = "claim_id"
        const val KEY_FIELD_KEY = "field_key"
        const val KEY_FILE_PATH = "file_path"
        const val KEY_MIME_TYPE = "mime_type"
        const val KEY_ERROR = "error"
        /** Bytes of the file sent so far: the job's progress while it runs, and the whole file once it succeeded. */
        const val KEY_BYTES_SENT = "bytes_sent"

        private const val CHANNEL_ID = "evidence_uploads"

        /** Shared by every upload job in the app, so only [EvidenceUploads.PARALLEL_UPLOADS] files go at once. */
        private val uploadSlots = Semaphore(EvidenceUploads.PARALLEL_UPLOADS)

        /** WorkManager tags every job with its worker's class name, so this lists every evidence upload, older builds' too. */
        val ALL_UPLOADS_TAG: String = ClaimEvidenceUploadWorker::class.java.name

        /**
         * Queues [file] for upload to [claimId] as its own unique job. WorkManager keeps the job across app kills and
         * reboots and retries it when the network is back; the job deletes the file once the server has it.
         */
        fun enqueue(context: Context, claimId: Int, fieldKey: String, file: File, mimeType: String) {
            val inputData = Data.Builder()
                .putInt(KEY_CLAIM_ID, claimId)
                .putString(KEY_FIELD_KEY, fieldKey)
                .putString(KEY_FILE_PATH, file.absolutePath)
                .putString(KEY_MIME_TYPE, mimeType)
                .build()
            val request = OneTimeWorkRequestBuilder<ClaimEvidenceUploadWorker>()
                .setInputData(inputData)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .addTag(EvidenceUploads.claimTag(claimId))
                .addTag(EvidenceUploads.fileTag(file.name))
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(EvidenceUploads.workName(claimId, file.name), ExistingWorkPolicy.KEEP, request)
        }

        /** How the claim screen sees one upload job. */
        fun uploadOf(info: WorkInfo): EvidenceUploads.Upload = EvidenceUploads.Upload(
            finished = info.state.isFinished,
            succeeded = info.state == WorkInfo.State.SUCCEEDED,
            claimId = info.outputData.getInt(KEY_CLAIM_ID, 0),
            fieldKey = info.outputData.getString(KEY_FIELD_KEY).orEmpty(),
            error = info.outputData.getString(KEY_ERROR).orEmpty(),
            bytesSent = when (info.state) {
                WorkInfo.State.SUCCEEDED -> info.outputData.getLong(KEY_BYTES_SENT, 0L)
                WorkInfo.State.RUNNING -> info.progress.getLong(KEY_BYTES_SENT, 0L)
                else -> 0L
            }
        )

        /**
         * At start-up, on a background thread: deletes old evidence files that neither the claim screen's draft nor
         * an unfinished upload still needs ([EvidenceUploads.purgeUnused]). When either list cannot be read, or an
         * unfinished upload does not name its file (one queued by an older build), nothing is deleted.
         */
        fun purgeUnusedFiles(context: Context) {
            val app = context.applicationContext
            Thread {
                try {
                    val draftStore = EvidenceDraftStore(File(app.filesDir, EvidenceUploads.DRAFT_FILE))
                    val draft = draftStore.load()
                    if (draft == null && draftStore.exists()) return@Thread
                    val keep = HashSet<String>()
                    draft?.let { keep.addAll(it.fileNames()) }
                    for (info in WorkManager.getInstance(app).getWorkInfosByTag(ALL_UPLOADS_TAG).get()) {
                        if (info.state.isFinished) continue
                        keep.add(EvidenceUploads.fileNameFromTags(info.tags) ?: return@Thread)
                    }
                    EvidenceUploads.purgeUnused(File(app.filesDir, EvidenceUploads.DIR), keep, System.currentTimeMillis())
                } catch (_: Exception) {
                    // Left for the next start.
                }
            }.start()
        }
    }
}
