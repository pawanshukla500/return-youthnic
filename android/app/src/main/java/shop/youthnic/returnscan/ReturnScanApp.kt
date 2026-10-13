package shop.youthnic.returnscan

import android.app.Application
import shop.youthnic.returnscan.data.ApiClient
import shop.youthnic.returnscan.data.ImageCache
import shop.youthnic.returnscan.data.SessionManager
import shop.youthnic.returnscan.update.AppUpdater
import shop.youthnic.returnscan.util.SoundManager

class ReturnScanApp : Application() {

    lateinit var sessionManager: SessionManager
        private set

    lateinit var apiClient: ApiClient
        private set

    lateinit var soundManager: SoundManager
        private set

    lateinit var imageCache: ImageCache
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        sessionManager = SessionManager(this)
        apiClient = ApiClient(sessionManager)
        soundManager = SoundManager(this, sessionManager)
        imageCache = ImageCache(this)

        AppUpdater.ensureChannel(this)
        AppUpdater.scheduleBackgroundCheck(this)
    }

    companion object {
        lateinit var instance: ReturnScanApp
            private set
    }
}
