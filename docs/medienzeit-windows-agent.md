# Medienzeit: Windows-Agent (Tray) — Entscheidungsgrundlage

Stand: 04.11.2026. Recherche aus deleg_4e921562 (Windows-Zweig), konsolidiert.
Schwesterdokument: `medienzeit-android-tracker.md` (Android-Erfassung + App-Ausnahmen).
Grundlage bleibt `medienzeit-konzept.md`: Treuhänder-Modell (Anreiz, kein Zwang),
Server-Autorität, minute_key serverseitig, "keine Antwort = erlaubt".

## Kernfrage: Woher nimmt Windows "Bildschirmzeit pro App"?

Es gibt **keine offizielle Per-App-Bildschirmzeit-API** (weder Win32 noch WinRT).
Der Task-Manager zeigt CPU-Zeit, nicht Bildschirmzeit; die Parental Controls API
(Wpcapi.h) ist Vista-era, nur lesend für Standarduser und nicht als Kernpfad brauchbar.
Referenzklasse sind OSS-Tracker mit identischer Architektur (ActivityWatch
`aw-watcher-window`/`aw-watcher-afk`, WhatPulse): **Foreground-Integration selbst bauen.**

## API-Set (offizielle MS-Doku, alle mit C#-P/Invoke-Beispielen)

| API | Zweck |
|---|---|
| `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT)` | Event-getriebener Foreground-Wechsel, Sub-ms-Latenz, garantiert sequentiell; zusätzlich `EVENT_SYSTEM_MINIMIZESTART/END` |
| `GetForegroundWindow` + `GetWindowThreadProcessId` | aktueller Prozess; Polling-Fallback (1 s), Null-Handle-Absicherung (Lock-Screen, Aktivierungsübergaben) |
| `GetLastInputInfo` (Differenz zu `GetTickCount64`) | Idle-Abschlag, sekundengenau; Achtung: SendInput zählt mit (Jiggler-Vektor) |
| `WTSRegisterSessionNotification` + `WM_WTSSESSION_CHANGE` | Lock/Unlock/Logon/Logoff als Session-Grenze (braucht ein HWND) |
| `SystemEvents.PowerModeChanged` / `GetSystemPowerStatus` | Standby/Resume: Session schließen statt Idle-Timeout, Clock-Resync |
| Task Scheduler ("At log on", Restart-on-failure) + HKCU-Run-Key | Autostart; der Task taucht nicht im Task-Manager-Startup-Tab auf |

## Empfohlener Stack

**C#/.NET 8, WinForms-Tray, asInvoker (kein Admin), self-contained Single-File (~70 MB).**
- P/Invoke auf das API-Set oben; NotifyIcon-Tray + verstecktes NativeWindow für WndProc.
- Autostart doppelt: HKCU-Run-Key + Scheduled Task; Watchdog-Zwilling (Task Scheduler
  "Restart on failure") — beide Prozesse überwachen sich gegenseitig.
- HTTP-Client mit Scoped-Token auf die bestehenden `/api/v1/media-time`-Endpunkte,
  Offline-Puffer mit Retry (Konzept §120), 60-s-Heartbeat, source-Wert `win`.
- Aufwand grob 2–4 Tage (Hooks/Idle/WTS ~1 d, REST/Puffer ~1 d, Tray/Pairing ~0,5–1 d,
  Installer/Update ~0,5–1 d).

Verworfen: **Electron** (100+ MB Chromium auf 8-GB-Kinder-Laptop, Prozessfamilie leicht
killbar, Hook trotzdem nur über natives Addon); **Python/pywin32** (gut als 1-Tages-Spike,
schlecht als Daueragent: PyInstaller triggert SmartScreen/AV, kein sauberer Update-Pfad);
**Windows-Dienst/Session 0** (GetLastInputInfo/WinEventHooks sind session-spezifisch —
am Ende braucht man doch einen User-Session-Helper, also 2 Prozesse für nichts);
**Rust/windows-crate** (gleichwertige Präzision, 5–10 MB exe, aber eigene
GetMessageW-Pump-Arbeit und dünneres Tray/Update-Ökosystem — nur bei Rust-Präferenz).

## Anti-Cheat: was trägt, wo die ehrliche Grenze liegt

| Vektor | Gegenhalt | Ehrliche Grenze |
|---|---|---|
| Agent im Task-Manager killen | Watchdog-Zwilling via Task Scheduler | Kind mit Admin-PIN stoppt beide |
| Autostart-Eintrag löschen | Task (nicht im Startup-Tab sichtbar) + Server-Alert bei `last_seen_at > X` | Admin-Kind bedient taskschd.msc |
| Zweiter Local-Account ohne Agent | Agent auf allen Accounts melden lassen (Gerätename + User-SID) | ohne Device-Admin/BitLocker+Family-Safety nie dicht |
| SendInput-Jiggler (zählt als Eingabe!) | Heuristik: "aktiv, aber 0 Foreground-Events" → Eltern-Hinweis | Input-Synthese ≠ echte Eingabe, nicht sicher trennbar |
| Zweites Gerät (Handy) | Kontingent pro Kind cross-device (Konzept §7), Geräte-Pairing | — |
| Token exfiltrieren | gerätekurzlebig, an pairing_device_id gebunden, Rate-Limit, plausible-max-Minutes, Nachmeldungen ≤24 h | Gerät in Kinderhand = Token angreifbar |
| Flugmodus/LAN-Kappen | lokaler Puffer + serverseitige Lücken-Erkennung | dokumentierte Lücke, nie geratene Zeiten |
| Tracker-Killer-Tools | optional AppLocker/WDAC (Eltern-Option) | GPO-Verwaltung = Admin-Klick, Admin ist potenziell das Kind |

Der eigentliche Hebel ist nicht der Agent, sondern: **Kinder-Account als Standarduser**,
Eltern-PIN für den Admin-Account.

## Serverschnittstelle

Keine neue API nötig — der Agent nutzt exakt die Android-Endpunkte aus
`medienzeit-android-tracker.md` (sync/heartbeat/end, exceptions_version, quota-state).
Einzige Server-Änderung bei Umsetzung: `media_time_sessions.source`-CHECK um `'win'`
erweitern (Migration v282, append-only).

## Quellen (Auswahl)

- learn.microsoft.com: setwineventhook, getforegroundwindow, getlastinputinfo,
  wm-wtssession-change, Power-Management (WinForms), Task Scheduler, AppLocker,
  Parental Controls Overview
- github.com/ActivityWatch/aw-watcher-window (Architektur-Referenz)
- docs.rs/win_event_hook, docs.rs/wineventhook (Rust-Pfad)
- Vollständige Liste (24 URLs) im Transkript
  `/root/.hermes/cache/delegation/live/deleg_4e921562/task-0.log`
