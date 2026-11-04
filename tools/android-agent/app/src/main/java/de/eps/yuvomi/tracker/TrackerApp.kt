package de.eps.yuvomi.tracker

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Application-Einstieg: Notification-Kanaele + die wiederkehrende Upload-Kette.
 *
 * Bewusst KEIN AccessibilityService: erfasst wird nur Paketname + Zeitraum,
 * nie Bildschirminhalt (Begruendung: docs/medienzeit-android-tracker.md).
 */
class TrackerApp : Application() {

    override fun onCreate() {
        super.onCreate()
        NotificationChannels.ensure(this)
        schedulePeriodicUpload(this)
    }
}

/** Einmalig angelegte Kanaele (niedrige Importance: stiller Dauertracker). */
object NotificationChannels {
    const val CHANNEL_TRACKER = "tracker"
    const val CHANNEL_ALERT = "alert"

    fun ensure(app: Context) {
        val nm = app.getSystemService(android.app.NotificationManager::class.java)
        val tracker = android.app.NotificationChannel(
            CHANNEL_TRACKER,
            app.getString(R.string.channel_tracker),
            android.app.NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = app.getString(R.string.channel_tracker_desc)
            setShowBadge(false)
        }
        val alert = android.app.NotificationChannel(
            CHANNEL_ALERT,
            app.getString(R.string.channel_alert),
            android.app.NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = app.getString(R.string.channel_alert_desc)
        }
        nm.createNotificationChannel(tracker)
        nm.createNotificationChannel(alert)
    }
}

/**
 * Upload-Kette als PeriodicWork (Systemboden 15 min) mit Netzwerk-Constraint.
 * Doze: spaetestens im Wartungsfenster ("runs eventually" genuegt, weil der Server
 * Nachmeldungen bis 24 h akzeptiert, danach source='backfill').
 */
internal fun schedulePeriodicUpload(context: Context) {
    val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()
    val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
        .setConstraints(constraints)
        .setBackoffCriteria(
            androidx.work.BackoffPolicy.EXPONENTIAL,
            5, TimeUnit.MINUTES
        )
        .build()
    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        SyncWorker.PERIODIC_NAME,
        ExistingPeriodicWorkPolicy.KEEP,
        request
    )
}
