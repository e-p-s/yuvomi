# Family-Link-Uebergabe - Antwortformular (2026-11-05)

## ANTWORT

Die Istzeit-Einspeisung ist in diesem Repo eingebaut (Spec HANDOVER.md,
Commit dc62917df). Migration 287 legt die drei Tabellen an
(`familylink_children`, `familylink_device_map`, `familylink_daily`). Der
Ingest (Server-Takt alle 5 Minuten, Schalter in den Regeln, Standard aus;
zusatzlich "Jetzt abrufen") verarbeitet den Report von
`scripts/familylink/familyhub_screen.py --json`. Die lesende Route
`GET /api/v1/media-time/familylink/usage` ist mit vollem OpenAPI-Schema und
eigener Test-Suite (Service + Routen) im Gate. Ein Fehlerlauf (401/kein
JSON) setzt Status `login_noetig` und schreibt nie 0er-Snapshots - erzwungen
durch Spec-Regel und Tests. Kind-Namen aus dem Report werden verworfen; die
Anzeige kommt aus Yuvomi. Google-Cookies bleiben auf dem Collector-Host.
Zusaetzlich: die Google-Istzeit geht zu Lasten des Medienzeit-Kontingents -
fuer ein zugeordnetes Geraet ersetzt der Google-Wert die Agent-Session-Minuten
(kein Doppelzaehlen); ohne Google-Zeile bleibt die Session die Auskunft.

## BEGRUENDUNG

- Einbau-Spec (Single Source of Truth) abgearbeitet: Migration 287
  append-only in `server/db.js`, Ingest in `server/services/familylink.js`,
  lesende Route + Zuordnung + Ingest-Knopf in
  `server/routes/media-time.js`, Schemata/Pfade/Reasons in
  `server/openapi/` (openapi-structure/-coverage/-reasons/-client-* alle
  gruen).
- Richtung A5 eingehalten: nur abfragen, nie fernsperren. Downtime wird nur
  angezeigt; Yuvomi erzwingt die eigene Ruhezeit.
- Privacy: `display_name` in `familylink_children` ist der Yuvomi-Name; der
  `name`-Feldwert aus dem Collector-Report wird nicht gespeichert (Test:
  "kein Google-Name"). Die Google-Kennung ist eine Ziffernfolge (Pseudonym).
- Tests: `test/test-familylink.js` (8) + `test/test-familylink-routes.js` (8)
  in package.json-Kette und suite-chain-Registrierung. Der HTTP-Ingest-Test
  beweist ueber ein Scheitern-Kommando: Response `login_noetig`, written 0,
  keine Zeile in `familylink_daily`.

## NÄCHSTER SCHRITT

Deploy auf CT135 (Produktion) nach Abschluss der Rest-Suite; danach in den
Medienzeit-Regeln: (1) Collector-Host vorbereiten (`python3
scripts/familylink/familyhub_screen.py --json` lauffaehig, Cookies unter
~/.familyhub, 0600), (2) Schalter "Alle 5 Minuten bei Google abfragen" an,
(3) "Jetzt abrufen" und Zuordnung (Google-Kennung + Geraete) in Gruppe 5
setzen. Falls der Collector-Host nicht der Server-Host ist: entweder Server
auf dem Collector-Host betreiben oder spaeter einen Push-Kanal bauen -
Aktivitaet bleibt ein Lese-Pfad, nichts wird zu Google zurueckgeschrieben.
