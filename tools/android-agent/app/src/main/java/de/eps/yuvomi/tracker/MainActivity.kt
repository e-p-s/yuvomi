package de.eps.yuvomi.tracker

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.textfield.TextInputEditText

/**
 * Onboarding-Kette (Reihenfolge ist bewusst):
 *
 *  1. Erklaerseite: was erfasst wird - nur Paketname + Zeitraum, KEIN Inhalt,
 *     bewusst KEIN AccessibilityService (Begruendung: docs/medienzeit-android-tracker.md).
 *  2. Usage-Zugriff: AppOpsManager-Check; sonst Intent ACTION_USAGE_ACCESS_SETTINGS,
 *     re-check bei onResume. Ohne Freigabe wird nichts erfasst (ehrlich statt 0-Minus-Tag).
 *  3. Batterie-Ausnahme: ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS (Play-konform).
 *  4. Geraet-Pairing: Base-URL + Token (Eingabefelder oder yuvomi://pair?-Deep-Link /
 *     QR), gespeichert in EncryptedSharedPreferences, NIE geloggt.
 *  5. SyncService starten (specialUse-FGS + 60s-Heartbeat).
 *
 * OEM-Hinweise (Samsung/Xiaomi) stehen als statische Seite unter assets/oem-hinweise.html
 * und sind ab Schritt 1 verlinkt (lassen sich nicht per Intent setzen).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var titleView: TextView
    private lateinit var bodyView: TextView
    private lateinit var primaryButton: Button
    private lateinit var secondaryButton: Button
    private lateinit var pairingGroup: View
    private lateinit var baseUrlInput: TextInputEditText
    private lateinit var tokenInput: TextInputEditText
    private lateinit var statusView: TextView

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* egal: Service laeuft auch ohne */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        titleView = findViewById(R.id.onboarding_title)
        bodyView = findViewById(R.id.onboarding_body)
        primaryButton = findViewById(R.id.primary_button)
        secondaryButton = findViewById(R.id.secondary_button)
        pairingGroup = findViewById(R.id.pairing_group)
        baseUrlInput = findViewById(R.id.base_url_input)
        tokenInput = findViewById(R.id.token_input)
        statusView = findViewById(R.id.status_view)

        // Pairing per Deep-Link (yuvomi://pair?base=...&token=...) uebernehmen
        handlePairIntent(getIntent())

        findViewById<Button>(R.id.oem_link_button).setOnClickListener {
            // assets/oem-hinweise.html im externen Browser oeffnen (content-URI)
            try {
                val uri = Uri.parse("file:///android_asset/oem-hinweise.html")
                startActivity(
                    Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Exception) {
                statusView.text = getString(R.string.oem_open_failed)
            }
        }

        renderStep()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairIntent(intent)
        renderStep()
    }

    override fun onResume() {
        super.onResume()
        // Schritt 2 verlangt re-check nach Rueckkehr aus den Systemeinstellungen.
        renderStep()
    }

    // ---------------------------------------------------------------- Schritt-Maschine

    private fun currentStep(): Int {
        val prefs = Prefs.get(this)
        val pairing = PairingStore.get(this)
        return when {
            !prefs.onboardingAcknowledged -> STEP_EXPLAIN
            !UsageAccess.isGranted(this) -> STEP_USAGE
            !prefs.batteryOptimizationAsked -> STEP_BATTERY
            !pairing.isPaired -> STEP_PAIRING
            else -> STEP_DONE
        }
    }

    private fun renderStep() {
        pairingGroup.visibility = View.GONE
        when (currentStep()) {
            STEP_EXPLAIN -> {
                titleView.text = getString(R.string.step1_title)
                bodyView.text = getString(R.string.step1_body)
                primaryButton.text = getString(R.string.step1_next)
                primaryButton.setOnClickListener {
                    Prefs.get(this).onboardingAcknowledged = true
                    renderStep()
                }
                secondaryButton.visibility = View.GONE
            }
            STEP_USAGE -> {
                titleView.text = getString(R.string.step2_title)
                bodyView.text = getString(R.string.step2_body)
                primaryButton.text = getString(R.string.step2_open)
                primaryButton.setOnClickListener {
                    UsageAccess.openUsageAccessSettings(this)
                }
                secondaryButton.visibility = View.VISIBLE
                secondaryButton.text = getString(R.string.step2_recheck)
                secondaryButton.setOnClickListener { renderStep() }
                statusView.text = if (UsageAccess.isGranted(this)) {
                    getString(R.string.step2_granted)
                } else {
                    getString(R.string.step2_missing)
                }
            }
            STEP_BATTERY -> {
                titleView.text = getString(R.string.step3_title)
                bodyView.text = getString(R.string.step3_body)
                primaryButton.text = getString(R.string.step3_open)
                primaryButton.setOnClickListener {
                    UsageAccess.openBatteryOptimizationSettings(this)
                    Prefs.get(this).batteryOptimizationAsked = true
                    renderStep()
                }
                secondaryButton.visibility = View.VISIBLE
                secondaryButton.text = getString(R.string.step3_skip)
                secondaryButton.setOnClickListener {
                    Prefs.get(this).batteryOptimizationAsked = true
                    renderStep()
                }
                statusView.text = ""
            }
            STEP_PAIRING -> {
                titleView.text = getString(R.string.step4_title)
                bodyView.text = getString(R.string.step4_body)
                pairingGroup.visibility = View.VISIBLE
                val pairing = PairingStore.get(this)
                baseUrlInput.setText(pairing.baseUrl ?: defaultBaseUrl())
                primaryButton.text = getString(R.string.step4_pair)
                primaryButton.setOnClickListener { tryPairFromInputs() }
                secondaryButton.visibility = View.GONE
                statusView.text = getString(R.string.step4_hint)
            }
            STEP_DONE -> {
                titleView.text = getString(R.string.step5_title)
                bodyView.text = getString(R.string.step5_body)
                primaryButton.text = getString(R.string.step5_start)
                primaryButton.setOnClickListener { startTracking() }
                secondaryButton.visibility = View.VISIBLE
                secondaryButton.text = getString(R.string.step5_repair)
                secondaryButton.setOnClickListener {
                    PairingStore.get(this).clear()
                    renderStep()
                }
                statusView.text = statusLine()
            }
        }
    }

    // ---------------------------------------------------------------- Pairing

    /** Deep-Link yuvomi://pair?base=https://host:8443&token=*** */
    private fun handlePairIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "yuvomi" || data.host != "pair") return
        val base = data.getQueryParameter("base")
        val token = data.getQueryParameter("token")
        if (!base.isNullOrBlank() && !token.isNullOrBlank()) {
            val pairing = PairingStore.get(this)
            pairing.baseUrl = base
            pairing.deviceToken = token
            statusView.text = getString(R.string.pairing_saved)
        }
    }

    private fun defaultBaseUrl(): String =
        PairingStore.get(this).baseUrl ?: ""

    private fun tryPairFromInputs() {
        val base = baseUrlInput.text?.toString()?.trim().orEmpty()
        val token = tokenInput.text?.toString()?.trim().orEmpty()
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            statusView.text = getString(R.string.pairing_bad_url)
            return
        }
        if (token.isBlank()) {
            statusView.text = getString(R.string.pairing_bad_token)
            return
        }
        val pairing = PairingStore.get(this)
        pairing.baseUrl = base
        pairing.deviceToken = token
        // Token nie loggen (auch nicht debughalber).
        statusView.text = getString(R.string.pairing_saved)
        renderStep()
    }

    // ---------------------------------------------------------------- Service

    private fun startTracking() {
        // POST_NOTIFICATIONS ab API 33 anfragen; ablehnen blockiert den Service nicht.
        if (!UsageAccess.notificationsGranted(this) &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        SyncService.startIfPaired(this)
        statusView.text = getString(R.string.tracker_started)
    }

    private fun statusLine(): String {
        val prefs = Prefs.get(this)
        val last = prefs.lastSyncOkMs
        return if (last == 0L) {
            getString(R.string.status_no_sync_yet)
        } else {
            val ageMin = (System.currentTimeMillis() - last) / 60_000L
            getString(R.string.status_last_sync, ageMin)
        }
    }

    companion object {
        private const val STEP_EXPLAIN = 0
        private const val STEP_USAGE = 1
        private const val STEP_BATTERY = 2
        private const val STEP_PAIRING = 3
        private const val STEP_DONE = 4
    }
}
