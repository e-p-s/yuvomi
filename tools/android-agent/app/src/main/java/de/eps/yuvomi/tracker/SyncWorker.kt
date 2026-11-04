package de.eps.yuvomi.tracker

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ListenableWorker
import androidx.work.WorkerParameters

/**
 * WorkManager-UploadJob (15-min-Boden, Netzwerk-Constraint): gleiche Logik wie der
 * 60s-Takt im Service, nur als Doze-/OEM-Versicherung. "Runs eventually" ist OK,
 * weil der Server Nachmeldungen akzeptiert (darueber hinaus source='backfill').
 */
class SyncWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): ListenableWorker.Result {
        val outcome = SyncEngine(applicationContext).runOnce()
        return when {
            outcome.ok -> ListenableWorker.Result.success()
            outcome.offline -> ListenableWorker.Result.retry()
            outcome.needsReconnect -> ListenableWorker.Result.success() // Pairing aufgeloest; Service zeigt Hinweis
            else -> ListenableWorker.Result.retry() // nicht gepaart: nichts zu tun, spaeter erneut pruefen
        }
    }

    companion object {
        const val PERIODIC_NAME = "yuvomi-periodic-sync"
    }
}
