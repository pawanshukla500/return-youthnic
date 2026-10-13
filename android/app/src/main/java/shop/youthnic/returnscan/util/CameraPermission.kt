package shop.youthnic.returnscan.util

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.data.SessionManager

/**
 * The camera is the only permission the scanner cannot work without, so it is asked for in plain words at sign-in,
 * before the scanner opens. These helpers keep the three cases in one place: allowed, can still ask, and blocked
 * (the user chose "Don't allow" and Android no longer shows the dialog, so only the system settings can fix it).
 */
object CameraPermission {

    const val PERMISSION = Manifest.permission.CAMERA

    fun isGranted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, PERMISSION) == PackageManager.PERMISSION_GRANTED

    /** True when Android will not show the dialog again, so the app has to send the user to its settings page. */
    fun isBlocked(activity: Activity, sessionManager: SessionManager): Boolean =
        !isGranted(activity) &&
            sessionManager.askedCameraPermission &&
            !ActivityCompat.shouldShowRequestPermissionRationale(activity, PERMISSION)

    fun openAppSettings(context: Context) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: Exception) {
            context.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    /**
     * Explains why the camera is needed before Android's own dialog appears. [onAllow] runs when the user agrees
     * (launch the permission request there); [onSkip] runs when they decline, so the caller can carry on.
     */
    fun showRationale(activity: Activity, sessionManager: SessionManager, onAllow: () -> Unit, onSkip: () -> Unit) {
        if (activity.isFinishing || activity.isDestroyed) {
            onSkip()
            return
        }
        sessionManager.cameraRationaleShown = true
        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.camera_permission_title)
            .setMessage(R.string.camera_permission_message)
            .setCancelable(false)
            .setPositiveButton(R.string.camera_permission_allow) { _, _ -> onAllow() }
            .setNegativeButton(R.string.camera_permission_not_now) { _, _ -> onSkip() }
            .show()
    }
}
