package shop.youthnic.returnscan.update

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import shop.youthnic.returnscan.BuildConfig
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.AppRelease
import shop.youthnic.returnscan.databinding.DialogUpdateProgressBinding
import shop.youthnic.returnscan.util.Ui
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * In-app update manager checking backend release manifest (GET /api/app/latest or GitHub Releases).
 * Validates SHA-256 before prompting Android package installer via FileProvider.
 */
object AppUpdater {

    const val CHANNEL_ID = "app_updates"
    private const val NOTIFICATION_ID = 4201
    private const val PREFS = "return_scan_update_prefs"
    private const val KEY_NOTIFIED = "notified_version_code"
    private const val KEY_DOWNLOAD_ID = "download_id"
    private const val KEY_DOWNLOAD_VERSION = "download_version_code"
    private const val APK_MIME = "application/vnd.android.package-archive"
    private const val CHECK_EVERY_MS = 10 * 60 * 1000L
    private const val WORK_NAME = "return-scan-update-check"

    @Volatile
    var available: AppRelease? = null
        private set

    @Volatile
    private var lastCheckAt = 0L

    private var dialogShownFor = 0
    private var pendingInstall: File? = null

    val installedVersionCode: Int
        get() = BuildConfig.VERSION_CODE

    suspend fun check(context: Context, force: Boolean = false): Result<AppRelease?> {
        val now = SystemClock.elapsedRealtime()
        if (!force && lastCheckAt != 0L && now - lastCheckAt < CHECK_EVERY_MS) return Result.success(available)
        val app = context.applicationContext as ReturnScanApp
        val result: Result<AppRelease?> = withContext(Dispatchers.IO) { app.apiClient.getLatestRelease() }
        val release = result.getOrNull()
        if (result.isFailure || release == null) {
            val ex = result.exceptionOrNull() ?: IllegalStateException("No release available")
            return Result.failure(ex)
        }
        lastCheckAt = now
        val newer = release.takeIf { it.isNewerThan(installedVersionCode) }
        available = newer
        if (newer != null) notifyOnce(context.applicationContext, newer)
        return Result.success(newer)
    }

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID, context.getString(R.string.update_channel_name), NotificationManager.IMPORTANCE_DEFAULT
        )
        channel.description = context.getString(R.string.update_channel_desc)
        nm.createNotificationChannel(channel)
    }

    fun canNotify(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun notifyOnce(context: Context, release: AppRelease) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getInt(KEY_NOTIFIED, 0) >= release.versionCode) return
        if (!canNotify(context)) return
        ensureChannel(context)
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val tap = PendingIntent.getActivity(
            context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val text = context.getString(R.string.update_notification_text, release.versionName)
        val body = if (release.notes.isBlank()) text else "$text\n${release.notes}"
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_download)
            .setColor(ContextCompat.getColor(context, R.color.colorPrimary))
            .setContentTitle(context.getString(R.string.update_notification_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
            prefs.edit().putInt(KEY_NOTIFIED, release.versionCode).apply()
        } catch (_: SecurityException) {
        }
    }

    fun scheduleBackgroundCheck(context: Context) {
        try {
            val request = PeriodicWorkRequestBuilder<UpdateCheckWorker>(3, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        } catch (_: Exception) {
        }
    }

    fun showUpdateDialog(activity: AppCompatActivity, release: AppRelease, always: Boolean = false) {
        if (activity.isFinishing || activity.isDestroyed) return
        val required = release.isRequiredFor(installedVersionCode)
        if (!always && !required && dialogShownFor == release.versionCode) return
        dialogShownFor = release.versionCode
        val message = buildString {
            append(activity.getString(R.string.update_dialog_message, release.versionName, BuildConfig.VERSION_NAME))
            if (release.sizeBytes > 0) append(" (").append(Ui.megabytes(release.sizeBytes)).append(')')
            if (required) append("\n\n").append(activity.getString(R.string.update_required_message))
            if (release.notes.isNotBlank()) {
                append("\n\n").append(activity.getString(R.string.update_whats_new)).append('\n').append(release.notes)
            }
        }
        val builder = MaterialAlertDialogBuilder(activity)
            .setTitle(if (required) R.string.update_required_title else R.string.update_dialog_title)
            .setMessage(message)
            .setPositiveButton(R.string.update_install) { _, _ -> startUpdate(activity, release) }
            .setCancelable(!required)
        if (!required) builder.setNegativeButton(R.string.later, null)
        builder.show()
    }

    fun startUpdate(activity: AppCompatActivity, release: AppRelease) {
        val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
        val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
        if (dir == null || dm == null) {
            openDownloadPage(activity, release)
            return
        }
        val file = File(dir, "return-scan-${release.versionCode}.apk")
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val previousId = prefs.getLong(KEY_DOWNLOAD_ID, -1L)

        if (previousId >= 0 && prefs.getInt(KEY_DOWNLOAD_VERSION, 0) == release.versionCode) {
            val state = query(dm, previousId)
            if (state?.status == DownloadManager.STATUS_SUCCESSFUL && file.isFile) {
                verifyAndInstall(activity, release, file)
                return
            }
            if (state != null && state.status != DownloadManager.STATUS_FAILED) {
                showProgress(activity, dm, previousId, release, file)
                return
            }
        }

        if (previousId >= 0) {
            try {
                dm.remove(previousId)
            } catch (_: Exception) {}
        }
        dir.listFiles()?.filter { it.name.startsWith("return-scan-") && it.name.endsWith(".apk") }?.forEach { it.delete() }

        val request = DownloadManager.Request(Uri.parse(release.downloadUrl))
            .setTitle(activity.getString(R.string.update_download_title, release.versionName))
            .setDescription(activity.getString(R.string.app_name))
            .setMimeType(APK_MIME)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, file.name)
        val id = try {
            dm.enqueue(request)
        } catch (_: Exception) {
            openDownloadPage(activity, release)
            return
        }
        prefs.edit().putLong(KEY_DOWNLOAD_ID, id).putInt(KEY_DOWNLOAD_VERSION, release.versionCode).apply()
        showProgress(activity, dm, id, release, file)
    }

    private class DownloadState(val status: Int, val done: Long, val total: Long)

    private fun query(dm: DownloadManager, id: Long): DownloadState? {
        return try {
            dm.query(DownloadManager.Query().setFilterById(id))?.use { c ->
                if (!c.moveToFirst()) {
                    null
                } else {
                    DownloadState(
                        status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)),
                        done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),
                        total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    )
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun showProgress(activity: AppCompatActivity, dm: DownloadManager, id: Long, release: AppRelease, file: File) {
        val view = DialogUpdateProgressBinding.inflate(activity.layoutInflater)
        val dialog = MaterialAlertDialogBuilder(activity)
            .setTitle(activity.getString(R.string.update_downloading_title, release.versionName))
            .setView(view.root)
            .setNegativeButton(R.string.update_hide, null)
            .create()
        var job: Job? = null
        dialog.setOnDismissListener { job?.cancel() }
        dialog.show()
        job = activity.lifecycleScope.launch {
            while (isActive) {
                val state = withContext(Dispatchers.IO) { query(dm, id) }
                if (state == null || state.status == DownloadManager.STATUS_FAILED) {
                    dialog.setOnDismissListener(null)
                    dialog.dismiss()
                    showFailed(activity, release, damaged = false)
                    return@launch
                }
                if (state.status == DownloadManager.STATUS_SUCCESSFUL) {
                    dialog.setOnDismissListener(null)
                    dialog.dismiss()
                    verifyAndInstall(activity, release, file)
                    return@launch
                }
                if (state.total > 0) {
                    val pct = ((state.done * 100) / state.total).toInt().coerceIn(0, 100)
                    view.pbUpdateDownload.progress = pct
                    view.tvUpdateProgressPercent.text = activity.getString(
                        R.string.update_progress_format, pct, Ui.megabytes(state.done), Ui.megabytes(state.total)
                    )
                } else {
                    view.tvUpdateProgressPercent.text = activity.getString(R.string.update_waiting)
                }
                delay(400)
            }
        }
    }

    private fun verifyAndInstall(activity: AppCompatActivity, release: AppRelease, file: File) {
        activity.lifecycleScope.launch {
            val intact = withContext(Dispatchers.IO) {
                file.isFile && (release.sha256.isBlank() || sha256(file).equals(release.sha256, ignoreCase = true))
            }
            if (!intact) {
                file.delete()
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_DOWNLOAD_ID).apply()
                showFailed(activity, release, damaged = true)
                return@launch
            }
            install(activity, file)
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun install(activity: Activity, file: File) {
        if (activity.isFinishing || activity.isDestroyed) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            pendingInstall = file
            MaterialAlertDialogBuilder(activity)
                .setTitle(R.string.update_permission_title)
                .setMessage(R.string.update_permission_message)
                .setPositiveButton(R.string.update_open_settings) { _, _ -> openInstallPermission(activity) }
                .setNegativeButton(R.string.later, null)
                .show()
            return
        }
        pendingInstall = null
        val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)
        } else {
            Uri.fromFile(file)
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            activity.startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(activity, R.string.update_install_failed, Toast.LENGTH_LONG).show()
        }
    }

    private fun openInstallPermission(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
            )
        } catch (_: Exception) {
            activity.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS))
        }
    }

    fun resumePendingInstall(activity: Activity) {
        val file = pendingInstall ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) return
        pendingInstall = null
        if (file.isFile) install(activity, file)
    }

    private fun showFailed(activity: AppCompatActivity, release: AppRelease, damaged: Boolean) {
        if (activity.isFinishing || activity.isDestroyed) return
        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.update_failed_title)
            .setMessage(if (damaged) R.string.update_damaged_message else R.string.update_failed_message)
            .setPositiveButton(R.string.update_try_again) { _, _ -> startUpdate(activity, release) }
            .setNeutralButton(R.string.update_open_browser) { _, _ -> openDownloadPage(activity, release) }
            .setNegativeButton(R.string.close, null)
            .show()
    }

    fun openDownloadPage(activity: Activity, release: AppRelease) {
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(release.pageUrl)))
        } catch (_: Exception) {
            Toast.makeText(activity, release.pageUrl, Toast.LENGTH_LONG).show()
        }
    }
}
