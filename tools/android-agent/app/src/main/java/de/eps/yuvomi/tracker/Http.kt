package de.eps.yuvomi.tracker

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Duenner OkHttp-Client fuer die drei Tracker-Endpunkte.
 *
 * Auth: Authorization: Bearer <deviceToken> (Scope media:write). Das Token kommt
 * ausschliesslich aus PairingStore und wird NIEMALS geloggt - auch Fehlerpfade
 * geben nur Statuscodes/Grundaecher zurueck, keine Header-Inhalte.
 *
 * Klartext (http://) ist erlaubt, weil Yuvomi typischerweise im LAN selbst gehostet
 * wird (usesCleartextTraffic im Manifest); HTTPS funktioniert unveraendert.
 */
class Http(private val baseUrl: String, private val deviceToken: String) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    data class SyncResponse(
        val accepted: Int,
        val rejected: List<RejectedSession>,
        val quota: QuotaState?,
        val exceptionsVersion: Int?
    )

    data class RejectedSession(val sessionKey: String, val reason: String)

    data class QuotaState(
        val state: String,          // ok | nearing | exceeded | quiet
        val remainingMin: Int?,
        val usedMin: Int?,
        val quotaMin: Int?,
        val quietActive: Boolean,
        val enforcement: String = "count",  // count | lock (Serverentscheidung 04.11.)
        val reason: String? = null          // Begruendung der letzten Elternanpassung
    )

    /**
     * POST /api/v1/media-time/tracker/sync
     * Body: { device_time, sessions: [... <=200 ...], inventory_delta? }
     * Wirft SyncException bei Netzwerk-/HTTP-Fehlern (Aufrufer puffert weiter).
     */
    suspend fun sync(
        sessions: List<PendingSessionEntity>,
        inventoryDelta: JSONArray? = null
    ): SyncResponse {
        val body = JSONObject()
            .put("device_time", Iso.nowLocal())
            .apply {
                val arr = JSONArray()
                for (s in sessions.take(TrackerConfig.MAX_SESSIONS_PER_CALL)) {
                    arr.put(
                        JSONObject()
                            .put("session_key", s.sessionKey)
                            .put("package", s.packageName)
                            .apply {
                                if (s.appLabel != null) put("app_label", s.appLabel)
                                if (s.endedAtMs != null) put("ended_at", Iso.fromEpoch(s.endedAtMs))
                                else put("ended_at", JSONObject.NULL)
                            }
                            .put("started_at", Iso.fromEpoch(s.startedAtMs))
                            .put("foreground_ms", s.foregroundMs)
                            .put("screen_on_ms", s.screenOnMs)
                            .put("kind", s.kind)
                            .put("system", if (s.systemComponent) 1 else 0)
                    )
                }
                put("sessions", arr)
                if (inventoryDelta != null) put("inventory_delta", inventoryDelta)
            }
        val resp = post(TrackerConfig.PATH_SYNC, body.toString())
        val obj = JSONObject(resp)
        val rejected = mutableListOf<RejectedSession>()
        obj.optJSONArray("rejected")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                rejected.add(RejectedSession(o.optString("session_key"), o.optString("reason")))
            }
        }
        val quotaObj = obj.optJSONObject("quota")
        val quota = quotaObj?.let {
            QuotaState(
                state = it.optString("state", "ok"),
                remainingMin = if (it.has("remaining_min") && !it.isNull("remaining_min")) it.getInt("remaining_min") else null,
                usedMin = if (it.has("used_min") && !it.isNull("used_min")) it.getInt("used_min") else null,
                quotaMin = if (it.has("quota_min") && !it.isNull("quota_min")) it.getInt("quota_min") else null,
                quietActive = it.optBoolean("quiet_active", false),
                enforcement = it.optString("enforcement", "count"),
                reason = if (it.has("reason") && !it.isNull("reason")) it.optString("reason") else null
            )
        }
        return SyncResponse(
            accepted = obj.optInt("accepted", 0),
            rejected = rejected,
            quota = quota,
            exceptionsVersion = if (obj.has("exceptions_version")) obj.getInt("exceptions_version") else null
        )
    }

    /**
     * POST /api/v1/media-time/tracker/heartbeat
     * { session_key, package, running: true } - idempotent, verlaengert laufendes Segment.
     */
    suspend fun heartbeat(sessionKey: String, pkg: String): QuotaState? {
        val body = JSONObject()
            .put("session_key", sessionKey)
            .put("package", pkg)
            .put("running", true)
        val resp = post(TrackerConfig.PATH_HEARTBEAT, body.toString())
        val obj = JSONObject(resp)
        val quotaObj = obj.optJSONObject("quota")
        return quotaObj?.let {
            QuotaState(
                state = it.optString("state", "ok"),
                remainingMin = if (it.has("remaining_min") && !it.isNull("remaining_min")) it.getInt("remaining_min") else null,
                usedMin = if (it.has("used_min") && !it.isNull("used_min")) it.getInt("used_min") else null,
                quotaMin = if (it.has("quota_min") && !it.isNull("quota_min")) it.getInt("quota_min") else null,
                quietActive = it.optBoolean("quiet_active", false),
                enforcement = it.optString("enforcement", "count"),
                reason = if (it.has("reason") && !it.isNull("reason")) it.optString("reason") else null
            )
        }
    }

    /**
     * GET /api/v1/media-time/tracker/exceptions?user_id=
     * (media_manage_quotas-Scope am Eltern-Account - das Geraete-Token reicht fuer die
     * Lese-Anzeige des eigenen Haushaltes; 403 => Cache einfach leer lassen.)
     */
    suspend fun fetchExceptions(userId: Int?): ExceptionsResponse? {
        val qs = if (userId != null) "?user_id=$userId" else ""
        return try {
            val resp = get(TrackerConfig.PATH_EXCEPTIONS + qs)
            val obj = JSONObject(resp)
            val items = mutableListOf<AppException>()
            obj.optJSONArray("items")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    items.add(
                        AppException(
                            id = o.getLong("id"),
                            userId = if (o.isNull("user_id")) null else o.getInt("user_id"),
                            matchType = o.getString("match_type"),
                            pattern = o.getString("pattern"),
                            exemptFrom = o.optString("exempt_from", "quota")
                        )
                    )
                }
            }
            ExceptionsResponse(items = items, version = obj.optInt("version", 0))
        } catch (_: HttpSyncException) {
            null // 401/403/sonstige: Cache behalten, nichts erfinden
        }
    }

    data class ExceptionsResponse(val items: List<AppException>, val version: Int)

    class HttpSyncException(val code: Int, message: String) : Exception(message)

    private fun post(path: String, json: String): String {
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer $deviceToken")
            .header("Content-Type", "application/json")
            .post(json.toRequestBody(jsonMedia))
            .build()
        return execute(request)
    }

    private fun get(path: String): String {
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer $deviceToken")
            .build()
        return execute(request)
    }

    private fun execute(request: Request): String {
        val response = client.newCall(request).execute()
        try {
            if (!response.isSuccessful) {
                // Body bewusst NICHT weiterreichen koennte Secrets enthalten; nur Code.
                throw HttpSyncException(response.code, "HTTP ${response.code} auf ${request.url.encodedPath}")
            }
            val body = response.body
            return if (body != null) body.string() else ""
        } finally {
            response.close()
        }
    }
}

/** ISO-8601 mit Offset gemaess Geraetelokalzeit (Server nutzt device_time nur als Referenz). */
object Iso {
    fun nowLocal(): String = fromEpoch(System.currentTimeMillis())

    fun fromEpoch(ms: Long): String {
        val zdt = java.time.Instant.ofEpochMilli(ms)
            .atZone(java.time.ZoneId.systemDefault())
        return java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(zdt)
    }
}
