package de.eps.yuvomi.tracker

import android.app.usage.UsageEvents
import java.io.Serializable

/**
 * Session-Datenmodell (Client-Sicht). Passt zur Server-Tabelle media_time_usage_sessions
 * (docs/medienzeit-android-tracker.md, Abschnitt C/H).
 *
 * Wichtige Invarianten:
 *  - foreground_ms ist NUR die ACTIVITY_RESUMED->PAUSED-Summe, auf das Fenster geclippt.
 *  - ended_at == null heisst: laeuft noch (Heartbeat verlaengert, idempotent ueber session_key).
 *  - "unbekannt" (Android R+ queryEvents leer bei Display-Lock) ist ein eigener Zustand,
 *    NIEMALS als 0 Nutzung umdeuten - sonst bestraft ein Display-Sperrbildschirm das Kind.
 */
data class UsageSession(
    val sessionKey: String,
    val packageName: String,
    val appLabel: String?,
    val startedAtMs: Long,
    val endedAtMs: Long?,
    val foregroundMs: Long,
    val screenOnMs: Long,
    val kind: String,          // foreground | screen_on | service
    val systemComponent: Boolean,
    /** start der Session > 24 h zurueck -> Server markiert source='backfill'. */
    val backfillCandidate: Boolean
) : Serializable

/** Ergebnis eines Replay-Durchlaufs. */
data class ReplayResult(
    val sessions: List<UsageSession>,
    /**
     * true wenn queryEvents im Fenster nichts geliefert hat, obwohl das Display
     * mutmasslich gesperrt war (Android R+ Verhalten). Konsumenten behandeln das
     * als "unbekannt", schreiben aber KEINE Null-Sessions.
     */
    val unknownWindow: Boolean,
    val windowStartMs: Long,
    val windowEndMs: Long
)

/**
 * Ein Event aus UsageEvents, normalisiert. Wir verwenden eine eigene kleine Struktur
 * statt UsageEvents.Event direkt, damit UsageReplay ohne Android-Kontext testbar bleibt.
 */
data class TrackerEvent(
    val packageName: String?,   // null bei SCREEN_*-Events (Systemweite)
    val timestampMs: Long,
    val type: Int
) : Serializable {
    companion object {
        const val TYPE_RESUMED = UsageEvents.Event.ACTIVITY_RESUMED
        const val TYPE_PAUSED = UsageEvents.Event.ACTIVITY_PAUSED
        const val TYPE_SCREEN_INTERACTIVE = UsageEvents.Event.SCREEN_INTERACTIVE
        const val TYPE_SCREEN_NON_INTERACTIVE = UsageEvents.Event.SCREEN_NON_INTERACTIVE
        const val TYPE_SHUTDOWN = UsageEvents.Event.DEVICE_SHUTDOWN
        const val TYPE_BOOT = UsageEvents.Event.DEVICE_BOOT

        fun from(e: UsageEvents.Event): TrackerEvent =
            TrackerEvent(e.packageName, e.timeStamp, e.eventType)
    }
}

/** Match einer serverseitigen Ausnahme (media_time_app_exceptions). */
data class AppException(
    val id: Long,
    val userId: Int?,        // null = Haushalts-Default
    val matchType: String,   // exact | prefix | glob
    val pattern: String,
    val exemptFrom: String   // quota | history
) : Serializable

/** Klassifizierung einer Session fuer die Anzeige auf dem Geraet (nur Hinweis-Text).
 *  Der ABZUG entscheidet ausschliesslich der Server - der Client kennt keine
 *  Ausnahme-Logik im Uebertragungsformat, nur diesen Cache fuer die lokale Anzeige. */
enum class Classification { CHARGED, EXEMPT, SYSTEM, UNKNOWN }
