# Yuvomi Android-Tracker (tools/android-agent)

Natives Kotlin-Projekt fuer die Medienzeit-Erfassung auf Kinder-Geraeten:
UsageStatsManager-Replay ("global single foreground"), Berechtigungs-Onboarding,
Foreground-Service mit 60s-Heartbeat, Offline-Puffer (Room) und Sync gegen den
selbst gehosteten Yuvomi-Server.

Konzept-Grundlage und Quellen: `docs/medienzeit-android-tracker.md` (Repo-Wurzel).
Server-Endpunkte (unveraendert vorausgesetzt): `POST /api/v1/media-time/tracker/sync`,
`POST /api/v1/media-time/tracker/heartbeat`, `GET /api/v1/media-time/tracker/exceptions`.

## Bauen

Voraussetzung: Android SDK (API 34), JDK 17.

```bash
cd tools/android-agent
# gradlew ist nicht eingecheckt - entweder Android Studio oeffnen (empfohlen) oder:
gradle wrapper --gradle-version 8.7   # erzeugt gradlew + Gradle-Wrapper
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk (Sideloading auf dem Kinder-Geraet)
```

Android Studio: `tools/android-agent` als Projekt oeffnen, Sync abwarten, Run.
Package: `de.eps.yuvomi.tracker` (minSdk 26 / Android 8.0, target 34).

Der Worker/CI dieses Repos hat kein Android-SDK - der Build wurde auf diesem Weg
nicht ausgefuehrt (siehe "Vom echten Build zu pruefen" unten).

## Berechtigungsfluss (Onboarding, MainActivity)

1. **Erklaerseite** - was erfasst wird: nur Paketname + Zeitraum, kein Inhalt.
   Bewusst KEIN AccessibilityService (Details: assets/onboarding_usage_access.html).
2. **Usage-Zugriff** - geprueft wird ueber
   `AppOpsManager.unsafeCheckOpNoThrow(OPSTR_GET_USAGE_STATS) == MODE_ALLOWED`
   (API < 29: `checkOpNoThrow`). Bei fehlender Freigabe: Intent
   `Settings.ACTION_USAGE_ACCESS_SETTINGS`, Re-Check bei `onResume`.
   **Ohne Freigabe wird nichts erfasst** - auch keine Nullen (ehrlich statt 0-Minus-Tag).
3. **Batterie-Ausnahme** - `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`
   (Play-konform; der Direct-Request-Intent ist Play-restringiert).
4. **Pairing** - Base-URL + Geraete-Token (Tippen oder `yuvomi://pair?base=..&token=..`
   Deep-Link). Speichert in **EncryptedSharedPreferences** (AES256-GCM); das Token wird
   nie geloggt und nur als `Authorization: Bearer` (Scope media:write) an die
   eingetragene Server-Adresse gesendet.
5. **SyncService starten** - Foreground-Service (`specialUse`, START_STICKY) mit
   stiller Benachrichtigung "Medienzeit wird erfasst"; POST_NOTIFICATIONS wird ab API 33
   angefragt (Ablehnung blockiert den Dienst nicht).

## Laufzeit-Architektur

- `UsageReplay.kt` - "global single foreground"-Replay ueber
  `queryEvents(start,end)`: ACTIVITY_RESUMED/PAUSED + SCREEN_INTERACTIVE/
  SCREEN_NON_INTERACTIVE als Session-Grenze, Shutdown/Boot als Reset-Marker,
  Clipping auf [start,end], Merge duenner Segmente (< 2,5 s), 12-h-Lookback,
  30-s-Fensterueberlapp. `session_key = sha256(deviceId|package|startedAt)`.
  Leere Event-Listen auf Android R+ (Display gesperrt) => Zustand "unbekannt",
  NIEMALS als "0 Nutzung" gebucht.
- `SyncService.kt` - rollierender Replay-Tick alle 5 s in die Room-Tabelle
  `pending_sessions`; Upload/Heartbeat alle 60 s; zusaetzlicher OneTime-Work.
- `SyncWorker.kt` - WorkManager Periodic (15-min-Boden, Netzwerk-Constraint) als
  Doze-Versicherung: "runs eventually" genuegt, weil der Server nachmeldet.
- `SyncEngine.kt` - POST /sync (max. 200 Sessions/Call), rejected-Keys mit Zaehler,
  `quota.state` (ok/nearing/exceeded/quiet) nur als **Hinweis** in der Persistenz -
  kein Block (Treuhhaender-Modell). `exceptions_version` wird gecacht; bei Aenderung
  laedt der Client `GET /tracker/exceptions` neu und ersetzt den Cache
  (`app_exceptions` + Prefs-JSON). Nachmeldungen > 24 h kennzeichnet der Server als
  `source='backfill'` - der Client entscheidet das nicht.
- `BootReceiver.kt` - startet den Service nach Reboot/App-Update neu
  (START_STICKY deckt Reboot nicht ab).
- Launcher-Pakete (HOME-Resolver) und System-Komponenten werden clientseitig als
  `system=1` markiert bzw. weggelassen (Family-Link-Vorbild: System-Apps ziehen nie ab).

## Bekannte Grenzen (bewusst, nicht Bug)

- **Doze:** kein Netzwerk im Doze-Fenster => Upload spaeter, nie Messverlust
  (Offline-Puffer, 7-Tage-Retention lokal, 24-h-Nachmeldefenster serverseitig).
- **OEM-Killer (Samsung "Sleeping Apps", Xiaomi Autostart):** statische Anleitung in
  `app/src/main/assets/oem-hinweise.html`, im Onboarding verlinkt. Laesst sich nicht
  per Intent setzen und wird nach OTA gern zurueckgesetzt; der Server zeigt
  "Tracker offline" statt still 0 Minuten (Herzschlag-SOLL/IST).
- **Factory-Reset / Uhr-Rueckstellung:** Token bleibt bis Revoke gueltig; Server sieht
  Spruenge in `last_seen_at` und zeigt Hinweis statt 0-Minus-Tag.
- **Kein Device-Admin/MDM:** ohne Device-Owner ist Yuvomi ein **Melde-, kein
  Vollzugssystem**. Kind kann deinstallieren oder Freigabe entziehen => Lücke im
  Protokoll, kein Verstoss. Echte Sperre bleibt der Heimnetz-Weg (Konzept (c)).
- Split-Screen/PiP: beide Pakete melden RESUMED; "global single foreground" nimmt das
  zuletzt aktive - dokumentierte Ungenauigkeit, unkritisch fürs Konto.

## Vom echten Build zu pruefen (kein SDK im Worker)

1. `./gradlew assembleDebug` - Kotlin-Syntax, Room-kapt (Dao-Codegen), ViewBinding-IDs.
2. Manifest-Merges: `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`-Property (API 34),
   `<queries>`-Abdeckung des Paket-Inventars auf Android 11+.
3. Lint: `POST_NOTIFICATIONS`-Flow, `tools:ignore="ProtectedPermissions"`.
4. Laufzeit: `EncryptedSharedPreferences`-Initialisierung (MasterKey), Start des FGS
   mit `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` auf API 34, Heartbeat gegen einen echten
   Server (401 => Pairing clear).
5. Room-Migration (aktuell v1, destructive fallback).

## Dateien

```
settings.gradle.kts, build.gradle.kts, gradle.properties, app/build.gradle.kts
app/src/main/AndroidManifest.xml
app/src/main/java/de/eps/yuvomi/tracker/
  TrackerApp.kt        - Application, Notification-Kanaele, Periodic-Work
  TrackerConfig.kt     - Lookback/Merge/Heartbeat-Konstanten, session_key (sha256)
  Models.kt            - UsageSession, ReplayResult, TrackerEvent, AppException
  UsageReplay.kt       - Event-Replay (queryEvents, Clipping, Merge, "unbekannt")
  PendingStore.kt      - Room: pending_sessions + app_exceptions, Ausnahmen-Cache/JSON
  SyncEngine.kt        - sync/heartbeat, quota.state-Persistenz, exceptions_version
  SyncService.kt       - FGS specialUse, START_STICKY, 5s-Replay-/60s-Sync-Takt
  SyncWorker.kt        - WorkManager 15-min-Boden (Doze-Versicherung)
  BootReceiver.kt      - Service-Relaunch nach Reboot/Update
  MainActivity.kt      - Onboarding-Kette (5 Schritte), Pairing-Inputs + Deep-Link
  StatusActivity.kt    - Klickziel der Benachrichtigung (Status, kein Block)
  UsageAccess.kt       - AppOps-Check, Settings-Intents, POST_NOTIFICATIONS-Check
  PairingStore.kt      - EncryptedSharedPreferences fuer Base-URL + Token
  Prefs.kt             - unkritische Praeferenzen (nie Secrets)
  Http.kt              - OkHttp, Bearer-Auth, sync/heartbeat/exceptions, Iso
app/src/main/res/      - strings (deutsch, i18n-statisch fuer MVP), layout, theme, icon
app/src/main/assets/   - oem-hinweise.html, onboarding_usage_access.html,
                         onboarding_battery.html, onboarding_pairing.html
```

Bewusst weggelassen (mit Grund): QR-Scanner (Pairing per Deep-Link/Abtippen reicht
MVP; zxing-Dep ist bewusst nicht verlinkt - vermeidet ungetestete Kamera-Logik); Paket-Inventar-Upload beim Pairing (Server-Seite noch nicht
implementiert, API-Skizze Abschnitt I - Feld `inventory_delta` ist im Sync-Body
bereits vorbereitet); Unit-Tests (kein Build im Worker - Tests ohne ausgefuehrten
Run waeren tote Dateien).
