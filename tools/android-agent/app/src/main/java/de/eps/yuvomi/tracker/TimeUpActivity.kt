package de.eps.yuvomi.tracker

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * "Zeit ist um"-Hinweis auf dem Handy (Nutzer 04.11.: "sind die 30min weg soll es
 * nicht weiter gehen duerfen bzw eine nachricht bekommen das die zeit um ist").
 *
 * Android ohne Device-Owner kann andere Apps nicht hart sperren - ein ordinary
 * App darf das System nicht kontrollieren. Der ehrliche Rahmen:
 *  - Vollbild-Hinweis (diese Activity), Topmost ueber allem was der Tracker
 *    selbst zeigt, startet bei jedem Sync/Heartbeat neu wenn der Server
 *    enforcement='lock' + exceeded/quiet sagt.
 *  - Kein Oeffnen fremder Apps verhindert werden kann, sagt der Hinweis es auch
 *    nicht - der Tracker ist auf dem Handy Signal + Meldepflicht, die Sperre ist
 *    der PC-Login und das Kontingent selbst.
 *  - Der Hinweis verschwindet von selbst, sobald der Server wieder erlaubt
 *    (Kontingent von den Eltern erhoht oder Tausch gekauft).
 */
class TimeUpActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val why = intent.getStringExtra(EXTRA_REASON)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(24, 26, 32))
            setPadding(64, 96, 64, 64)
        }
        root.addView(TextView(this).apply {
            text = getString(R.string.time_up_title)
            textSize = 30f
            setTextColor(Color.WHITE)
            gravity = android.view.Gravity.CENTER_HORIZONTAL
        })
        root.addView(TextView(this).apply {
            text = buildString {
                append(getString(R.string.time_up_body))
                if (!why.isNullOrBlank()) append("\n\n").append(why)
            }
            textSize = 17f
            setTextColor(Color.rgb(230, 230, 235))
            setPadding(0, 40, 0, 0)
        })
        setContentView(ScrollView(this).apply {
            addView(root)
            isFillViewport = true
        })
    }

    companion object {
        const val EXTRA_REASON = "reason"

        /** Startet den Hinweis, falls der Server das will; sonst keine Aktion. */
        fun showIfLocked(context: Context, enforcement: String?, state: String?, reason: String?) {
            val lock = enforcement == "lock" && (state == "exceeded" || state == "quiet")
            val prefs = Prefs.get(context)
            if (lock && prefs.quotaLockedShownBy != state) {
                prefs.quotaLockedShownBy = state
                val intent = android.content.Intent(context, TimeUpActivity::class.java).apply {
                    addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                        or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    putExtra(EXTRA_REASON, reason)
                }
                context.startActivity(intent)
            } else if (!lock) {
                prefs.quotaLockedShownBy = null
            }
        }
    }
}
