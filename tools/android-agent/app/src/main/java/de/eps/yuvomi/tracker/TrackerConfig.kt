package de.eps.yuvomi.tracker

import android.content.Context
import java.security.MessageDigest

/**
 * Konstanten und Hilfsfunktionen, die Replay und Sync gemeinsam brauchen.
 */
object TrackerConfig {
    /** Loest "App war schon vor Fensterbeginn im Vordergrund". */
    const val LOOKBACK_MS = 12L * 60L * 60L * 1000L

    /** Duenne Segmente (< 2-3 s) werden zusammengefuehrt (App-Wechsel-Rauschen). */
    const val MERGE_THRESHOLD_MS = 2_500L

    /** Takt des Services: queryEvents-Rollierendes Fenster alle 5 s, Heartbeat alle 60 s. */
    const val POLL_INTERVAL_MS = 5_000L
    const val HEARTBEAT_INTERVAL_MS = 60_000L

    /** Uploads bis 24 h rueckwirkend normal, danach source='backfill'. */
    const val BACKFILL_THRESHOLD_MS = 24L * 60L * 60L * 1000L

    /** max. Sessions pro Sync-Call (Server-Limit laut API-Skizze). */
    const val MAX_SESSIONS_PER_CALL = 200

    /** Server-Pfade (Prefix /api/v1/media-time). */
    const val PATH_SYNC = "/api/v1/media-time/tracker/sync"
    const val PATH_HEARTBEAT = "/api/v1/media-time/tracker/heartbeat"
    const val PATH_EXCEPTIONS = "/api/v1/media-time/tracker/exceptions"

    /** Package dieser App: serverseitig hart ausgenommen, clientseitig nie als Nutzung melden. */
    const val SELF_PACKAGE = "de.eps.yuvomi.tracker"

    fun sha256Hex(input: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    /**
     * session_key = sha256(deviceId | package | startedAtMillis) - Idempotenz
     * bei Nachmeldungen und Heartbeat-Verlaengerung (der Server treated gleiche
     * session_key als Update, nie als Doppelbuchung).
     */
    fun sessionKey(deviceId: String, pkg: String, startedAtMillis: Long): String =
        sha256Hex("$deviceId|$pkg|$startedAtMillis")
}
