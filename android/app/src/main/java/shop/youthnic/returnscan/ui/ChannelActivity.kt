package shop.youthnic.returnscan.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import shop.youthnic.returnscan.R
import shop.youthnic.returnscan.ReturnScanApp
import shop.youthnic.returnscan.data.AppRelease
import shop.youthnic.returnscan.data.AuthExpiredException
import shop.youthnic.returnscan.data.MarketplaceAccount
import shop.youthnic.returnscan.databinding.ActivityChannelBinding
import shop.youthnic.returnscan.databinding.ItemChannelCardBinding
import shop.youthnic.returnscan.update.AppUpdater
import shop.youthnic.returnscan.util.Ui

class ChannelActivity : AppCompatActivity() {

    private lateinit var binding: ActivityChannelBinding
    private var loading = false

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) AppUpdater.available?.let { AppUpdater.notifyOnce(this, it) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityChannelBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnSettings.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        binding.btnRefresh.setOnClickListener {
            loadAccounts()
        }

        binding.cardContinueLast.setOnClickListener {
            val sm = (application as ReturnScanApp).sessionManager
            if (sm.lastAccountId.isNotBlank()) {
                openScanner(sm.lastAccountId, sm.lastAccountName, sm.lastMarketplace, sm.lastColor)
            }
        }

        askNotificationPermissionOnce()
    }

    override fun onResume() {
        super.onResume()
        updateHeader()
        loadAccounts()
        checkForUpdate()
        AppUpdater.resumePendingInstall(this)
    }

    private fun askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val sm = (application as ReturnScanApp).sessionManager
        if (sm.askedNotificationPermission) return
        sm.askedNotificationPermission = true
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun checkForUpdate() {
        showUpdateCard(AppUpdater.available)
        lifecycleScope.launch {
            val release = AppUpdater.check(this@ChannelActivity).getOrNull()
            showUpdateCard(release)
            if (release != null) AppUpdater.showUpdateDialog(this@ChannelActivity, release)
        }
    }

    private fun showUpdateCard(release: AppRelease?) {
        if (release == null) {
            binding.cardUpdate.visibility = View.GONE
            return
        }
        binding.tvUpdateTitle.text = getString(R.string.update_banner_title, release.versionName)
        binding.cardUpdate.visibility = View.VISIBLE
        binding.cardUpdate.setOnClickListener { AppUpdater.startUpdate(this, release) }
    }

    private fun updateHeader() {
        val sm = (application as ReturnScanApp).sessionManager
        val user = sm.getUser()
        val name = user?.fullName?.ifBlank { user.email } ?: "Operator"
        val role = user?.role?.replaceFirstChar { it.uppercase() } ?: "Scanner"
        binding.tvUserInfo.text = "$name · $role"

        val lastId = sm.lastAccountId
        val lastName = sm.lastAccountName
        val lastMarketplace = sm.lastMarketplace
        if (lastId.isNotBlank() && lastName.isNotBlank()) {
            binding.cardContinueLast.visibility = View.VISIBLE
            binding.tvLastChannelName.text = if (lastMarketplace.isNotBlank() && lastMarketplace != lastName) {
                "$lastName ($lastMarketplace)"
            } else {
                lastName
            }
            val brand = ContextCompat.getColor(this, R.color.colorPrimary)
            Ui.tint(binding.viewLastMarker, Ui.parseColor(sm.lastColor, brand))
        } else {
            binding.cardContinueLast.visibility = View.GONE
        }
    }

    private fun loadAccounts() {
        if (loading) return
        loading = true
        val apiClient = (application as ReturnScanApp).apiClient
        binding.progressChannels.visibility = View.VISIBLE

        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { apiClient.getAccounts() }
            loading = false
            binding.progressChannels.visibility = View.INVISIBLE

            if (result.isSuccess) {
                renderAccounts(result.getOrNull().orEmpty())
            } else {
                val ex = result.exceptionOrNull()
                if (ex is AuthExpiredException) {
                    goToLogin()
                    return@launch
                }
                if (binding.layoutChannelsList.childCount == 0) {
                    binding.tvEmptyChannels.visibility = View.VISIBLE
                    binding.tvEmptyChannels.text = ex?.message ?: getString(R.string.no_channels)
                }
            }
        }
    }

    private fun renderAccounts(accounts: List<MarketplaceAccount>) {
        binding.layoutChannelsList.removeAllViews()

        if (accounts.isEmpty()) {
            binding.tvEmptyChannels.text = getString(R.string.no_channels)
            binding.tvEmptyChannels.visibility = View.VISIBLE
            return
        }
        binding.tvEmptyChannels.visibility = View.GONE

        val brand = ContextCompat.getColor(this, R.color.colorPrimary)
        val inflater = LayoutInflater.from(this)
        for (account in accounts) {
            val item = ItemChannelCardBinding.inflate(inflater, binding.layoutChannelsList, false)

            item.tvMarketplaceName.text = account.name
            item.tvAccountSubtitle.text = account.marketplace
            val color = Ui.parseColor(account.color, brand)
            Ui.tint(item.viewChannelMarker, color)

            if (account.scannableCount > 0) {
                item.tvScannableBadge.text = getString(R.string.scannable_badge_format, Ui.count(account.scannableCount))
                item.tvScannableBadge.visibility = View.VISIBLE
            } else {
                item.tvScannableBadge.text = "0 scannable"
                item.tvScannableBadge.visibility = View.VISIBLE
            }

            item.root.setOnClickListener {
                val sm = (application as ReturnScanApp).sessionManager
                sm.lastAccountId = account.id
                sm.lastAccountName = account.name
                sm.lastMarketplace = account.marketplace
                sm.lastColor = account.color ?: ""
                openScanner(account.id, account.name, account.marketplace, account.color ?: "")
            }

            binding.layoutChannelsList.addView(item.root)
        }
    }

    private fun openScanner(accountId: String, accountName: String, marketplace: String, color: String) {
        val intent = Intent(this, ScannerActivity::class.java).apply {
            putExtra(ScannerActivity.EXTRA_ACCOUNT_ID, accountId)
            putExtra(ScannerActivity.EXTRA_ACCOUNT_NAME, accountName)
            putExtra(ScannerActivity.EXTRA_MARKETPLACE, marketplace)
            putExtra(ScannerActivity.EXTRA_COLOR, color)
        }
        startActivity(intent)
    }

    private fun goToLogin() {
        startActivity(Intent(this, LoginActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        })
        finish()
    }
}
