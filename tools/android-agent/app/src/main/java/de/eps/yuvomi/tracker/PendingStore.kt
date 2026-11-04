package de.eps.yuvomi.tracker

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import org.json.JSONArray
import org.json.JSONObject

/**
 * Offline-Puffer: noch nicht (erfolgreich) gemeldete Sessions in SQLite (Room),
 * Tabelle pending_sessions. Append-only Charakter: geloescht wird erst nach
 * Server-Akzeptanz; abgewiesene Sessions bleiben bis zum Retention-Fenster
 * (7 Tage), damit Idempotenz (session_key) auch bei Server-Problemen haelt.
 */
@Entity(
    tableName = "pending_sessions",
    indices = [Index(value = ["session_key"], unique = true), Index(value = ["lastAttemptMs"])]
)
data class PendingSessionEntity(
    val sessionKey: String,
    val packageName: String,
    val appLabel: String?,
    val startedAtMs: Long,
    val endedAtMs: Long?,
    val foregroundMs: Long,
    val screenOnMs: Long,
    val kind: String,
    val systemComponent: Boolean,
    val attempts: Int = 0,
    val lastAttemptMs: Long = 0L,
    val createdAtMs: Long = System.currentTimeMillis()
)

/** Persistierte Server-Ausnahmen (Cache; Server bleibt die Autoritaet). */
@Entity(tableName = "app_exceptions", primaryKeys = ["id"])
data class ExceptionEntity(
    val id: Long,
    val userId: Int?,
    val matchType: String,
    val pattern: String,
    val exemptFrom: String
)

@Dao
interface TrackerDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPending(entity: PendingSessionEntity)

    @Query("SELECT * FROM pending_sessions ORDER BY startedAtMs ASC LIMIT :limit")
    suspend fun pending(limit: Int): List<PendingSessionEntity>

    @Query("SELECT COUNT(*) FROM pending_sessions")
    suspend fun pendingCount(): Int

    @Query("DELETE FROM pending_sessions WHERE sessionKey IN (:keys)")
    suspend fun deleteByKeys(keys: List<String>)

    @Query("UPDATE pending_sessions SET attempts = attempts + 1, lastAttemptMs = :now WHERE sessionKey IN (:keys)")
    suspend fun markAttempted(keys: List<String>, now: Long)

    @Query("DELETE FROM pending_sessions WHERE createdAtMs < :cutoffMs")
    suspend fun purgeOlderThan(cutoffMs: Long)

    @Query("DELETE FROM app_exceptions")
    suspend fun clearExceptions()

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertExceptions(items: List<ExceptionEntity>)

    @Query("SELECT * FROM app_exceptions")
    suspend fun allExceptions(): List<ExceptionEntity>
}

@Database(
    entities = [PendingSessionEntity::class, ExceptionEntity::class],
    version = 1,
    exportSchema = false
)
abstract class TrackerDatabase : RoomDatabase() {
    abstract fun dao(): TrackerDao

    companion object {
        @Volatile
        private var instance: TrackerDatabase? = null

        fun get(context: Context): TrackerDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    TrackerDatabase::class.java,
                    "yuvomi_tracker.db"
                ).fallbackToDestructiveMigration()
                    .build()
                    .also { instance = it }
            }
    }
}

/**
 * Ausnahmen-Cache als JSON (Prefs.exceptionsCacheJson) - kleiner Helper, damit Prefs
 * keinen Room-Import braucht. Bei Aenderung der exceptions_version laedt SyncEngine
 * neu (GET /tracker/exceptions) und ersetzt diesen Cache.
 */
object ExceptionCacheJson {
    fun encode(items: List<AppException>): String {
        val arr = JSONArray()
        for (e in items) {
            arr.put(
                JSONObject()
                    .put("id", e.id)
                    .put("userId", e.userId ?: JSONObject.NULL)
                    .put("matchType", e.matchType)
                    .put("pattern", e.pattern)
                    .put("exemptFrom", e.exemptFrom)
            )
        }
        return arr.toString()
    }

    fun decode(json: String?): List<AppException> {
        if (json.isNullOrBlank()) return emptyList()
        return try {
            val arr = JSONArray(json)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                AppException(
                    id = o.getLong("id"),
                    userId = if (o.isNull("userId")) null else o.getInt("userId"),
                    matchType = o.getString("matchType"),
                    pattern = o.getString("pattern"),
                    exemptFrom = o.getString("exemptFrom")
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /**
     * Lokale Anzeige-Klassifizierung (NUR fuer den Hinweis-Text auf dem Geraet;
     * der Abzug laeuft serverseitig). Match-Reihenfolge exact > prefix > glob.
     */
    fun classify(pkg: String, system: Boolean, exceptions: List<AppException>): Classification {
        if (system) return Classification.SYSTEM
        val exact = exceptions.firstOrNull { it.matchType == "exact" && it.pattern == pkg }
        if (exact != null) return Classification.EXEMPT
        val prefix = exceptions.firstOrNull {
            it.matchType == "prefix" && pkg.startsWith(it.pattern)
        }
        if (prefix != null) return Classification.EXEMPT
        val glob = exceptions.firstOrNull { it.matchType == "glob" && globMatch(it.pattern, pkg) }
        if (glob != null) return Classification.EXEMPT
        // Fail-open: unbekanntes Paket wird nicht abgezogen, nur markiert (Eltern-UI entscheidet)
        return Classification.UNKNOWN
    }

    private fun globMatch(pattern: String, value: String): Boolean {
        // einfacher Glob: * = jedes Zeichen, ? = ein Zeichen; Rest literal
        val regex = buildString {
            append('^')
            for (c in pattern) {
                when (c) {
                    '*' -> append(".*")
                    '?' -> append('.')
                    '.', '\\', '+', '(', ')', '[', ']', '{', '}', '|', '^', '$' -> {
                        append('\\'); append(c)
                    }
                    else -> append(c)
                }
            }
            append('$')
        }.toRegex()
        return regex.matches(value)
    }
}
