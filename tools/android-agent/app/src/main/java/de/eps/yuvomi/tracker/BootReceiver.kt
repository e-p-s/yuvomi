package de.eps.yuvomi.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Startet den SyncService nach Reboot/Update erneut (START_STICKY deckt Reboot NICHT ab).
 * OEM-Hinweise (Samsung "Sleeping Apps", Xiaomi Autostart) stehen in
 * assets/oem-hinweise.html und werden im Onboarding verlinkt - diese Regeln lassen
 * sich nicht per Intent setzen und werden nach OTA-Updates gern zurueckgesetzt.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                // SyncService.startIfPaired prueft selbst: ohne Pairing kein Service,
                // ohne Usage-Freigabe keine Erfassung (ehrlich statt 0-Minus-Tag).
                SyncService.startIfPaired(context)
            }
        }
    }
}
