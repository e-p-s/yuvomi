package de.eps.yuvomi.tracker

import android.content.Context
import android.content.SharedPreferences

/**
 * Unkritische lokale Praeferenzen: Onboarding-Fortschritt, letzter Replay-Fenster,
 * quota.state-Hinweis, exceptions_version-Cache.
 *
 * KEINE Secrets hier - Base-URL + Token leben ausschliesslich in PairingStore
 * (EncryptedSharedPreferences) und werden niemals geloggt.
 */
class Prefs private constructor(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    /** true nachdem Nutzer die Erklaerseite bestaetigt hat. */
    var onboardingAcknowledged: Boolean
        get() = prefs.getBoolean(KEY_ONBOARDING_ACK, false)
        set(value) = prefs.edit().putBoolean(KEY_ONBOARDING_ACK, value).apply()

    /** Ende des zuletzt gereplayten Fensters (rollierendes Fenster + Overlap). */
    var lastReplayEndMs: Long
        get() = prefs.getLong(KEY_LAST_REPLAY_END, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_REPLAY_END, value).apply()

    /** Cache des letzten exceptions_version vom Server (Invalidierung). */
    var exceptionsVersion: Int
        get() = prefs.getInt(KEY_EXCEPTIONS_VERSION, 0)
        set(value) = prefs.edit().putInt(KEY_EXCEPTIONS_VERSION, value).apply()

    /** serialisiertes JSON der gecachten Ausnahmen (match_type/pattern/exempt_from). */
    var exceptionsCacheJson: String?
        get() = prefs.getString(KEY_EXCEPTIONS_CACHE, null)
        set(value) {
            if (value == null) prefs.edit().remove(KEY_EXCEPTIONS_CACHE).apply()
            else prefs.edit().putString(KEY_EXCEPTIONS_CACHE, value).apply()
        }

    /** Letzter quota.state vom Server: ok | nearing | exceeded | quiet (nur Anzeige!). */
    var quotaState: String?
        get() = prefs.getString(KEY_QUOTA_STATE, null)
        set(value) = prefs.edit().putString(KEY_QUOTA_STATE, value).apply()

    /** Letzter quota.enforcement vom Server: count | lock (Serverentscheidung). */
    var quotaEnforcement: String?
        get() = prefs.getString(KEY_QUOTA_ENFORCEMENT, null)
        set(value) = prefs.edit().putString(KEY_QUOTA_ENFORCEMENT, value).apply()

    /** Offene Check-in-Sitzung (Einbuchen) vom Server, zuletzt gesehen (05.11.). */
    var checkedIn: Boolean
        get() = prefs.getBoolean(KEY_CHECKED_IN, false)
        set(value) = prefs.edit().putBoolean(KEY_CHECKED_IN, value).apply()

    /** Zustand, fuer den der Hinweis zuletzt gezeigt wurde (doppelt-show vermeiden). */
    var quotaLockedShownBy: String?
        get() = prefs.getString(KEY_QUOTA_LOCKED_SHOWN, null)
        set(value) = prefs.edit().putString(KEY_QUOTA_LOCKED_SHOWN, value).apply()

    /** true wenn Batterie-Ausnahme im Onboarding bereits erbeten wurde. */
    var batteryOptimizationAsked: Boolean
        get() = prefs.getBoolean(KEY_BATTERY_ASKED, false)
        set(value) = prefs.edit().putBoolean(KEY_BATTERY_ASKED, value).apply()

    /** Zeitstempel der letzten erfolgreichen Server-Kommunikation (ms). */
    var lastSyncOkMs: Long
        get() = prefs.getLong(KEY_LAST_SYNC_OK, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_SYNC_OK, value).apply()

    companion object {
        private const val FILE_NAME = "yuvomi_tracker_prefs"
        private const val KEY_ONBOARDING_ACK = "onboarding_ack"
        private const val KEY_LAST_REPLAY_END = "last_replay_end_ms"
        private const val KEY_EXCEPTIONS_VERSION = "exceptions_version"
        private const val KEY_EXCEPTIONS_CACHE = "exceptions_cache_json"
        private const val KEY_QUOTA_STATE = "quota_state"
        private const val KEY_QUOTA_ENFORCEMENT = "quota_enforcement"
        private const val KEY_CHECKED_IN = "checked_in"
        private const val KEY_QUOTA_LOCKED_SHOWN = "quota_locked_shown"
        private const val KEY_BATTERY_ASKED = "battery_asked"
        private const val KEY_LAST_SYNC_OK = "last_sync_ok_ms"

        @Volatile
        private var instance: Prefs? = null

        fun get(context: Context): Prefs =
            instance ?: synchronized(this) {
                instance ?: Prefs(context.applicationContext).also { instance = it }
            }
    }
}
