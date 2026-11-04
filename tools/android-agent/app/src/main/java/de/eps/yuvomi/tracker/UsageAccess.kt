package de.eps.yuvomi.tracker

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings

/**
 * PACKAGE_USAGE_STATS ist KEINE Laufzeit-Berechtigung: Deklaration im Manifest erklaert
 * nur die Absicht; der Nutzer muss in den Systemeinstellungen freigeben. Kein Dialog,
 * keine automatisierte Vergabe moeglich - deshalb PRUEFEN (nicht anfragen) + Intent in
 * die Einstellungen.
 *
 * Pruefpfad ueber AppOpsManager (offiziell): unsafeCheckOpNoThrow(OPSTR_GET_USAGE_STATS)
 * == MODE_ALLOWED. unsafeCheckOpNoThrow ist API 29+; darunter checkOpNoThrow (API < 29,
 * deprecated aber funktional). minSdk 26 => beide Aeste.
 */
object UsageAccess {

    fun isGranted(context: Context): Boolean {
        return try {
            val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as android.app.AppOpsManager
            val uid = context.applicationInfo.uid
            val pkg = context.packageName
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                appOps.unsafeCheckOpNoThrow(
                    android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, uid, pkg
                )
            } else {
                @Suppress("DEPRECATION")
                appOps.checkOpNoThrow(
                    android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, uid, pkg
                )
            }
            mode == android.app.AppOpsManager.MODE_ALLOWED
        } catch (_: Exception) {
            // AppOps nicht erreichbar (rom-bereinigt o.ae.): wie "nicht erlaubt" behandeln.
            false
        }
    }

    /** Einstellungen -> App-Nutzung -> Schalter fuer de.eps.yuvomi.tracker an. */
    fun openUsageAccessSettings(context: Context) {
        val intent = android.content.Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: Exception) {
            // Manche ROMs haben die Seite nicht: ueber App-Details-Seite als Fallback.
            val fallback = android.content.Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.fromParts("package", context.packageName, null)
            ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(fallback)
            } catch (_: Exception) {
                // Nichts weiter zu tun: Onboarding zeigt statischen Pfad-Text.
            }
        }
    }

    /**
     * Batterie-Optimierung-Ausnahme erbitten: ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
     * (Play-konform; ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS ist Play-restringiert -
     * bei Sideloading zwar egal, aber der Einstellungen-Umweg ist transparenter).
     */
    fun openBatteryOptimizationSettings(context: Context) {
        val intent = android.content.Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: Exception) {
            val fallback = android.content.Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.fromParts("package", context.packageName, null)
            ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(fallback)
            } catch (_: Exception) {
                // Statisch im Onboarding erklaert.
            }
        }
    }

    /** true wenn POST_NOTIFICATIONS bereits erteilt (API 33+; aelter: immer true). */
    fun notificationsGranted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return androidx.core.content.ContextCompat.checkSelfPermission(
            context, android.Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }
}
