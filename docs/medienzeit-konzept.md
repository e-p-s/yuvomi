# Konzept: Medienzeit (Bildschirmzeit-Kontingente) - Yuvomi Fork

Status: Entwurf, kein Code. Alle Muster geprüft gegen prod@56bea7d32 (Migrationen bis v278).

## 1. Ziel & Nutzerstorys

Ziel: Eltern setzen Bildschirmzeit-Kontingente pro Kind; verdiente Punkte aus Aufgaben
verwandeln sich in zusätzlichе Medienzeit; Kinder sehen ihren RestTag; Historie für Auswertung.

- Eltern: "Ich gebe Leo 45 Min/Tag, max 90 Min, Sperre ab 20:30. Hat er die Küchen-Aufgabe
  done, bekommt er 15 Min dazu." Eltern verwalten Kontingente, genehmigen Nachträge, sehen
  Wochen-Auswertung pro Kind und Gerät.
- Kind: sieht heute verbleibende Zeit als Fortschrittsbalken, kann verdiente Punkte in
  Medienzeit tauschen (sofern Eltern Tausch erlauben), meldet Nutzung am Gerät.
- Haushalt: Dashboard-Kachel "Medienzeit heute" pro Kind (Eltern), i18n in allen 27 Locales.

## 2. Erfassungswege - Bewertung (a-e)

| Weg | Bewertung |
|---|---|
| (a) App-interne Stoppuhr (PWA) | Geringste Integrationstiefe, aber Kinder-Tabets sind Multitasking: stoppt nicht, wenn die App in den Hintergrund geht. Browser-Background-Timer sind unzuverlässig (Throttling) und ohne Public-HTTPS kein zuverlässiger Service-Worker-Hintergrund. Braucht trotzdem Server-Authje  Tick - sonst manipulierbar. |
| (b) CalDAV/Kalender-Export | Erfasst nichts; kann nur Kontingente/Sperren als Kalender verteilen. Nettes Add-on (Repo hat caldav-outbound-Muster), keine Erfassung. |
| (c) Heimnetz (Pi-hole/OPNsense) | Einziger Weg, der tatsächlich SPERRT. Aber: externe Abhängigkeit, IP-basierte Kind-Zuordnung ist brüchig (mehrere Geräte, WiFi-Switches), und Yuvomi darf keine Router-Konfiguration als Kern-Pfad annehmen. Als optionale Integration (Webhook/Blockliste per API-Token), nicht als Pflicht. |
| (d) Geräte-Pairing (vorhanden) | Perfekt als IDENTITÄTS-Schicht: der bestehende Kurzcode-Flow (server/routes/displays.js pairingRouter POST /pair, device-pairing.js mit Hash+RateLimit) liefert already "dieses Gerät = dieses Kind". Kein neuer Pairing-Mechanismus nötig. |
| (e) API-Reporting (SDK/APK) | Der realistische Erfassungspfad: geplanter Android-Wrapper meldet Nutzungs-Sessions (screen-on/foreground-Pakete) signiert per api_tokens-Scoped-Token an Yuvomi. Server prüft Kontingent und gibt "erlaubt/gesperrt" zurück. |

Empfehlung: (e) als Kern-Erfassung + (d) als Geräte-Identität, (a) als Fallback für Familien
ohne APK, (c) später als optionale Sperr-Integration, (b) als View-Kosmetik. Begründung:
LAN ohne Public-HTTPS => kein Push/Background zuverlässig; APK ist ohnehin geplant und ist
die einzige Quelle, die "Bildschirm an, Kind aktiv" halbwegs ehrlich meldet. Der Server wird
zur einzigen Autorität (Ledger),KlientKlient kann nur melden, nie selbst erlauben.

## 3. Datenmodell (Migration v279, append-only)

Nach Muster v277/v278: Eintrag { version: 279, description: 'media_time: quota model',
up(database) { PRAGMA-guarded } }, keine Löschpfade für ältere Versionen.

Tabellen:
- media_time_plans: id, user_id FK users ON DELETE CASCADE, daily_minutes INT NOT NULL
  CHECK(0..1440), max_daily_minutes INT (Hardcap inkl. Einkäufen), day_start_time TEXT
  HH:MM (Reset-Marke, Standard '04:00' - Nachtmenschen), quiet_from TEXT / quiet_to TEXT
  (HH:MM, Sperren), points_per_15min INT NULL (Tauschkurs, NULL = Tausch aus), enabled INT.
  Einzeile pro Kind; UNIQUE(user_id).
- media_time_devices: id, user_id FK, name, pairing_device_id NULL FK (verknüpft mit
  displays-Pairing), api_token_hint TEXT, last_seen_at TEXT, revoked INT DEFAULT 0.
- media_time_sessions: id, user_id FK, device_id FK NULL, started_at TEXT NOT NULL,
  ended_at TEXT NULL, minute_key TEXT NOT NULL (YYYY-MM-DD, Haushaltszone via
  householdTimeZone()+todayKey aus server/utils/timezone.js - NIE UTC-Tag),
  minute_granularity_minutes INT DEFAULT 1, reported_by INT (user_id des Meldenden),
  source TEXT CHECK IN ('apk','pwa','manual','adjust'), note TEXT.
  INDEX (user_id, minute_key); ended_at IS NULL = laufende Session (Server kappen bei
  > 12h als Fallback gegen vergessene Sessions).
- media_time_purchases: id, user_id, minutes INT NOT NULL, points_spent INT NOT NULL,
  ledger_entry_id FK reward_ledger (Beleg, damit Reversal sauber bleibt), created_by,
  created_at.
- Kontingent-Einstellung im Präferenz-Stil: Schalter media_time_enabled pro Haushalt über
  das bestehende GET/PUT /api/v1/preferences-Muster (key 'media_time_enabled'), kein
  eigener Präferenz-Router.

Ledger-Anbindung: Punkt-Abbuchung NUR via postLedger(d, { delta: -points, type: 'adjust',
reason: 'media_time:<purchase_id>', createdBy }) - dieselbe Funktion wie rewards.js:388,
unit 'points'. Kein zweites Punktesystem.

## 4. API-Endpunkte (Prefix /api/v1/media-time, app.use-Muster in index.js)

Neuer Scope in server/scopes.js: { key: 'media', prefixes: ['media'] } => media:read/:write
für API-Tokens. Capabilities in PERMISSION_CAPABILITIES: media_manage_quotas (default none,
nur Eltern/Admin), media_view_household (default none - Kinder sehen nur eigene Daten).
requireAdmin reicht nicht, weil ein Elternteil ohne Admin sein Kind verwalten soll =>
Capability + Modulrechte wie bei housekeeping_view_amounts (Server-seitig, nicht nur UI).

- GET  /media-time/today            own: { remaining_min, used_min, quota_min, quiet_active,
  purchases[] }; mit media_view_household: ?user_id= für Kind.
- GET  /media-time/history?user_id=&from=&to=  (parent/cap) - Sessions tageweise gruppiert.
- GET/PUT /media-time/plans/:userId (media_manage_quotas) - PUT validiert HH:MM, Bereiche.
- POST /media-time/devices          (parent) - legt Gerät an, gibt Einmal-Pairing-Link wie
  devicePairingLink(); POST /media-time/devices/:id/revoke.
- POST /media-time/sessions/start   { device_token } -> { allowed: bool, reason?:
  'quota_exceeded'|'quiet_hours'|'no_device', remaining_min }; SERVER entscheidet.
- POST /media-time/sessions/heartbeat { session_id, minute_key, used_minutes } idempotent
  (Idempotency-Middleware vorhanden); POST /sessions/:id/end { used_minutes }.
- POST /media-time/purchase         { minutes } -> bucht Punkte via postLedger, liefert
  neue remaining_min; child darf nur eigene, parent für jedes Kind.
- POST /media-time/adjustments      (parent) - manuelle Korrektur/Nachtrag mit reason.
Request/Response-Felder gehören in ein benanntes Schema mediaTimeProperties analog
taskProperties (schemas.js:227) - Schematests erzwingen das für alle Response-Felder.

## 5. UI

- public/pages/media-time.js (Eltern-Ansicht): Kind-Wähler, Plan-Editor (Tagesminuten,
  Quiet-Hours, Tauschkurs), Geräte-Liste mit Pairing-Code-Dialog (Muster displays),
 Historie Historie -Tabelle pro Tag/Woche, Korrektur-Button.
- Kind-Ansicht (eigene Seite oder Dashboard-Kachel): Ring/Balken "Heute noch 23 Min",
  Tausch-Button "10 Punkte = 15 Min" (nur wenn Kurs gesetzt), Hinweis bei Quiet-Hours.
- Dashboard-Kachel in routes/dashboard.js nach rewards-Muster (Zeile ~1204): Eltern sehen
  pro Kind { used, quota }, Kinder nur sich selbst.
- i18n: Schlüssel-Familie mediaTime.* in allen public/locales/*.json (27 Dateien,
  Konvention _one/_other Plural wie rewardsOwnPending_one); Label-Keys in
  PERMISSION_CAPABILITIES als settings.permCapabilityMedia*.
- Settings-Eintrag (Haushalt aktiviert Medienzeit) im preferences-UI.

## 6. Regel-Engine (neue server/services/media-time.js, d-passing wie rewards.js)

- Tag = [day_start_time, +24h) in Haushaltszone (householdTimeZone + todayKey); Mitternacht
  ist NICHT der Reset (Muster #829). Minute_key bei Session-Start festhalten, nicht bei End.
- Verbrauch = sum(sessions.used_minutes im Tag) - purchases werden ADDITIV aufs Kontingent
  (quota = daily_minutes + sum(purchase.minutes), gedeckelt bei max_daily_minutes).
- Tausch: points_per_15min (z.B. 10 Punkte = 15 Min); Buchung atomar in einer Transaktion
  (purchase-Zeile + postLedger + Session-Auffüllung), Reversal über den Ledger-Beleg.
- Sperre: Server gibt bei start/heartbeat allowed=false zurück; APK/PWA zeigt Hinweis.
  Echte Sperre (App-Block) kann Yuvomi nur mit Heimnetz-Integration (c) oder Device-Policy.
- Punkte-Guthaben für Tausch: ledgerBalance(d, userId, 'points') - negative Salden verboten
  (wie rewards.js getBalance-Pfad).

## 7. Edge-Cases

- Mehrere Geräte parallel: Kontingent pro KIND, nicht pro Gerät; Heartbeats mehrerer
  Geräte werden aufsummiert (das ist korrekt, wenn ein Kind am Handy und am Tablet spielt);
  device_id-Nutzung für die Auswertung.
- Offline: APK puffert Sessions lokal und meldet Heartbeats nach; Server akzeptiert
  Nachmeldungen nur rückwirkend bis 24h und nur minute_granularity - sonst Lücke für
  Erfundene Zeiten. start ohne Server => APK behandelt "keine Antwort" als erlaubt (LAN-Ausall
  darf Kind nicht aussperren), aber der Nachschlag erfolgt beim nächsten Kontakt.
- Streitfälle/Nachträge: adjustments-Endpoint mit reason, im Historien-View als eigene Zeile
  sichtbar (source 'adjust'), nie stilles Editieren von sessions.
- Geschwister-Kopplung ("gemeinsame 60 Min"): bewusst NICHT in v1 (eigene plane pro Kind,
  Plan-Editor bleibt 1:1); Offen-Liste.
- Missbrauch durch Kinder: Heartbeat nur per Geräte-Token (nicht per Kinder-Session-Cookie),
  Uhrzeit-Fälschung am Gerät egal - minute_key kommt serverseitig vom Server bei start;
  Kind kann Plan nicht ändern (Capability default none); Pairing-Code Hash+RateLimit
  verhindert Übernehmen fremder Geräte; APK-Reporting ist ehrlich-appellativ, nicht
  kryptografisch beweisbar - das muss dokumentiert werden (SPEC.md: "Treuhänder-Modell").
- Löschen: Kind-Konto löschen => CASCADE; Kind => Erwachsener machen: plan bleibt, UI blendet.

## 8. Offen - Entscheidungen für Chris

1. Erfassung: nur (e)+(a), oder (c) Heimnetz-Sperrung als v1-Ziel? (Aufwand +1 Woche)
2. Tauschkurs global pro Haushalt oder pro Kind? (vorschlag: pro Kind im Plan)
3. Sollen Kinder die App selbst sperren können ("selbst Schluss"), oder nur Eltern-Sperre?
4. max_daily_minutes als harter Cap (Punkte können ihn nicht überheben) - ja/nein?
5. Geschwister-Gruppenkontingent in v1 oder später?
6. APK-Meldeinterval (Minuten-Takt vs. 15-Min-Blöcke) - Datenschutz-Abwägung: speichert
   Yuvomi "wann war Bildschirm an", nur aggregiert, oder gar keine Rohzeiten?
7. Upstream-PR erwünscht oder nur Fork-Feature? (betrifft Scope: SPEC.md + OpenAPI-Tests
   müssen dann upstream-konform, 27 Locales)
8. Quiet-Hours auch für Eltern sichtbar als globale Haushalts-Sperre (Bildschirmfreie Zeit)?

## 9. Aufwand & Risiken

Aufwand (Tagesäquivalente, Fork-Muster vorhanden):
- Datenmodell + Migration 279 + Service mit Tests: 1,5 d
- Routen + OpenAPI-Schemas + Schematests + Scopes/Capabilities: 1,5 d
- Eltern-UI + Kind-Ansicht + Dashboard-Kachel + i18n (27): 2,0 d
- Pairing-Anbindung + Geräte-Token-Pfad: 0,5 d
- SPEC.md-Kapitel + CHANGELOG [Unreleased] + Doku: 0,5 d
= ~6 Tage ohne APK-Seite; APK-Melder (Android-Wrapper) +2 d extern; Heimnetz-Sperre +3-5 d.

Risiken:
- Unterlaufung: ohne Device-Admin (Android)/MDM meldet kein Client ehrlich; Kind kann
  Flugmodus, andere App, zweite Yuvomi-Instanz nutzen. Das Modell bleibt anwendungsintern
  - wie Punkte: Anreizsystem, nicht Käfig. Nur (c) kann wirklich abschalten.
- Wartung: 27 Locale-Dateien, OpenAPI-Schematests bei jedem neuen Response-Feld,
  append-only-Migrationen => Feature gefriert nach Release weitgehend, Änderungen teuer.
- Doppelt-Währung-Pfad (Punkte -> Zeit): Reversal-Semantik (Aufgabe zurücknehmen nach
  Tausch) muss definiert werden: Kauf bleibt, Punkte-Saldo darf durch Reversal negativ
  werden? Nein - Reversal blockiert, solange Kauf existiert (predictable, wie redemptions).
- APK-getriebene Erfassung akzeptiert LAN-Vertrauen: API-Token im Gerät eines Kindes ist
  angreifbar; Geräte-Token sollten kurzlebig + an pairing_device_id gebunden sein.
