# Ergänzung zum Medienzeit-Konzept: Android-Tracker (Nutzung pro App)

Status: Entwurf, kein Code. Ergänzt medienzeit-konzept.md (Erfassungsweg (e)) um die konkrete
Android-Technik. Alle API-Aussagen gegen offizielle Android-Doku + OSS-Referenz-Implementierungen
geprüft (Quellen am Ende). Stand: November 2026.

Kernfrage dieser Ergänzung: Wie bekommt der geplante Capacitor-Wrapper (`de.eps.yuvomi`)
zuverlässig "Zeit pro App" auf den Server, und wie werden Apps wie Schulmanager serverseitig
als "ausgenommen" (kein Kontingent-Abzug) markiert?

## A. API-Wahl: UsageStatsManager.queryEvents() — Empfehlung

Drei Kandidaten, geprüft:

| Variante | Zeit pro App? | Hintergrund | Berechtigung | Datenschutz |
|---|---|---|---|---|
| UsageStatsManager (queryEvents/queryUsageStats) | Ja — Aggregat-Kanone des Systems | pollingfähig, robust | PACKAGE_USAGE_STATS (Special-Access-Toggle) | gering (nur Paket+Zeit, kein Inhalt) |
| AccessibilityService | Ja, in Echtzeit (<100 ms) | event-getrieben, aber OEM-/Version-abhängig instabil | BIND_ACCESSIBILITY_SERVICE (Sonder-Segment) | hoch (liest Bildschirminhalt) |
| NotificationListenerService | Nein — nur Notifications | nein | Notification Access | falsch (Notifications ≠ Nutzungszeit) |

Entscheidung: **queryEvents() als Primärquelle, queryUsageStats() nur als grober Sanity-Check.**

- `queryEvents(begin, end)` liefert Lifecycle-Events (ACTIVITY_RESUMED/PAUSED, SCREEN_INTERACTIVE/
  NON_INTERACTIVE, ...) mit Zeitstempel und Paketname. Nur daraus lassen sich Sessions
  (Paket, Start, Ende) bauen — queryUsageStats liefert nur Aggregate.
- `queryUsageStats(...).totalTimeInForeground` ist für beliebige Zeitfenster nachweislich
  unzuverlässig: Buckets werden auf ganze Intervalle ausgedehnt, `totalTimeInForeground` kann
  Nutzung außerhalb des Fensters enthalten; mehrere OSS-Tracker verwerfen es deshalb für
  Fenster-Berechnungen und replayen stattdessen die Events.
- AccessibilityService wäre nur nötig, wenn Yuvomi *hart blockieren* oder Browser-URLs lesen
  wollte (so machen es Opal/Flint als Enforcement-Pfad). Das ist hier gerade NICHT das Ziel:
  Treuhänder-Modell = Anreiz, kein Zwang (SPEC-Grundsatz im Hauptkonzept). Accessibility
  brächte: Play-Store-Sonderpolicy (Prominence-Disclosure, Demo-Video, Begründungspflicht),
  Google bestätigt selbst, dass es "cross devices and Android versions" unzuverlässig ist,
  und ein Hochprivileg, das eine Familien-App nicht braucht. Bewusst verworfen; kann später
  als opt-in "Echtzeit-Hinweis" (kein Block) ergänzt werden.
- NotificationListener scheidet aus: erfasst nur Benachrichtigungen, nicht "App war前台".

OSS-Belege für genau diesen Ansatz: rikkahub (ScreenTimeTool: queryEvents + "global
single foreground"-Replay, Launcher ausgeschlossen), ReClaim (Daily-Limits über Event-Replay,
"don't trust the daily buckets"), MinST/CrossDeviceTracker (UsageStats + lokaler Puffer + Sync),
cap-go/capacitor-android-usagestatsmanager (fertiges Capacitor-Plugin, exakt unsere Stack-Schicht).

## B. Berechtigungs-UX (Schritt für Schritt im Onboarding)

PACKAGE_USAGE_STATS ist keine Laufzeit-Berechtigung: Deklarieren im Manifest erklärt nur die
Absicht; der Nutzer muss in den Systemeinstellungen freigeben (Usage-Zugriff / "App-Nutzung").
Kein Dialog, keine automatisierte Vergabe possible.

1. Manifest: `<uses-permission android:name="android.permission.PACKAGE_USAGE_STATS"
   tools:ignore="ProtectedPermissions" />` + `FOREGROUND_SERVICE` +
   `FOREGROUND_SERVICE_SPECIAL_USE` (API 34+) + `POST_NOTIFICATIONS` (FGS-Anzeige).
2. Prüfen (nicht anfragen!): `AppOpsManager.unsafeCheckOpNoThrow(OPSTR_GET_USAGE_STATS, uid, pkg)
   == MODE_ALLOWED` (API<29: checkOpNoThrow).
3. Wenn nicht erteilt: Erklär-Screen in der App ("Warum: damit Yuvomi die Bildschirmzeit deines
   Kindes zählen kann — es werden nur Paketname + Zeiträume gemeldet, kein Inhalt"), dann
   `startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))` (FLAG_ACTIVITY_NEW_TASK).
   Nutzer tippt den Schalter für `de.eps.yuvomi` an; App prüft bei `onResume`/
   Activity-result-Äquivalent erneut und führt dann erst die Geräte-Paarung aus.
4. battery-Optimierung-Ausnahme separat erbitten: `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`
   (Play-konform; ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS ist Play-restringiert — bei
   Sideloading-APK wie unserem zwar egal, aber der Einstellungen-Umweg ist transparenter).
5. OEM-Hinweis-Seite im Onboarding (statisch, ohne Magie-Intents): Samsung
   ("Gerätepflege → Nicht schlafende Apps"/Autostart), Xiaomi/HyperOS ("Autostart erlauben",
   "Akku-Sparer → Keine Einschränkungen"). Diese Regeln lassen sich nicht per Intent setzen und
   werden nach OTA-Updates gern zurückgesetzt — deshalb Detektion + Erinnerung (siehe D).

Capacitor-Umsetzung: eigener kleines natives Plugin (oder @capgo/capacitor-android-usagestatsmanager
als Startpunkt) mit `hasPermission()`, `openUsageAccessSettings()`, `openBatterySettings()`,
`queryEvents(start,end)`; die Poll-/Puffer-Logik lebt in einem nativen Foreground-Service, nicht
im WebView (WebView wird im Hintergrund gedrosselt/getötet — Timer im JS sind als Autorität
ungeeignet, vgl. Hauptkonzept (a)).

## C. Datenformat pro Session (Client → Server)

Der Client replayt die Events selbst (Reihenfolge-Algorithmus, OSS-bewährt):

```
Replay über queryEvents(now - lookback, now):
  ACTIVITY_RESUMED pkg t  -> vorheriges Segment schließen, neues Segment (pkg, t) öffnen
  ACTIVITY_PAUSED  pkg t  -> schließen NUR wenn pkg == aktuell前台 (sonst ignorieren)
  SCREEN_NON_INTERACTIVE t -> aktuelles Segment schließen (Bildschirm aus = Schluss)
  DEVICE_SHUTDOWN/BOOT     -> Reset-Marker, kein Segment-Ende
  offene Segmente bei Abfrageende mit now schließen; Fenster-Ränder auf [start,end] clippen
```

Warum "global single foreground" statt per-Paket-Paarung: zu jedem Zeitpunkt zählt genau ein
Paket; per-Paket-Paarung erzeugt überlappende Intervalle und bläht die Summe auf (rikkahub-
Kommentar, SO-Thread). Clippen + Lookback (~12 h) löst "App war schon vor Fensterbeginn前台".

Session-Objekt (Entwurf, passt zu media_time_sessions aus dem Hauptkonzept):

```json
{
  "session_key": "sha256(device_token|pkg|started_at)",   // Idempotenz bei Nachmeldungen
  "package": "com.example.schulmanager",
  "app_label": "Schulmanager",                             // Anzeigezweck, Server kann überschreiben
  "started_at": "2026-11-04T15:03:11+01:00",               // Gerätelokale ISO mit Offset
  "ended_at":   "2026-11-04T15:31:47+01:00",               // null = läuft (Herzschlag verlängert)
  "foreground_ms": 1716000,                                // ACTIVITY_RESUMED-Summe (Clipping!)
  "screen_on_overlap_ms": 1716000,                         // Überschneidung mit SCREEN_INTERACTIVE
  "kind": "foreground",                                    // foreground | screen_on
  "clock_offset_ms": -842,                                 // Geräteuhr minus Serveruhr bei Start
  "client_ts": "..."                                       // nur Debug; minute_key kommt vom SERVER
}
```

- `minute_key` (Tag) wird serverseitig bei Annahme gesetzt (Hauptkonzept #129: Gerät-Uhr ist egal).
- Dünne Segmente (< 2–3 s) clientseitig zusammenführen (App-Wechsel-Rauschen, Dialoge).
- Herzschlag: laufendes Segment alle 60 s updaten (idempotent über session_key); Ende endgültig.
- Nachmeldungen: akzeptiert bis 24 h rückwirkend (Hauptkonzept #121), darüber nur als
  source='backfill' mit Flag für die Historien-Anzeige.

## D. Hintergrund-Zuverlässigkeit (Doze, OEM-Fallen)

Fakten aus Android-Doku + Praxisberichten:

- Doze: kein Netzwerk/WakeLocks außerhalb Wartungsfenster (Bildschirm aus + stillstand);
  leichtes Doze ab Bildschirm-Aus. App Standby Buckets: Inaktive Apps bekommen Jobs/Alarms
  extrem selten. Für UNSER Erfassungsprofil unkritisch: Bildschirm aus => keine relevante
  Nutzungszeit; es fehlt nur der Upload, nicht die Messung — deshalb Offline-Puffer Pflicht.
-foreground service (type `specialUse`, Begründung für Store), persistent,
  channel importance MIN, START_STICKY; pollt queryEvents auf rollierendem Fenster (~5–10 s
  zurück) im Sekundentakt und führt die Session-Tabelle lokal (Room/SQLite) nach.
  WorkManager-Kette (Expedite/Periodic, 15-min-Boden) für Uploads: versucht sofort, sonst im
  Wartungsfenster — "runs eventually" ist OK, weil der Server Nachmeldungen akzeptiert.
- OEM-Fallen: Samsung "Sleeping Apps" tötet nach ~3 Tagen ohne前台-Aktivität, OTA setzt
  Battery-Ausnahmen gern zurück; Xiaomi/HyperOS blockt Hintergrund-Standby ohne Autostart-
  Whitelist und resettet sie nach OTA. Counter: FGS (hält Apps aus dem Sleeping-Status),
  Startup-Boot-Receiver (START_STICKY覆盖了 nicht nach Reboot), plus **Herzschlag-SOLL/IST**:
  Server sieht via media_time_devices.last_seen_at, ob ein Gerät > 12 h nichts meldet, und
  zeigt Eltern "Tracker offline" statt stillschweigend 0 Minuten (sonst bestraft OEM-Aggressivität
  das Kind fälschlich mit "hat nichts genutzt" => Punkt-Gutschriften-Fehler).
- Kein "Akku unbegrenzt" erzwingbar: Yuvomi akzeptiert gedrosselte Zustellung und puffert.

## E. Ausnahmen ("WhiteList") — Server-seitig, pro Kind

Prinzip: **Der Client meldet alles Roh; der Server entscheidet, was vom Kontingent abgeht.**
Der Client kennt keine Ausnahme-Logik (Änderungen ohne App-Update, Kind kommt nicht dran).

- Tabelle `media_time_app_exceptions` (Skizze unten): globales Muster pro Haushalt bzw.
  user_id=NULL = Haushalt-Default; Eltern pflegen über UI (Capability media_manage_quotas).
- Match gegen die von `PackageManager.queryInstalledPackages` gemeldeten Paketen beim
  Geräte-Scan (der Wrapper sendet bei Pairing + täglich ein Paket-Inventar: package,
  versionName, install/first-install-Zeit — das erlaubt Eltern, "neu installiert" zu sehen).
- Match-Reihenfolge (longest-prefix/exact-first): `exact` (package) > `prefix`
  (z. B. `com.example.schulmanager`) > `glob`. Beispiel: Schulmanager als Ausnahme eintragen
  => Foreground-Zeit dieses Pakets wird bei Kontingent-Berechnung ignoriert, bleibt aber in
  der Historie sichtbar (Typ badge "ausgenommen"), damit Eltern sehen, dass er lief.
- System-/Pflichtkomponenten: Launcher (HOME-Resolver auflösen), `android.autoinstalls.config.*`,
  Telefon/SMS/Settings/Inputs => clientseitig als `kind='foreground'` mit Flag `system=1`
  markieren; Server behandelt `system=1` als implizite Ausnahme (nie Abzug). Vorbild Family
  Link: "System apps can't have app limits" — Yuvomi zieht sie erst gar nicht vom Konto ab.
- Yuvomi selbst: `de.eps.yuvomi` ist serverseitig hart ausgenommen (fixe Zeile, nicht löschbar),
  sonst müsste das Kind die App öffnen, um Zeit zu sehen, und verbraucht dabei Zeit.
- **Fail-open bei Unbekannt**: Paket ohne klassifiziertes Muster (neu installiert, z. B.
  anderer Schulmanager-Fork/Package-Name) wird NICHT abgezogen, sondern als
  `classification='unknown'` in die Eltern-UI ("Neu: com.xyz.app — abziehen? [Ja/Nein/Ausnahme]")
  übernommen. Begründung: Treuhänder-Modell — ein unbekanntes Paket darf nicht still
  Tageskontingent fressen (falscher Verdacht); Eltern entscheiden. Grobe Anomalie-Regel
  optional: > X h/Tag unbekannte Nutzung => Hinweis, kein Abzug.

## F. "Aktiv genutzt" vs "Hinterdienst"

- "Aktiv genutzt" = nur ACTIVITY_RESUMED→PAUSED-Intervalle (Doku: foreground = "user is
  actively interacting"). Das ist die Währung für den Abzug.
- Hintergrunddienste sind eigene Event-Typen (FOREGROUND_SERVICE_STARTED/STOPPED,
  Activity-Types 19–22) und werden clientseitig NICHT als foreground verbucht — sie tauchen
  optional als `kind='service'`-Zeilen nur für die Diagnose auf (z. B. "Musik-App läuft im
  Hintergrund"). Fürs Familien-Kontingent: Hintergrund = kein Abzug (Musik beim Lernen etc.).
- Bildschirm-an-Zeit als eigene Größe (SCREEN_INTERACTIVE/NON_INTERACTIVE): für die
  Frage "Gerät insgesamt angefasst" (Eltern-Dashboard), nie als Abzug (sperrt Display an =
  Nachricht lesen = Schulmanager-Check).
- Edge: Kind öffnet App und legt Gerät weg (Screen an, kein Touch). UsageStats zählt weiter
  (resumed). Das ist akzeptiert und dokumentiert — Digital Wellmaking verfährt genauso;
  Yuvomi ist Anreizsystem, kein Überwachungsanspruch.

## G. Kantenfälle & Schutz (Auswahl)

- Android R+: queryEvents liefert nichts solange Display gesperrt — "leer" != "keine Nutzung";
  Client behandelt leeres Ergebnis mit Display-Lock als "unbekannt", nie als 0.
- queryEvents-Speicher nur wenige Tage => lokaler Puffer + Upload-Priorität; Gerät > 1 Woche
  offline => Historie lückenhaft, Eltern-UI zeigt Lücken (source-Flag), nie Raten.
- Uhr-Umstellung/DST/Zeitzonen: Server setzt minute_key (Haushaltszone, Hauptkonzept #104);
  client timestamps nur für Dauer-Berechnung (Differenzen sind offset-stabil).
- Uhr-Rückstellung/Factory-Reset am Kindergerät: Pairing-Token bleibt gültig bis Revoke;
  Server sieht Sprünge in last_seen_at und zeigt Hinweis statt 0-Minus-Tag.
- Zwei Yuvomi-Instanzen/Token-Klon: Geräte-Token kurzlebig + an pairing_device_id gebunden
  (Hauptkonzept-Risiko #168); Heartbeat ohne gültiges device_token => 401, Meldungen verwerfen.
- App-Update des Schulmanagers = anderer Package-Name? Selten; Prefix-Match greift meist.
  Neu-Installation taucht im Inventar mit first-install auf => Eltern-UI-Vorschlag.
- Kind deinstalliert Yuvomi: kein Herzschlag => "Tracker offline"-Kachel; Yuvomi kann
  Deinstallation nicht verhindern (nur Device-Owner/MDM könnte das — bewusst nicht geplant,
  gehört zum Treuhänder-Modell).
- Split-Screen/PiP: beide Pakete melden RESUMED — "global single foreground" nimmt das
  zuletzt aktive; dokumentierte Ungenauigkeit, unkritisch fürs Konto.
- Bildschirm-Notifikations-View (Locked-Activity) = kein Paket-RESUMED => zählt nicht. Gut so.

## H. Datenmodell (SQL-Skizze, SQLite, append-only wie Hauptkonzept)

```sql
-- Ergänzt media_time_sessions (Hauptkonzept §3) um Paket-Details;
-- Migration v281 (Hauptkonzept-Sessions als v280; v277=v285-Rotation, v278=Decay, v279=Strafen, v280=Freigabe im Fork-Prod-Zweig belegt), PRAGMA-guarded, keine Löschpfade.

CREATE TABLE media_time_usage_sessions (
  id                INTEGER PRIMARY KEY,
  session_key       TEXT NOT NULL,                 -- device_id|package|started_at (hash)
  device_id         INTEGER NOT NULL REFERENCES media_time_devices(id),
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_name      TEXT NOT NULL,                 -- NIEMALS hartcodiert; aus Inventar gematcht
  app_label         TEXT,                          -- display only
  started_at        TEXT NOT NULL,                 -- ISO8601 mit Offset (Gerätelokal)
  ended_at          TEXT,                          -- NULL = läuft (Server kapt >12h, s. Hauptkonzept)
  foreground_ms     INTEGER NOT NULL DEFAULT 0 CHECK (foreground_ms >= 0),
  screen_on_ms      INTEGER NOT NULL DEFAULT 0,    -- Überschneidung SCREEN_INTERACTIVE
  kind              TEXT NOT NULL DEFAULT 'foreground'
                      CHECK (kind IN ('foreground','screen_on','service')),
  system_component  INTEGER NOT NULL DEFAULT 0,    -- 1 => implizite Ausnahme (System)
  classification    TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (classification IN ('charged','exempt','system','unknown')),
  minute_key        TEXT NOT NULL,                 -- Tag (HHaltszone), SERVER-seitig gesetzt
  clock_offset_ms   INTEGER,                       -- Debug/Diagnose
  source            TEXT NOT NULL DEFAULT 'apk'
                      CHECK (source IN ('apk','pwa','manual','adjust','backfill')),
  reported_by       INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT,
  UNIQUE (device_id, session_key)                  -- Idempotenz für Nachmeldungen
);
CREATE INDEX mtus_user_day ON media_time_usage_sessions (user_id, minute_key);
CREATE INDEX mtus_pkg      ON media_time_usage_sessions (package_name);

CREATE TABLE media_time_app_exceptions (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id       INTEGER,                           -- NULL = gilt für alle Kinder des Haushalts
  match_type    TEXT NOT NULL CHECK (match_type IN ('exact','prefix','glob')),
  pattern       TEXT NOT NULL,                     -- 'com.example.schulmanager'
  exempt_from   TEXT NOT NULL DEFAULT 'quota'
                  CHECK (exempt_from IN ('quota','history')),   -- 'history' = Abzug UND Auswertung aus
  note          TEXT,                              -- Eltern-Kommentar ('Schule')
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,                              -- append-only: revoke statt delete
  UNIQUE (household_id, user_id, match_type, pattern)
);
-- Fixzeile (Migration): Muster 'de.eps.yuvomi', exempt_from 'quota', note 'Yuvomi selbst',
-- created_by NULL-artig (System), nicht löschbar via API (Guard).

CREATE TABLE media_time_device_inventory (
  id            INTEGER PRIMARY KEY,
  device_id     INTEGER NOT NULL REFERENCES media_time_devices(id) ON DELETE CASCADE,
  package_name  TEXT NOT NULL,
  version_name  TEXT,
  system_app    INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  first_install_estimate TEXT,                     -- from PackageManager (best effort)
  UNIQUE (device_id, package_name)
);
```

Abzugs-Regel (Regel-Engine media-time.js): `charged = sum(foreground_ms) WHERE
classification='charged' AND minute_key=today AND kind='foreground'`; classification wird bei
Annahme einer Session resolved (Exception-Match > system > unknown-fail-open) und bei
Exception-Änderung NEU berechnet (Historie-Feld bleibt als Rohwert erhalten — Re-Compute,
nie Rück Edit; analog 'adjust'-Philosophie).

## I. API-Skizze (Prefix /api/v1/media-time, Scope 'media', Schemamuster mediaTimeProperties)

```
POST /api/v1/media-time/tracker/sync
  Header: Authorization: Bearer <device_token>   (Geräte-Token, nicht Kinder-Cookie)
  Body: {
    device_time: "2026-11-04T19:02:11+01:00",
    sessions: [ { session_key, package, app_label?, started_at, ended_at|null,
                  foreground_ms, screen_on_ms, kind } ],          // <= 200 pro Call
    inventory_delta?: [ { package, version_name, system_app, first_install_estimate? } ]
  }
  200: { accepted: n, rejected: [ { session_key, reason } ],
         server_day: "2026-11-04", server_time: "...",             // Referenz für clock_offset
         quota: { remaining_min, used_min, quota_min, quiet_active,
                  state: "ok"|"nearing"|"exceeded"|"quiet" },      // "erlaubt/gesperrt"-Antwort
         exceptions_version: 17 }                                   // Client-Cache-Invalidierung

POST /api/v1/media-time/tracker/heartbeat      { session_key, package, running: true }
  200: { ok: true, quota: { ... } }   // idempotent; verlängert laufendes Segment

GET  /api/v1/media-time/tracker/exceptions?user_id=    (media_manage_quotas)
  200: { items: [ { id, user_id, match_type, pattern, exempt_from, note } ], version }
PUT  /api/v1/media-time/tracker/exceptions             (media_manage_quotas)
  Body: { upsert: [ { user_id|null, match_type, pattern, exempt_from, note } ],
          revoke: [id, ...] }
  200: { version: 18 }
POST /api/v1/media-time/tracker/exceptions/:id/revoke  (parent) -> { version }

GET  /api/v1/media-time/devices/:id/inventory          (media_manage_quotas)
  200: { items: [ { package_name, version_name, system_app, first_seen_at, last_seen_at } ],
         new_since_last_review: [...] }               // Eltern-UI "Neu installiert?"
GET  /api/v1/media-time/today?user_id=                // wie Hauptkonzept, plus:
  200: { ..., charged_min, exempt_min, unknown_min, tracker: { last_seen_at, online: bool } }
```

States: `quota.state` speist die APK-Anzeige ("erlaubt/gesperrt"-Antwort des Hauptkonzepts,
§4); `state='quiet'` oder `'exceeded'` => APK zeigt Hinweis (kein Block — Treuhänder-Modell).
Unbekannte Pakete: 200 statt 4xx (Fail-open), Kennzeichnung nur in classification + Eltern-UI.

## J. Machbarkeit im Yuvomi-Fork (Capacitor-Wrapper)

- Stack: bestehender Capacitor-7-Remote-Wrapper (PWA auf LAN-URL) bleibt; der Tracker ist ein
  natives Android-Plugin + nativer Foreground-Service, JS spricht nur sync/heartbeat über fetch.
  Kein Push nötig (Pull/Push der Daten über HTTP; LAN-Vertrauen wie Hauptkonzept, Token kurzlebig).
- Bausteine existieren als OSS (cap-go-Plugin für queryEvents/Permission; Room-Puffer-Logik
  ~200 Zeilen). Eigenanteil: Service + Session-Replay + Upload-Kette + Onboarding-Screens.
- Aufwand: APK-Seite +2 d (Hauptkonzept-Schätzung) bleibt realistisch mit Plugin-Basis;
  Server-Seite (Tabellen v280, sync/heartbeat/exceptions-Endpunkte, Klassifizierung,
  Re-Compute, UI-Badges, i18n) +1,5–2 d on top der §9-Schätzung.
- Datenschutz-Entscheidung (Offen-Punkt 6 des Hauptkonzepts, hiermit beantwortbar):
  gespeichert werden package_name + Start/Ende + Dauer (Rohzeiten), KEIN Bildschirminhalt,
  keine URL, kein Gerätename-Auswertung nötig. Optional Config-Schalter "nur aggregierte
  Minuten pro Tag/Paket, keine Rohzeiten" — dann entfallen started_at/ended_at (Verlust:
  Streitfall-Aufklärung); Default: Rohzeiten, Haushalts-Admin, Löschpfad via Geräterevoke +
  retention (z. B. 90 d) als Follow-Up.
- Klarstellung Erwartung (in SPEC.md): ohne Device-Owner/MDM ist das ein Melde-, kein
  Vollzugssystem; Tracker offline/deinstalliert = Lücke, nicht Verstoß. Echte Sperre bleibt
  Weg (c) Heimnetz.

## Quellen (Auswahl, ~15)

1. UsageStatsManager — offizielle Ref (queryEvents/queryUsageStats, PACKAGE_USAGE_STATS,
   "user still needs to grant ... through Settings", Events "only kept ... a few days",
   Android R: null bei gesperrtem Display): developer.android.com/reference/android/app/usage/UsageStatsManager
2. UsageEvents.Event-Konstanten (ACTIVITY_RESUMED/PAUSED = ehem. MOVE_TO_FOREGROUND/BACKGROUND,
   SCREEN_INTERACTIVE/NON_INTERACTIVE, FOREGROUND_SERVICE-Typen): developer.android.com/reference/android/app/usage/UsageEvents.Event
3. UsageStats.getTotalTimeInForeground — Doku ("user is actively interacting"); Bucket-
   Unschärfe: stackoverflow.com/questions/36238481 (queryUsageStats "not a trusted source",
   Events manuell replayen), /questions/67705707, /questions/58622592
4. cap-go/capacitor-android-usagestatsmanager (Doku: totalTimeInForeground "can include usage
   from outside the window"; queryEvents-Lookback/Clipping-Muster; leere Events ≠ null):
   github.com/Cap-go/capacitor-android-usagestatsmanager + npm-Package
5. rikkahub ScreenTimeTool.kt — Referenz-Algorithmus "global single foreground"-Replay mit
   Lookback/Clipping, Launcher-Ausschluss: github.com/rikkahub/rikkahub (ScreenTimeTool.kt)
6. "Daily app limits on Android: replaying UsageEvents instead of trusting the daily buckets"
   (AppOps-Check + ACTION_USAGE_ACCESS_SETTINGS-Flow): dev.to/tryreclaim/daily-app-limits-on-android-...
7. "Why I removed AccessibilityService ..." (UsageStatsPolling ~800 ms vs Accessibility <100 ms;
   Play-Policy für nicht-Behinderungszwecke; "narrower API is UsageStatsManager"): dev.to/lui61140/...
8. Google Issue Tracker 454083282 (offizielle Google-Einschätzung: Accessibility "not reliable
   across devices and Android versions"; UsageStats "delayed or batched"; keine DW-Interoperabilität):
   issuetracker.google.com/issues/454083282
9. AccessibilityService — offizielle Ref (nur für Behinderungshilfe, user-granted, liest
   Fensterinhalte): developer.android.com/reference/android/accessibilityservice/AccessibilityService
10. Doze & App Standby — offiziell (Netzwerk/WakeLocks defered, Wartungsfenster,
    Allowlist): developer.android.com/training/monitoring-device-state/doze-standby
11. Android 9 Power Management (App Standby Buckets, active-Bucket-Definition inkl. FGS,
    Doze-Allowlist befreit von Bucket-Limits): developer.android.com/about/versions/pie/power
12. AOSP Power management (Exempt-Apps, Battery-Optimization-Einstieg): source.android.com/docs/core/power/mgmt
13. OEM-Fälle (Samsung Sleeping Apps + OTA-Resets, Xiaomi Autostart; FGS/START_STICKY/WorkManager-
    Gegenmittel): dev.to/stoyan_minchev/what-android-oems-do-to-background-apps-... ;
    lilting.ch/en/articles/mobile-ai-app-connection-resilience
14. Family Link App-Limits ("System apps can't have app limits"; Block-Verzögerung ~5 min):
    support.google.com/families/answer/7103028
15. DevicePolicyManager/DPC (Device-/Profile-Owner = echter Block/Pflock — außerhalb Yuvomi-Scope,
    nur als Kontext warum (c)/MDM die einzige echte Sperre ist): developer.android.com/reference/kotlin/android/app/admin/DevicePolicyManager ,
    developer.android.com/work/dpc/device-management
16. AppOpsManager.OPSTR_GET_USAGE_STATS (Prüfpfad): developer.android.com/reference/kotlin/android/app/AppOpsManager

## Umsetzung: tools/android-agent/

Die Konzeptpunkte A–I sind als lauffähiges Kotlin-Projekt unter `tools/android-agent/`
umgesetzt (Gradle, minSdk 26 / target 34, Package `de.eps.yuvomi.tracker`):
queryEvents-Replay nach Abschnitt C ("global single foreground", 12-h-Lookback, Clipping,
<2,5-s-Merge, "unbekannt" != 0 auf Android R+), Berechtigungs-Onboarding nach B
(AppOps-Check + ACTION_USAGE_ACCESS_SETTINGS mit onResume-Re-Check, Batterie-Ausnahme,
OEM-Hinweisseite als Asset), Offline-Puffer (Room `pending_sessions`) und Sync nach I
(`POST /tracker/sync` mit Bearer-Geräte-Token und quota.state-Hinweis ohne Block,
60-s-Heartbeat im specialUse-FGS + WorkManager-15-min-Kette, `exceptions_version`
als Cache-Invalidierung). Server und Deploy bleiben unverändert; Bauen/Prüfschritte
stehen in `tools/android-agent/README.md`.
