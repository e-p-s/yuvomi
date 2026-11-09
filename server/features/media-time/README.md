# Feature-Modul: Medienzeit (Bildschirmzeit + Google Family Link)

Eigenstaendiger Ort fuer die Medienzeit-Serverseite. Ziel: Upstream-Merges
sollen moeglichst keine Kern-Dateien streifen. Kern-Anker (bewusst minimal):

| Kern-Datei | Haken |
|---|---|
| `server/index.js` | 3 Imports + `startFamilylinkScheduler({ db, runExternalJob, log })` |
| `server/openapi/schemas.js` | `import { mediaTimeComponents }` + `...mediaTimeComponents` im schemas-Objekt |
| `server/db.js` | Migrationen 284-287 bleiben im Kern-Array (das Gate `test:migrations-append-only` liest den db.js-Quelltext; Auslagern waere ein Gate-Bruch) |
| `server/routes/preferences.js` | Modulname `media_time` in den Ordnungs-Regexen + Schalter-Felder |
| `public/*` | Eigene Seiten-/CSS-Dateien; Registrierungshaken in `router.js`, Nav und Settings-Registry (je 1-3 Zeilen) |

## Dateien

- `routes.js` - Eltern-/Kind-/Tracker-Routen (Mount-Prefix `/api/v1/media-time`)
- `report-routes.js` - Push-Report-Router (Mount-Prefix `/api/v1`, VOR dem
  globalen requireAuth; eigener Router pro Datei - der OpenAPI-Routen-Tracer
  ordnet sonst falsche Mounts zu)
- `service.js` - Regel-Engine (dayUsage inkl. Family-Link-Ersatz)
- `familylink.js` - Ingest, Status, usage; 401 schreibt nie 0er-Snapshots
- `familylink-login.js` - Fernlogin-Sessions (Challenge/Pending)
- `scheduler.js` - 5-Minuten-Ingest-Takt (Schalter in sync_config)
- `openapi-schemas.js` - mediaTimeProperties + mediaTimeComponents (Spec-Bausteine)

## Wartung nach Upstream-Merges

`git log --oneline -- server/` prueft, ob Upstream unsere Haken-Dateien
angetastet hat. Die Module-Dateien selbst kann Upstream nicht anfassen - sie
existieren dort nicht. Bei Migrationsnummern: eigene Nummern NUR am Ende des
Kern-Arrays anhaengen (append-only; Aufwaerts-Kompatibilitaet).
