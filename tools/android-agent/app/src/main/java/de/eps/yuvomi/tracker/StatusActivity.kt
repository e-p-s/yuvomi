package de.eps.yuvomi.tracker

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Klickziel der Dauerbenachrichtigung: zeigt kurz den aktuellen Tracker-/Quota-Status.
 * Bewusst KEIN Block und keine Sperre bei exceeded/quiet - der Hinweis ist der
 * "erlaubt/gesperrt"-Hinweis des Treuhhaender-Modells (Anreiz, kein Zwang).
 */
class StatusActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = TextView(this)
        val pad = (16 * resources.displayMetrics.density).toInt()
        view.setPadding(pad, pad, pad, pad)
        view.text = buildStatus()
        setContentView(view)
    }

    private fun buildStatus(): String {
        val prefs = Prefs.get(this)
        val pairing = PairingStore.get(this)
        val sb = StringBuilder()
        sb.append(getString(R.string.status_running))
        sb.append('\n')
        sb.append(
            if (pairing.isPaired) getString(R.string.status_paired)
            else getString(R.string.status_not_paired)
        )
        sb.append('\n')
        val quota = prefs.quotaState
        sb.append(
            when (quota) {
                "exceeded" -> getString(R.string.notification_quota_exceeded)
                "quiet" -> getString(R.string.notification_quiet)
                "nearing" -> getString(R.string.status_quota_nearing)
                "ok" -> getString(R.string.status_quota_ok)
                else -> getString(R.string.status_quota_unknown)
            }
        )
        sb.append('\n')
        sb.append(getString(R.string.status_privacy_note))
        return sb.toString()
    }
}
