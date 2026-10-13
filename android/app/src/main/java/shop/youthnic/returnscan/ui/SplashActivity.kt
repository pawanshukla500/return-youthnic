package shop.youthnic.returnscan.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.AuthExpiredException
import shop.youthnic.returnscan.data.NetworkException
import shop.youthnic.returnscan.databinding.ActivitySplashBinding

@SuppressLint("CustomSplashScreen")
class SplashActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySplashBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySplashBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val app = application as ReturnScanApp
        val sessionManager = app.sessionManager
        val apiClient = app.apiClient

        lifecycleScope.launch {
            if (!sessionManager.hasSession()) {
                navigateToLogin()
                return@launch
            }

            val result = withContext(Dispatchers.IO) {
                apiClient.getMe()
            }

            if (result.isSuccess) {
                navigateToChannels()
            } else {
                val ex = result.exceptionOrNull()
                if (ex is NetworkException) {
                    // Backend interruption / offline: preserve session and allow entry
                    navigateToChannels()
                } else if (ex is AuthExpiredException) {
                    // Revoked or expired session
                    sessionManager.clearSession()
                    navigateToLogin()
                } else {
                    // Transient error
                    navigateToChannels()
                }
            }
        }
    }

    private fun navigateToChannels() {
        startActivity(Intent(this, ChannelActivity::class.java))
        finish()
    }

    private fun navigateToLogin() {
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }
}
