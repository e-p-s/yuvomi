# Übergabe: Family-Link-Collector → Yuvomi (Medienzeit-Istzeit)

**Stand:** 2026-11-05 | **Geber:** Hermes CT122 (dieser Host) | **Status:** wartet auf Einbau
**Ziel:** Echte Nutzungszeiten aus Google Family Link in das Kern-Feature
**Medienzeit** einspeisen (Anforderung A5 in `yuvomi-medienzeit`: „Anbindung
Google Family Link API, nur abfragen, nie fernsperren").

> FamilyHub war ein Irrläufer: Spec/Commits dort (`familyhub`-Repo, M15) sind
> **nicht** das Ziel. Richtig ist dieses Repo. Die Collector-Skripte liegen
> jetzt unter `scripts/familylink/` (dieses Repo), identisch mit dem Stand dort.

## Was bereits verifiziert ist (Belege: Report-Lauf 2026-11-05, 14:xx)

- Login des Eltern-Kontos in Xvfb-Chromium (CDP :9333) inkl. 2FA „Tap Yes" —
  Google-Session im Profil `~/.config/chromium-familyhub` (dieser Host, CT122).
- Privater Endpunkt `kidsmanagement-pa.clients6.google.com/kidsmanagement/v1`
  funktioniert mit Session-Cookies + SAPISIDHASH
  (`sha1("<ts> <SAPISID> https://familylink.google.com")`), `Origin`-Header
  Pflicht (sonst 401). Request-Replay über gespeicherte Templates in
  `~/.familyhub/tpl_*.json` (0600) — **niemals committen**.
- `scripts/familylink/familyhub_screen.py --json` liefert live (Kind → Geräte →
  Limit/Verbrauch/Rest + Downtime):

```json
{"date": "2026-11-05", "children": [{"name": "Luke Klein",
  "userId": "115472744062871371857",
  "devices": [{"id": "16512038", "consumed_min": 0.0, "allowed_min": 60.0,
               "remaining_min": 60.0}], "daily_limit_minutes": 60,
  "downtime": "20:00–20:00"}, ...]}
```

- Feldsemantik `appliedTimeLimits`: `[12][2]` = Restminuten bis Downtime (zählt
  live herunter), `[26][3]` = Tageslimit; `consumed = limit − rest` nur wenn
  `rest < limit`. Beleg: Zeitreihe 376→375 in 20-s-Schritten.
- Headless-Chromium von Google abgelehnt — nur Xvfb-Voll-Chromium funktioniert
  (Runbook: `scripts/familylink/README.md` im familyhub-Repo, identische Skripte).

## Einbau-Spec (Kern-Erweiterung, kein Drittanbieter-Modul)

Medienzeit ist bereits Kern-Feature (Schema v286: `media_time_sessions`,
Sperre/Count, Pflichtzeit, Kontingent pro Gerät, Ein-/Ausbuchen). Der Collector
liefert die **Istzeit**, die das manuelle Ausbuchen ablöst (opt-in pro Kind).

1. **Migration** (nächste freie Nummer in `server/db.js`, derzeit 287,
   append-only am Array-Ende):
   - `familylink_children(google_uid TEXT PRIMARY KEY, yuvomi_user_id INTEGER,
     display_name TEXT, enabled INTEGER DEFAULT 1, UNIQUE(yuvomi_user_id))`
     — Zuordnung Kind ↔ Google-Konto (Luke/Leon → Yuvomi-Account-IDs).
   - `familylink_device_map(google_uid TEXT, google_device_id TEXT,
     media_time_device_id INTEGER, PRIMARY KEY(google_uid, google_device_id))`
     — Google-Gerät ↔ Medienzeit-Gerät.
   - `familylink_daily(google_uid TEXT, google_device_id TEXT, day TEXT,
     limit_min REAL, consumed_min REAL, remaining_min REAL, downtime TEXT,
     fetched_at TEXT, PRIMARY KEY(google_uid, google_device_id, day))`.
2. **Ingest:** Server-interner Job (Interval, Default 5 min) ruft
   `python3 scripts/familylink/familyhub_screen.py --json` auf und upsertet
   `familylink_daily`. **401/Fehlerfall schreibt nie 0er-Snapshots** — Status
   `login_noetig` in `sync_config`-artigen Key, UI zeigt Hinweis statt Null.
3. **Lesende Route** `GET /api/v1/media-time/familylink/usage?day=` (oder analog
   bestehender Medienzeit-Routen-Muster) für Tageskarte: Istzeit pro Gerät.
   Pflicht-Gates (yuvomi-backend-suite-guards): Entry in
   `server/openapi/paths/<module>.js`, `withCaseReasons`, Response-Felder in
   `schemas.js`, Test-Suite in package.json-Chain **und** `docs/test-suites.md`.
4. **Medienzeit-Kopplung (Stufe 2, nach Ingest):** pro Gerät/Kind schaltet ein
   Modus `auto_istzeit` — Verbrauch gilt als ausgebucht; Pflichtzeit-Logik
   (duty windows) bleibt Sache von Yuvomi, Google-Downtime nur als Anzeige.

## Datenschutz & Sicherheit (Repo-PRIVACY-Regel)

- Nur **fragen**: abreichen, nie sperren (A5-Grundsatz). Kein Rückschreibpfad.
- Speicherung nur Tag/Minuten-Geräte-Aggregat (kein App-Level, kein Content).
- Google-Session/Cookies bleiben auf dem Collector-Host unter `~/.familyhub/`
  (0600) — niemals ins Repo, niemals über die API herausgeben.
- Kind-IDs (`115472744062871371857`, `105392456347101896583`) sind pseudonym,
  Namen nicht in Test-Fixtures/Log-Ausgaben schreiben.
- Vor Merge: `git grep -iE "SAPISID|PSID|Cookie:|@gmail"` → keine Treffer.

## Offene Punkte / Inferenzen

- `appsandusage`-Template (Pro-App-Aufschlüsselung) ist noch nicht abgehört —
  funktioniert aber voraussichtlich wie `appliedTimeLimits` (Gleichlauf-Test
  steht aus).
- Session-Lebensdauer unbekannt (Google rotiert PSID-Cookies); Annahme: hält
  Tage. Fallback ist der `login_noetig`-Status.

## Antwort an den Geber

Hier in der WebUI-Session antworten oder Datei nach
`/mnt/coding/privat/yuvomi-fork/inbox/<datum>-familylink.md`:

```
ANTWORT: <1-3 Sätze>
BEGRÜNDUNG: <mit Belegstelle>
NÄCHSTER SCHRITT: <was als nächstes passiert>
```
