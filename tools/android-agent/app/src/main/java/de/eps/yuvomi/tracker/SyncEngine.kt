package de.eps.yuvomi.tracker

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Synchronisiert den Offline-Puffer mit dem Server und haelt den Ausnahmen-Cache frisch.
 *
 * Aufgerufen von: SyncService (60s-Takt + nach jedem Replay) und SyncWorker
 * (WorkManager, 15-min-Boden als Versicherung bei Doze/OEM-Drosselung).
 *
 * Nachmeldungen: Sessions, deren Start laenger als 24 h zurueckliegt, werden trotzdem gemeldet -
 * der Server akzeptiert bis 24 h normal und kennzeichnet darueber hinaus
 * source='backfill'. Der Client entscheidet das NICHT selbst (serverseitige
 * Autoritaet, analog minute_key).
 */
class SyncEngine(private val context: Context) {

    /**
     * Ein Durchlauf: ausstehende Sessions holen, POST /sync, Akzeptiertes loeschen,
     * Abgewiesenes mit Zaehler, quota.state persistieren, exceptions_version pruefen.
     *
     * Fehler (offline, 5xx): nichts loeschen, Versuch zaehlen, beim naechsten Durchlauf erneut.
     * 401/403 (Token widerrufen): Puffer behalten, Pairing aufloesen - Onboarding zeigt
     * "Bitte neu koppeln" (ehrlich, statt weiter ins Leere zu senden).
     */
    suspend fun runOnce(): Outcome = withContext(Dispatchers.IO) {
        val pairing = PairingStore.get(context)
        val baseUrl = pairing.baseUrl
        val token = pairing.deviceToken
        if (baseUrl.isNullOrBlank() || token.isNullOrBlank()) {
            return@withContext Outcome(0, null, ok = false, needsReconnect = false, offline = false)
        }
        val prefs = Prefs.get(context)
        val dao = TrackerDatabase.get(context).dao()

        // Retention: aeltere als 7 Tage alte Puffer-Eintraege fallen lassen (laenger
        // haelt weder der queryEvents-Speicher des Systems, noch wuerde der Server sie annehmen).
        dao.purgeOlderThan(System.currentTimeMillis() - 7L * 24L * 60L * 60L * 1000L)

        val pending = dao.pending(TrackerConfig.MAX_SESSIONS_PER_CALL)
        val http = Http(baseUrl, token)
        var quotaSeen: Http.QuotaState? = null
        var sent = 0

        if (pending.isNotEmpty()) {
            try {
                val resp = http.sync(pending)
                sent = pending.size
                quotaSeen = resp.quota
                val rejectedKeys = resp.rejected.map { it.sessionKey }.toSet()
                // Akzeptiert = alles ausser explizit abgewiesen (Fail-open bei unbekanntem
                // Paket: der Server antwortet mit 200 ohne reject-Eintrag).
                val acceptedKeys = pending.map { it.sessionKey }.filterNot { rejectedKeys.contains(it) }
                if (acceptedKeys.isNotEmpty()) dao.deleteByKeys(acceptedKeys)
                if (rejectedKeys.isNotEmpty()) {
                    dao.markAttempted(rejectedKeys.toList(), System.currentTimeMillis())
                }
                prefs.lastSyncOkMs = System.currentTimeMillis()
            } catch (e: Http.HttpSyncException) {
                if (e.code == 401 || e.code == 403) {
                    pairing.clear()
                    dao.markAttempted(pending.map { it.sessionKey }, System.currentTimeMillis())
                    return@withContext Outcome(0, null, ok = false, needsReconnect = true, offline = false)
                }
                dao.markAttempted(pending.map { it.sessionKey }, System.currentTimeMillis())
                return@withContext Outcome(0, null, ok = false, needsReconnect = false, offline = true)
            } catch (_: Exception) {
                dao.markAttempted(pending.map { it.sessionKey }, System.currentTimeMillis())
                return@withContext Outcome(0, null, ok = false, needsReconnect = false, offline = true)
            }
        } else {
            prefs.lastSyncOkMs = System.currentTimeMillis()
        }

        // quota.state persistieren: exceeded/quiet -> Hinweis in der UI.
        // Seit der Entscheidung vom 04.11. gilt: der Server entscheidet per
        // enforcement='lock', ob das Geraet melden und hinweisen darf. Der
        // Tracker blockiert andere Apps nie hart (Android ohne Device-Owner
        // erlaubt das nicht sauber), aber der Vollbild-Hinweis ist Pflicht.
        if (quotaSeen != null) {
            prefs.quotaState = quotaSeen.state
            prefs.quotaEnforcement = quotaSeen.enforcement
            // Check-in-Anzeige (05.11.): offene Einbuchung des Kindes auf diesem
            // Geraet - die Tracker-UI zeigt sie als "eingebucht".
            prefs.checkedIn = quotaSeen.checkedIn
            TimeUpActivity.showIfLocked(
                context, quotaSeen.enforcement, quotaSeen.state, quotaSeen.reason
            )
        }

        // exceptions_version: bei Aenderung Ausnahmen neu laden und Cache ersetzen.
        try {
            val remote = http.fetchExceptions(userId = null)
            if (remote != null && remote.version != prefs.exceptionsVersion) {
                prefs.exceptionsVersion = remote.version
                prefs.exceptionsCacheJson = ExceptionCacheJson.encode(remote.items)
                dao.clearExceptions()
                dao.upsertExceptions(
                    remote.items.map {
                        ExceptionEntity(it.id, it.userId, it.matchType, it.pattern, it.exemptFrom)
                    }
                )
            }
        } catch (_: Exception) {
            // Ausnahmen-Cache bleibt beim alten Stand - nur Anzeige, kein Sync-Blocker.
        }

        Outcome(sent = sent, quotaState = quotaSeen?.state, ok = true, needsReconnect = false, offline = false)
    }

    /** Heartbeat eines noch laufenden Segments (idempotent ueber session_key). */
    suspend fun heartbeat(sessionKey: String, pkg: String): String? = withContext(Dispatchers.IO) {
        val pairing = PairingStore.get(context)
        val baseUrl = pairing.baseUrl
        val token = pairing.deviceToken
        if (baseUrl.isNullOrBlank() || token.isNullOrBlank()) return@withContext null
        try {
            val q = Http(baseUrl, token).heartbeat(sessionKey, pkg)
            q?.state?.let { Prefs.get(context).quotaState = it }
            q?.state
        } catch (e: Http.HttpSyncException) {
            if (e.code == 401 || e.code == 403) pairing.clear()
            null
        } catch (_: Exception) {
            null
        }
    }

    data class Outcome(
        val sent: Int,
        val quotaState: String?,
        val ok: Boolean,
        val needsReconnect: Boolean,
        val offline: Boolean
    )

    companion object {
        /** WorkManager-Kette (15-min-Boden) anlegen; idempotent (KEEP). */
        fun ensurePeriodicUpload(context: Context) = schedulePeriodicUpload(context)
    }
}
