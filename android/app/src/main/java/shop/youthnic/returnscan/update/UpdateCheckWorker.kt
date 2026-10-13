package shop.youthnic.returnscan.update

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/** Periodic background task checking for app updates */
class UpdateCheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        AppUpdater.check(applicationContext, force = true)
        return Result.success()
    }
}
