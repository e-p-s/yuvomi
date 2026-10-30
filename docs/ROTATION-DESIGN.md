# Design: Rotation für wiederkehrende Aufgaben (feat/task-rotation)

## Problem (Donetick-Muster, belegt)
Wiederkehrende Aufgaben (Müll raus, Bad putzen) hängen für immer an einer Person.
Donetick löst das mit Rotationsstrategien: Beim Anlegen der Folgeinstanz wird die
nächste Person aus einem Pool bestimmt. Yuvomi hat `spawnRecurrenceFollowup()`
(server/routes/tasks.js) als genau diesen Punkt — dort entsteht die Folgeinstanz
einer Serie. Rotation setzt dort auf, ohne die Recurrence-Engine (RRULE) anzufassen.

## Datenmodell (Migration 272, ans Ende der Migrationskette in server/db.js, guarded)
- `tasks.rotation_mode TEXT CHECK (rotation_mode IS NULL OR rotation_mode IN
  ('round_robin','least_assigned','least_recent'))` — NULL = keine Rotation.
- `tasks.rotation_last_user INTEGER REFERENCES users(id) ON DELETE SET NULL` —
  wer bekam die letzte Folgeinstanz (Serienzustand, wandert als WERT mit, #1603).
- Neue Tabelle `task_rotation_pool (task_id INTEGER NOT NULL REFERENCES tasks(id)
  ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE
  CASCADE, position INTEGER NOT NULL, PRIMARY KEY (task_id, user_id))` —
  Reihenfolge für round_robin = `position`.

## Service (server/services/task-rotation.js, kein Framework)
`pickRotationUser(database, { originTask, pool }) -> userId | null`
- Pool: Zeilen von `originTask` (Serienorigin = recurrence_origin_id ?? task.id),
  sortiert nach `position`. Weniger als 2 Mitglieder ⇒ null (Rotation aus).
- `round_robin`: Nachfolger von `rotation_last_user` im sortierten Pool, mod N;
  null/fremd ⇒ Position 0.
- `least_assigned`: wenigste offene Aufgaben des Pools (status='open', gezählt
  über assigned_to ODER task_assignments, ohne gelöschte Serien-Klone);
  Gleichstand: geringere `rotation_last_user`-Historie dieser Serie, dann `position`.
- `least_recent`: im Pool, dessen letzte Erledigung dieser Serie (completed_at
  über Serie) am längsten her; ohne Historie ⇒ `position`.
- Deterministisch: kein Zufall, Nachschlagbar ohne UI-Nachfragen.

## Ansetzpunkt: spawnRecurrenceFollowup (server/routes/tasks.js)
Nach `nextDate`-Berechnung, innerhalb der bestehenden Transaktion:
1. Serienorigin ermitteln (recurrence_origin_id ?? task.id).
2. Hat das Origin `rotation_mode` und Pool ≥ 2: `pickRotationUser` aufrufen.
3. Gefundener Nutzer ⇒ `assigned_to` der Folgeinstanz = dieser Nutzer;
   `task_assignments` der Folgeinstanz = genau dieser Nutzer (einzig),
   `rotation_last_user` = dieser Nutzer. Ohne Rotation: Verhalten exakt wie heute.
4. `rotation_mode`, `rotation_pool` (Zeilen kopieren), `rotation_last_user`
   wandern als WERT auf die Folgeinstanz (Serie reist als Wert, #1603-Prinzip).

## API (bestehende task-Routen, body-basiert wie gehabt)
Create/Update akzeptieren zusätzlich:
- `rotation_mode`: null | 'round_robin' | 'least_assigned' | 'least_recent'
  (ungültig ⇒ 400 mit bestehendem Fehlerpfad-Stil).
- `rotation_pool`: Array von user_ids; gesetzt ⇒ Pool wird ersetzt
  (alle müssen Household-Mitglieder sein, aktiver Account; Länge 2–10, sonst 400).
  `rotation_mode` gesetzt ohne gültigen Pool ⇒ 400.
Task-Responses (Liste + Detail) liefern `rotation_mode`, `rotation_pool`
(user_ids, positions-sortiert), `rotation_last_user`.
PUT-Entfernung: `rotation_mode: null` löscht Modus und Pool-Zeilen.

## UI (public/js — Vanilla, Yuvomi-Duktus)
Im Aufgaben-Dialog (wiederkehrende Aufgabe): Abschnitt „Rotation“ —
Modus-Auswahl (ohne/Ablösung/Wenigste Aufgaben/Längste frei) + Personen-Picker
(Pool, Reihenfolge = Ablösungsreihenfolge). In der Aufgaben-Detailansicht:
Zeile „Rotation: Ablösung — als nächstes: Leon“ (Vorschau via pickRotationUser
auf aktueller Datenbasis, rein lesend).

## Tests (test/test-task-rotation.js, Stil wie test-tasks-recurrence.js)
- round_robin: 3er-Pool, zweimal abhaken ⇒ Reihenfolge 1→2→3.
- least_assigned: ein Poolmitglied hat 2 offene Fremd-Aufgaben ⇒ nicht gewählt.
- least_recent: zuletzt Erledigter wird übersprungen.
- Rotation aus (NULL) ⇒ Verhalten identisch zu heute (Assignment-Kopie wie zuvor).
- Fremde user_id im Pool ⇒ 400; Poolgröße 1 ⇒ 400 beim Setzen eines Modus.
- Folgeinstanz erbt Modus+Pool als Wert; Löschen des Origins ⇒ SET NULL nur auf
  rotation_last_user, Rotation bleibt an vorhandenen Instanzen tragbar (Pool an
  Instanz kopiert).
- Registrierung als `test:task-rotation` in package.json + suite chain.

## Abnahme
- `npm run test:task-rotation`, `test:tasks-recurrence`, `test:recurrence`,
  `test:tasks-routes`, `test:migrations-append-only`, `test:schema-reconcile`,
  `test:schema-mirror`, `test:layer-boundary` grün.
- Keine neuen Dependencies, kein Framework, kein Build-Tool.
- Deutsche Kommentar-/Doku-Sprache im Repo-Stil (Kommentare erklären WARUM).
