package de.eps.yuvomi.tracker

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Dauerhafter Foreground-Service (specialUse) fuer:
 *  1. rollierendes UsageEvents-Replay alle 5 s -> pending_sessions (Room)
 *  2. Heartbeat/Upload alle 60 s (POST /sync; POST /heartbeat fuer laufendes Segment)
 *  3. Anzeige "Medienzeit wird erfasst" (POST_NOTIFICATIONS wird im Onboarding angefragt;
 *     ohne Freigabe laeuft der Service trotzdem, nur ohne sichtbare Meldung)
 *
 * START_STICKY: OEM-Kill -> Neustart durch das System. Reboot: BootReceiver.
 * WorkManager-Kette (15-min-Boden) laeuft zusaetzlich als Doze-Versicherung.
 */
class SyncService : Service() {

    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var loopJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundCompat(buildNotification(getString(R.string.notification_starting)))
        startLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY: nach OEM-Kill neu starten; Intent kann null sein -> Defaults.
        startForegroundCompat(buildNotification(notificationText()))
        startLoop()
        return START_STICKY
    }

    override fun onDestroy() {
        loopJob?.cancel()
        scope.coroutineContext[Job]?.cancel()
        super.onDestroy()
    }

    private fun startLoop() {
        if (loopJob?.isActive == true) return
        loopJob = scope.launch {
            var tick = 0
            while (isActive) {
                try {
                    tickOnce()
                } catch (_: Exception) {
                    // Der Tracker darf an einem einzelnen Tick nicht sterben:
                    // naechster Versuch in einem Durchlauf.
                }
                // Heartbeat alle 60 s (= alle 12 Ticks bei 5 s), sonst nur Replay
                if (tick % 12 == 11) {
                    try {
                        val outcome = SyncEngine(this@SyncService).runOnce()
                        updateNotificationFor(outcome)
                    } catch (_: Exception) {
                    }
                    // Doze-Versicherung: zusaetzlicher OneTime-Work, falls der Service
                    // kurz danach gedrosselt/getoetet wird.
                    WorkManager.getInstance(applicationContext)
                        .enqueue(OneTimeWorkRequestBuilder<SyncWorker>().build())
                }
                tick++
                delay(TrackerConfig.POLL_INTERVAL_MS)
            }
        }
    }

    /**
     * Ein Replay-Tick: rollierendes Fenster [lastEnd - overlap, now], Lookback 12 h als
     * Obergrenze. Ohne Usage-Freigabe wird bewusst NICHTS erfasst (ehrlich statt
     * 0-Minus-Tag) - dann laeuft nur der Heartbeat weiter, damit der Server
     * "Tracker offline"-Logik nicht ausgeloest wird, aber auch keine Nullen.
     */
    private suspend fun tickOnce() {
        if (!UsageAccess.isGranted(this)) return
        val pairing = PairingStore.get(this)
        if (!pairing.isPaired) return

        val prefs = Prefs.get(this)
        val now = System.currentTimeMillis()
        val floor = now - TrackerConfig.LOOKBACK_MS
        val overlapMs = 30_000L // kleiner Ueberlapp gegen verlorene Events an Fensterraendern
        var start = prefs.lastReplayEndMs - overlapMs
        if (start < floor || start <= 0L) start = floor

        val result = UsageReplay.replayWindow(this, start, now, pairing.deviceId)
        if (result.unknownWindow) {
            // Android R+ bei Display-Lock: keine Events => unbekannt, NICHT als 0 buchen.
            return
        }
        if (result.sessions.isEmpty()) {
            prefs.lastReplayEndMs = now
            return
        }

        val dao = TrackerDatabase.get(this).dao()
        val launchers = UsageReplay.launcherPackages(this)
        for (s in result.sessions) {
            if (s.packageName in launchers) continue // Startbildschirm ist keine App-Nutzung
            dao.upsertPending(
                PendingSessionEntity(
                    sessionKey = s.sessionKey,
                    packageName = s.packageName,
                    appLabel = s.appLabel ?: UsageReplay.appLabel(this, s.packageName),
                    startedAtMs = s.startedAtMs,
                    endedAtMs = s.endedAtMs,
                    foregroundMs = s.foregroundMs,
                    screenOnMs = s.screenOnMs,
                    kind = s.kind,
                    systemComponent = s.systemComponent
                )
            )
        }
        prefs.lastReplayEndMs = now
    }

    private fun updateNotificationFor(outcome: SyncEngine.Outcome) {
        val nm = getSystemService(android.app.NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(notificationText(outcome)))
    }

    private fun notificationText(outcome: SyncEngine.Outcome? = null): String {
        val prefs = Prefs.get(this)
        return when {
            outcome != null && outcome.needsReconnect -> getString(R.string.notification_reconnect)
            prefs.quotaState == "exceeded" -> getString(R.string.notification_quota_exceeded)
            prefs.quotaState == "quiet" -> getString(R.string.notification_quiet)
            outcome != null && outcome.offline -> getString(R.string.notification_offline)
            else -> getString(R.string.notification_tracking)
        }
    }

    private fun buildNotification(text: String): android.app.Notification {
        val tapIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, StatusActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, NotificationChannels.CHANNEL_TRACKER)
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(tapIntent)
            .build()
    }

    private fun startForegroundCompat(notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIF_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    companion object {
        const val NOTIF_ID = 4201

        /** Aus dem Onboarding/BootReceiver aufgerufen: Service starten, falls gepaart. */
        fun startIfPaired(context: Context) {
            if (!PairingStore.get(context).isPaired) return
            val intent = Intent(context, SyncService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(context, intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
