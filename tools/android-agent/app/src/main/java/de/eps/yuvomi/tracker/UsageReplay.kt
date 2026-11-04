package de.eps.yuvomi.tracker

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * "Global single foreground"-Replay nach docs/medienzeit-android-tracker.md Abschnitt C:
 * zu jedem Zeitpunkt zaehlt genau EIN Paket (per-Paket-Paarung erzeugte ueberlappende
 * Intervalle und blaehte die Summe auf - rikkahub-Referenz).
 *
 * Regeln:
 *  - ACTIVITY_RESUMED pkg t : vorheriges Segment schliessen, neues (pkg, t) oeffnen
 *  - ACTIVITY_PAUSED  pkg t : schliessen NUR wenn pkg == aktuellim Vordergrund-Paket, sonst ignorieren
 *  - SCREEN_NON_INTERACTIVE t : aktuelles Segment schliessen (Bildschirm aus = Schluss)
 *  - DEVICE_SHUTDOWN / DEVICE_BOOT : Reset-Marker (offenes Segment verwerfen), kein Segment-Ende
 *  - offene Segmente bei Fensterende mit windowEnd schliessen
 *  - Fenster-Raender auf [start, end] clippen (Lookback loest "App war schon vor Fensterbeginn im Vordergrund")
 *  - duenne Segmente < MERGE_THRESHOLD_MS zusammenfuehren (App-Wechsel-Rauschen, Dialoge)
 *  - Android R+: queryEvents liefert null/leer waehrend Display gesperrt => "unbekannt",
 *    NIEMALS als "0 Nutzung" buchen (sonst: 0-Minus-Tag durchs Sperrbildschirm-Raetsel)
 */
object UsageReplay {

    /**
     * Laedt Events via UsageStatsManager und replayt sie auf das Fenster [windowStart, windowEnd].
     * Der Aufrufer braucht PACKAGE_USAGE_STATS-Freigabe (siehe UsageAccess); ohne Freigabe
     * wirft queryEvents nichts brauchbares - der Caller prueft vorher und erfasst dann NICHTS
     * (ehrlich statt 0-Minus-Tag).
     */
    fun replayWindow(
        context: Context,
        windowStartMs: Long,
        windowEndMs: Long,
        deviceId: String
    ): ReplayResult {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val events = mutableListOf<TrackerEvent>()
        var queryFailed = false
        try {
            usm.queryEvents(windowStartMs, windowEndMs).use { ue: UsageEvents ->
                val ev = UsageEvents.Event()
                while (ue.hasNextEvent()) {
                    ue.getNextEvent(ev)
                    events.add(TrackerEvent.from(ev))
                }
            }
        } catch (_: Exception) {
            queryFailed = true
        }
        return replay(events, windowStartMs, windowEndMs, deviceId, queryFailed)
    }

    /**
     * Reines Replay ohne Android-Kontext - unit-testbar (JVM). events muss nach
     * timestampMs sortiert sein (UsageEvents liefert sortiert).
     */
    fun replay(
        events: List<TrackerEvent>,
        windowStartMs: Long,
        windowEndMs: Long,
        deviceId: String,
        queryFailed: Boolean = false
    ): ReplayResult {
        val sorted = events.sortedBy { it.timestampMs }

        // "unbekannt": Android R+ (API 30+) liefert keine Events, solange das Display
        // gesperrt ist. Leere Liste im Fenster mit Display-Sperr-Hinweis => unbekannt.
        // Wir buchen keine Session, aber der Aufrufer soll KEIN 0 melden.
        if (queryFailed || (sorted.isEmpty() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)) {
            return ReplayResult(
                sessions = emptyList(),
                unknownWindow = true,
                windowStartMs = windowStartMs,
                windowEndMs = windowEndMs
            )
        }

        data class OpenSeg(val pkg: String, var startMs: Long, var screenOnMs: Long)

        val sessions = mutableListOf<UsageSession>()
        var open: OpenSeg? = null
        var screenInteractive = false  // ohne SCREEN-Events im Fenster: konservativ "an"

        fun clipStart(t: Long) = maxOf(t, windowStartMs)
        fun clipEnd(t: Long) = minOf(t, windowEndMs)

        fun closeOpen(atMs: Long) {
            val seg = open ?: return
            open = null
            val s = clipStart(seg.startMs)
            val e = clipEnd(minOf(atMs, windowEndMs))
            if (e <= s) return
            val foregroundMs = e - s
            // screen_on-Metrik: Anteil, der mit SCREEN_INTERACTIVE ueberlappt.
            // Ohne interaktive Phase im Fenster zaehlt der Anteil 0 (Bildschirm war aus).
            val onMs = if (screenInteractive) {
                (seg.screenOnMs + (e - s))
            } else 0L
            sessions.add(
                UsageSession(
                    sessionKey = TrackerConfig.sessionKey(deviceId, seg.pkg, seg.startMs),
                    packageName = seg.pkg,
                    appLabel = null, // fuellt der Aufrufer aus dem PackageManager
                    startedAtMs = seg.startMs,
                    endedAtMs = atMs,
                    foregroundMs = foregroundMs,
                    screenOnMs = onMs.coerceAtMost(foregroundMs),
                    kind = "foreground",
                    systemComponent = isSystemPackage(seg.pkg),
                    backfillCandidate = (windowEndMs - seg.startMs) > TrackerConfig.BACKFILL_THRESHOLD_MS
                )
            )
        }

        for (ev in sorted) {
            when (ev.type) {
                TrackerEvent.TYPE_RESUMED -> {
                    val pkg = ev.packageName ?: continue
                    if (pkg == TrackerConfig.SELF_PACKAGE) continue // eigene App nie melden
                    closeOpen(ev.timestampMs)
                    open = OpenSeg(pkg, ev.timestampMs, 0L)
                }
                TrackerEvent.TYPE_PAUSED -> {
                    val pkg = ev.packageName ?: continue
                    // nur schliessen wenn dasselbe Paket im Vordergrund - sonst Overlap-Paarung ignorieren
                    if (open?.pkg == pkg) closeOpen(ev.timestampMs)
                }
                TrackerEvent.TYPE_SCREEN_INTERACTIVE -> {
                    screenInteractive = true
                }
                TrackerEvent.TYPE_SCREEN_NON_INTERACTIVE -> {
                    // Bildschirm aus: aktuelles Segment schliessen, Screen-Zeit einfrieren
                    open?.let { seg ->
                        seg.screenOnMs += (ev.timestampMs - maxOf(seg.startMs, windowStartMs))
                            .coerceAtLeast(0L)
                    }
                    closeOpen(ev.timestampMs)
                    screenInteractive = false
                }
                TrackerEvent.TYPE_SHUTDOWN, TrackerEvent.TYPE_BOOT -> {
                    // Reset-Marker: offenes Segment verwerfen (Gerat war aus, nicht "App lief")
                    open = null
                }
                else -> { /* FOREGROUND_SERVICE_* etc.: nicht als foreground verbuchen */ }
            }
        }

        // Fensterende: offenes Segment mit windowEnd schliessen
        closeOpen(windowEndMs)

        // Duenne Segmente merge: benachbarte Segmente derselben Paket-Laeufe < Schwelle.
        // Ein Shutdown/Boot-Reset hat das offene Segment bereits verworfen, dadurch
        // entsteht natuerlich eine Lucke - merge ueberbrickt sie nicht (Abstand = 0 nur
        // bei echtem App-Wechsel-Rauschen).
        val merged = mergeThinSegments(sessions, windowStartMs, windowEndMs)

        return ReplayResult(
            sessions = merged,
            unknownWindow = false,
            windowStartMs = windowStartMs,
            windowEndMs = windowEndMs
        )
    }

    /**
     * Duenne Segmente (< MERGE_THRESHOLD_MS) zusammenfuehren: App-Wechsel-Rauschen und
     * kurze Dialoge. Merge NUR wenn beide Segmente dasselbe Paket haben und zwischen ihnen
     * kein anderer Paket-Start lag (Abstand < Schwelle).
     */
    private fun mergeThinSegments(
        sessions: List<UsageSession>,
        windowStartMs: Long,
        windowEndMs: Long
    ): List<UsageSession> {
        if (sessions.isEmpty()) return sessions
        val out = mutableListOf<UsageSession>()
        for (s in sessions) {
            val last = out.lastOrNull()
            if (last != null &&
                last.packageName == s.packageName &&
                last.endedAtMs != null &&
                (s.startedAtMs - last.endedAtMs) < TrackerConfig.MERGE_THRESHOLD_MS &&
                s.foregroundMs < TrackerConfig.MERGE_THRESHOLD_MS
            ) {
                val gap = s.startedAtMs - last.endedAtMs
                out[out.size - 1] = last.copy(
                    endedAtMs = s.endedAtMs,
                    foregroundMs = last.foregroundMs + gap + s.foregroundMs,
                    screenOnMs = (last.screenOnMs + gap + s.screenOnMs)
                        .coerceAtMost(last.foregroundMs + gap + s.foregroundMs)
                )
            } else {
                out.add(s)
            }
        }
        // Nachtrag: Clipping nach Merge (foreground_ms bleibt >= 0, Ende <= windowEnd)
        return out.map { s ->
            val start = maxOf(s.startedAtMs, windowStartMs)
            val end = s.endedAtMs?.let { minOf(it, windowEndMs) }
            if (start == s.startedAtMs && end == s.endedAtMs) s
            else s.copy(
                startedAtMs = start,
                endedAtMs = end,
                foregroundMs = if (end != null) (end - start).coerceAtLeast(0L) else s.foregroundMs
            )
        }.filter { it.foregroundMs > 0 }
    }

    /**
     * System-Komponenten clientseitig als system=1 markieren (Server: implizite Ausnahme,
     * nie Abzug - Family-Link-Vorbild "System apps can't have app limits").
     * Laeufer (HOME-Resolver) und obligatorische Kern-Intents werden mitgeloest.
     */
    fun isSystemPackage(pkg: String): Boolean {
        if (pkg == "android") return true
        if (pkg.startsWith("android.autoinstalls.config.")) return true
        if (pkg == "com.android.systemui") return true
        val systemPrefixes = listOf(
            "com.android.",
            "com.google.android.",
            "com.samsung.",
            "com.xiaomi.",
            "com.miui."
        )
        return systemPrefixes.any { pkg.startsWith(it) }
    }

    /** Launcher-Paket(e) ermitteln (diese wie System behandeln: Startbildschirm ist keine App-Nutzung). */
    fun launcherPackages(context: Context): Set<String> {
        val pm = context.packageManager
        val out = mutableSetOf<String>()
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val resolves = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(intent, 0)
        }
        resolves.forEach { out.add(it.activityInfo.packageName) }
        return out
    }

    /** Anzeigename aus PackageManager (App-Label); null wenn Paket nicht mehr installiert. */
    fun appLabel(context: Context, pkg: String): String? = try {
        val pm = context.packageManager
        val ai = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getApplicationInfo(pkg, PackageManager.ApplicationInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            pm.getApplicationInfo(pkg, 0)
        }
        pm.getApplicationLabel(ai).toString()
    } catch (_: Exception) {
        null
    }
}
