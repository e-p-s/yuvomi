# Yuvomi — Projekt-To-Do: Ideen & Verbesserungsvorschläge

Stand: 2026-11-03. Sammlung aus laufenden PRs, Reviews, Upstream-Beobachtungen und
internen Funden. **Diese Datei gehört zum Fork, nicht zu Upstream-Commits.**
Pfad: `/mnt/tank/coding/privat/yuvomi-fork/PROJECT_IDEEN.md`

Legende: [PR] = hängt an laufendem PR · [UP] = Upstream-Idee/Beobachtung ·
[HAUS] = eigener Nutzungskomfort · [CODE] = Code-Qualität im Fork

---

## 1. Laufende PRs — offene Arbeiten

- [ ] **[PR] #2422 task-approval fertigstellen** (wt-approval, tmp-approval-new):
  4 neue Tests grün bekommen (created_by-Setup, checkin_by_user_id wirkt jetzt),
  OpenAPI: `requires_approval`/`approval_status`/`checkin_at` in die benannten
  Task-Schemas (taskProperties + taskInputProperties) — sonst fällt
  `test:openapi-client-responses` wie bei #2372; UI-Suite, Full-Suite, amend, Push,
  Review-Antwort auf #2422 (Punkte 1–4 + Fund checkin_by_user_id).
- [ ] **[PR] #2372 rotation**: wartet weiter auf CI-Freigabe (Maintainer-Klick).
  Schema-Fix (rotation_* Felder) ist im Test-Merge bewiesen — nach Hold-Ende in den
  Branch übernehmen (OpenAPI-Schema-Stück aus wt-rot-test.cherry-picken).
- [ ] **[PR] #2413 late-decay**: Review-Runde 2 antworten (Punkte 1–11 sind
  abgearbeitet, Full-Suite-Ergebnis abwarten), amend + Push.
- [ ] **[PR] #2423 prerequisites**: dirty (upstream-Kollisionen), Hold — bei
  Hold-Ende zuerst Migrationsnummern prüfen (Upstream steht inzwischen bei 276+).
- [ ] **[PR] #2373 penalties**: Hold auf #2414-Entscheidung.
- [ ] **Merge-Reihenfolge der Migrationsnummern im Blick behalten**: upstream-main
  war 271→276 in zwei Tagen. Regel pro Rebase: letzte Zahl +1, vor Merge die
  dann aktuelle main prüfen. `test:migrations-append-only` fängt Lücken.

## 2. Upstream-Entwicklungen — nutzen oder abzweigen

- [ ] **[UP] `client_api` v1 (gemergt #2472, maschinell erzeugtes OpenAPI-Spec
  #2467)**: Contract für native Clients. Für unsere Android-Planung: Generierung
  aus dem Spec statt Handarbeit. Prüfen ob `openapi-typescript` oder `openapi-generator`
  die sauberste TypeScript-Basis liefert.
- [ ] **[UP] Offizielles HA-Add-on `ulsklyc/yuvomi-home-assistant`**:HA-Add-on-Quelle
  in unserer Home-Assistant-Instanz einbinden und als Parallel-Instanz testen
  (eigene Daten; CT135 bleibt unangetastet). Kein Ingress (frame-ancestors by design),
  `weather_city`-Option kam in PR #5.
- [ ] **[UP] Geräte-Pairing per Kurzcode (#2466) + Signed-in Devices (#2459)**:
  Hermes-Automationstoken-Verwaltung ansehen — neue `api_tokens.kind`-Spalte; prüfen
  ob unser Setup-Token (Hermes) davon berührt wird oder sauber als legacy-Typ läuft.
- [ ] **[UP] `Sign in with Home Assistant` (PR #2428 / Diskussion #2427)**: SSO ohne
  OIDC-Provider — würde zu unserer HA-Instanz passen. Verfolgen; falls gemergt:
  bei uns aktivieren statt zweiter Login-Passwort-Kette.
- [ ] **[UP] Sign-Pflicht vs. unsere ICS-Abos**: neue Schreib-Strenge (#2471) — bei
  jedem Update die Automationen (Hermes-Token-Flows) gegen die Route-Validation testen.

## 3. Haus-eigene Nutzung (CT135-Instanz)

- [ ] **[HAUS] Diana-Kalender-Sync aktualisieren**: aktueller ICS-Abo-Status (id=1)
  nach dem 2.84.0-Update verifiziert (Nov 2026: 23 Termine, 6/6 Titel). Nach jedem
  Upstream-Update kurz gegenprüfen.
- [ ] **[HAUS] HTTPS für Push/Service-Worker**: echter Browser-Push braucht eine
  TLS-Domain; LAN-IP-HTTP blockiert Service Worker. Option bleibt stehen: interne
  Domain + Pangolin/Caddy (intern), kein Public-Tunnel. Entscheidung liegt bei Chris.
- [ ] **[HAUS] Backup-Rollback-Pfad dokumentieren**: Rollback-Punkt des 2.84.0-Updates
  liegt unter `/opt/yuvomi/backups/preupdate-2.84-20261102T2015*` (DB + 135-MB-Tar);
  Alt-Baum `/opt/yuvomi.rol-20261102`. **Nicht löschen bis finale Freigabe.**
- [ ] **[HAUS] Update-Skript bauen** (rsync/tar-Push + npm ci + Health-Check, mit
  automatischem DB-Backup vorher) — der manuelle 2.83→2.84-Pfad war 10 Schritte;
  das lässt sich wiederholen.
- [ ] **[HAUS] Update-Routine**: Upstream released schnell (~täglich); Plan:
  wöchentlicher Check + Update nach Test-Suite grün, statt ad hoc.

## 4. Fork-/Code-Qualität

- [ ] **[CODE] Worktree-Hygiene**: nach jedem gemergten PR den Worktree + Branch
  aufräumen (`git worktree remove`, Branch löschen, Snapshots `snap/*` behalten bis
  der Maintainer gemergt hat). Aktuell 7+ Worktrees, zwei davon mit lokalen
  Test-Merge-Commits (wt-rot-test) — klar beschriften oder wegräumen.
- [ ] **[CODE] Test-Merge-Muster festhalten**: "lokaler Merge-Test upstream×PR ohne
  Push" (wt-rot-test) war der Fund, der die Schema-Lücke bei #2372 fand. Dieses
  Muster vor jedem Hold-Ende/Merge auf alle offenen PRs anwenden.
- [ ] **[CODE] Commit-Nachrichten-Konvention prüfen**: Maintainer schreibt auf Deutsch
  im Code-Kommentar, Englisch im Commit — unsere Commits sollten dem Stil folgen.
- [ ] **[CODE] Anonymität dauerhaft sicherstellen**: Repo-weit `user.name e-p-s`,
  `user.email e-p-s@users.noreply.github.com`. Pre-Commit-Hook gegen `krah-gruppe.de`
  /`d-chrkl`/`C.Klein` im Diff prüfen? (bisher manuell gehalten).

## 5. Android-APK (Projektseite: LLM-WIKI `entities/projects/yuvomi-android.md`)

- [ ] **[HAUS] Stage-1-Wrapper vs. nativ**: Upstream baut gerade native-Client-Basis
  (client_api v1, Pairing). Empfehlung aktualisiert: Wrapper für jetzt, nativ später
  auf client_api-Contract. Entscheidung fällig.
- [ ] **[HAUS] HTTPS-Haken wie oben** — APK ohne TLS funktioniert nicht sauber.

## 6. Offen / Beobachtung

- [ ] **[UP] Diskussion #2414** (Prämien/Strafen): Entscheidung offen — blockiert #2373.
- [ ] **[UP] Issue #2451** (Aufgaben-Ersteller sichtbar): kein Maintainer-Kommentar.
- [ ] **[UP] Neue Feature-Ideen der Community** (#2474 Rezepte-Provider, #2473
  Medikationsplan-Q&A): beobachten ob nützlich für uns.
```
