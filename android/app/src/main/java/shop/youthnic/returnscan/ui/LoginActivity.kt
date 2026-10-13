package shop.youthnic.returnscan.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import shop.youthnic.returnscan.BuildConfig
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.databinding.ActivityLoginBinding
import shop.youthnic.returnscan.util.CameraPermission

class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding
    private var isServerConfigOpen = false

    // The answer to Android's own camera dialog. Signing in carries on whatever the user chooses: the scanner
    // explains the missing permission again, and Manual AWB works without the camera.
    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        openChannels()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val app = application as ReturnScanApp
        val sm = app.sessionManager
        val apiClient = app.apiClient

        binding.tvLoginFooter.text = "Youthnic Return Scan v${BuildConfig.VERSION_NAME} · VB Exports"

        // Server URL config setup
        binding.tvCurrentServerUrl.text = sm.serverUrl
        binding.etServerUrl.setText(sm.serverUrl)

        binding.btnToggleServerConfig.setOnClickListener {
            isServerConfigOpen = !isServerConfigOpen
            binding.tilServerUrl.visibility = if (isServerConfigOpen) View.VISIBLE else View.GONE
            binding.ivServerArrow.rotation = if (isServerConfigOpen) 90f else 0f
        }

        binding.btnLogin.setOnClickListener {
            val email = binding.etEmail.text?.toString()?.trim().orEmpty()
            val password = binding.etPassword.text?.toString().orEmpty()

            if (email.isEmpty() || password.isEmpty()) {
                showError(getString(R.string.error_credentials_required))
                return@setOnClickListener
            }

            // Save server URL if modified
            if (isServerConfigOpen) {
                val inputUrl = binding.etServerUrl.text?.toString()?.trim().orEmpty()
                if (inputUrl.isNotEmpty() && inputUrl != sm.serverUrl) {
                    sm.serverUrl = inputUrl.removeSuffix("/")
                    binding.tvCurrentServerUrl.text = sm.serverUrl
                }
            }

            hideError()
            setLoading(true)
            val rememberDevice = binding.cbRememberDevice.isChecked

            lifecycleScope.launch {
                val result = withContext(Dispatchers.IO) {
                    apiClient.login(email, password, rememberDevice)
                }

                setLoading(false)

                if (result.isSuccess) {
                    binding.etPassword.text?.clear()
                    askCameraThenContinue()
                } else {
                    val msg = result.exceptionOrNull()?.message ?: getString(R.string.login_failed)
                    showError(msg)
                }
            }
        }
    }

    /**
     * Signed in: before the marketplace list, explain why the camera is needed and ask for it. Nothing is asked when
     * the camera is already allowed, or when Android has blocked the dialog (the scanner then offers the Settings page).
     */
    private fun askCameraThenContinue() {
        val sm = (application as ReturnScanApp).sessionManager
        if (CameraPermission.isGranted(this) || CameraPermission.isBlocked(this, sm)) {
            openChannels()
            return
        }
        CameraPermission.showRationale(
            activity = this,
            sessionManager = sm,
            onAllow = {
                sm.askedCameraPermission = true
                cameraPermission.launch(CameraPermission.PERMISSION)
            },
            onSkip = { openChannels() }
        )
    }

    private fun openChannels() {
        startActivity(Intent(this, ChannelActivity::class.java))
        finish()
    }

    private fun setLoading(loading: Boolean) {
        binding.btnLogin.isEnabled = !loading
        binding.etEmail.isEnabled = !loading
        binding.etPassword.isEnabled = !loading
        binding.cbRememberDevice.isEnabled = !loading
        binding.progressLogin.visibility = if (loading) View.VISIBLE else View.GONE
        binding.btnLogin.text = if (loading) getString(R.string.signing_in) else getString(R.string.login_btn)
    }

    private fun showError(msg: String) {
        binding.tvLoginError.text = msg
        binding.tvLoginError.visibility = View.VISIBLE
    }

    private fun hideError() {
        binding.tvLoginError.visibility = View.GONE
    }
}
