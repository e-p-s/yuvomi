package de.eps.yuvomi.tracker

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

/**
 * Persistiert Pairing-Daten (Base-URL + Geraete-Token) in EncryptedSharedPreferences.
 *
 * Grund fuer Verschluesselung: das Geraet-Token ist ein Schreib-Credential
 * (Scope media:write). Es darf nie geloggt, nie als Klartext-Pref gespeichert werden.
 * Der Token bleibt gueltig bis Revoke am Server (UI der Eltern); Factory-Reset
 * loescht lokal alles => Neu-Pairing noetig, Server sieht Sprung in last_seen_at.
 */
class PairingStore private constructor(context: Context) {

    private val prefs = runCatching {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }.getOrElse {
        // MasterKey-Defekt (selten, z.B. nach Backup-Restore):Prefs neu anlegen.
        // Das loescht bewusst das Token - ein halboffenes Credential ist schlechter.
        context.deleteSharedPreferences(FILE_NAME)
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    var baseUrl: String?
        get() = prefs.getString(KEY_BASE_URL, null)
        set(value) {
            if (value == null) prefs.edit().remove(KEY_BASE_URL).apply()
            else prefs.edit().putString(KEY_BASE_URL, value.trimEnd('/')).apply()
        }

    var deviceToken: String?
        get() = prefs.getString(KEY_DEVICE_TOKEN, null)
        set(value) {
            if (value == null) prefs.edit().remove(KEY_DEVICE_TOKEN).apply()
            else prefs.edit().putString(KEY_DEVICE_TOKEN, value).apply()
        }

    /** Stabile Geraete-ID fuer session_key; ueberlebt App-Updates, faellt bei Reset neu. */
    var deviceId: String
        get() {
            var id = prefs.getString(KEY_DEVICE_ID, null)
            if (id == null) {
                id = UUID.randomUUID().toString()
                prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            }
            return id
        }
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value).apply()

    val isPaired: Boolean
        get() = !baseUrl.isNullOrBlank() && !deviceToken.isNullOrBlank()

    fun clear() {
        prefs.edit()
            .remove(KEY_BASE_URL)
            .remove(KEY_DEVICE_TOKEN)
            .apply()
        // deviceId bleibt: session_keys bleiben nachbesserbar, wenn neu gepaart wird.
    }

    companion object {
        private const val FILE_NAME = "yuvomi_pairing"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_DEVICE_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"

        @Volatile
        private var instance: PairingStore? = null

        fun get(context: Context): PairingStore =
            instance ?: synchronized(this) {
                instance ?: PairingStore(context.applicationContext).also { instance = it }
            }
    }
}
