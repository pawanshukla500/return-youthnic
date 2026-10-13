package shop.youthnic.returnscan.ui

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch
import shop.youthnic.returnscan.BuildConfig
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.databinding.ActivitySettingsBinding
import shop.youthnic.returnscan.update.AppUpdater

class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val app = application as ReturnScanApp
        val sm = app.sessionManager

        binding.btnBackSettings.setOnClickListener { finish() }

        // Switch listeners
        binding.switchAudioBeep.isChecked = sm.soundEnabled
        binding.switchAudioBeep.setOnCheckedChangeListener { _, isChecked ->
            sm.soundEnabled = isChecked
        }

        binding.switchVibration.isChecked = sm.vibrationEnabled
        binding.switchVibration.setOnCheckedChangeListener { _, isChecked ->
            sm.vibrationEnabled = isChecked
        }

        binding.switchScreenFlash.isChecked = sm.screenFlashEnabled
        binding.switchScreenFlash.setOnCheckedChangeListener { _, isChecked ->
            sm.screenFlashEnabled = isChecked
        }

        // Server info
        binding.tvSettingsServerUrl.text = sm.serverUrl

        // App version
        binding.tvAppVersion.text = "Youthnic Return Scan v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"

        // Check for updates
        binding.btnCheckUpdates.setOnClickListener {
            binding.btnCheckUpdates.isEnabled = false
            lifecycleScope.launch {
                val result = AppUpdater.check(this@SettingsActivity, force = true)
                binding.btnCheckUpdates.isEnabled = true
                if (result.isSuccess) {
                    val release = result.getOrNull()
                    if (release != null) {
                        AppUpdater.showUpdateDialog(this@SettingsActivity, release, always = true)
                    } else {
                        Toast.makeText(this@SettingsActivity, "App is up to date", Toast.LENGTH_SHORT).show()
                    }
                } else {
                    Toast.makeText(this@SettingsActivity, "Failed to check for updates", Toast.LENGTH_SHORT).show()
                }
            }
        }

        // Logout
        binding.btnLogout.setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.logout_btn)
                .setMessage("Are you sure you want to sign out?")
                .setPositiveButton("Sign out") { _, _ ->
                    sm.clearSession()
                    val intent = Intent(this, LoginActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                    }
                    startActivity(intent)
                    finish()
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }
}
