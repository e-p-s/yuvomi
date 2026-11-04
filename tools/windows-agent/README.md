# Yuvomi Windows-Agent

Tray-Agent (C#/.NET 8, WinForms, asInvoker) fuer die Medienzeit-Erfassung unter Windows.
Konzept + Begruendung: `docs/medienzeit-windows-agent.md` im Repo. Kurz: Der Agent misst
Bildschirmzeit pro App (Foreground-Integration ueber WinEventHooks), meldet sie an die
bestehenden `/api/v1/media-time/tracker/*`-Endpunkte und sperrt **nichts** hart
(Treuhaender-Modell: der Server antwortet erlaubt/gesperrt, der Agent puffert nur).

## Bausteine

| Datei | Rolle |
|---|---|
| `Program.cs` | Einzelinstanz-Mutex, Start aller Komponenten, `Application.Run`-Message-Loop |
| `NativeMethods.cs` | Komplette P/Invoke-Signaturen (user32/kernel32/wtsapi32) |
| `ForegroundTracker.cs` | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT)` + Pump-Thread (`GetMessageW`) + 1s-Poll-Fallback; Null-Handle-Absicherung (Lock-Screen) |
| `IdleTracker.cs` | `GetLastInputInfo` vs `GetTickCount64`, Schwelle Default 60 s |
| `MessageWindow.cs` | Verstecktes `NativeWindow` -> `WTSRegisterSessionNotification` (Lock/Unlock/Logoff als scharfe Session-Grenze) |
| `PowerWatcher.cs` | `SystemEvents.PowerModeChanged`: Suspend => Session sofort zu + Clock-Resync-Marker, Resume => neu starten |
| `SessionAggregator.cs` | Intervalle pro Process, Merge Luecken <= 3 s, `session_key = SHA256(deviceGuid|package|started_at)` |
| `ApiClient.cs` | sync + heartbeat, Offline-Puffer `%LOCALAPPDATA%\YuvomiAgent\outbox.jsonl`, Backoff 5 s..5 min; Fehler => NUR puffern ("keine Antwort = erlaubt") |
| `Config.cs` / `DeviceIdentity.cs` | `config.json`, deviceGuid + Token (DPAPI, CurrentUser), Logs |
| `AutostartInstaller.cs` | HKCU-Run-Key + `schtasks /Create /SC ONLOGON` (beide, Redundanz) |
| `TrayController.cs` | NotifyIcon: Status, Autostart installieren/entfernen, Beenden |

## Bauen (Entwickler)

Voraussetzung: .NET 8 SDK auf einem Windows-PC (Build geht auch cross, aber Testen nur unter Windows).

```
cd tools/windows-agent
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

Ergebnis: `bin/Release/net8.0-windows/win-x64/publish/YuvomiAgent.exe` (self-contained
Single-File, ~70 MB, kein .NET auf dem Zielrechner noetig).

Fuers Distribueren zusaetzlich empfehlenswert (kleinere, startschnellere exe):

```
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishReadyToRun=true
```

## Pairing: Geraete-Token holen

Der Agent braucht einen serverseitig gepairten `deviceToken` (Bearer). Vorgehen:

1. Auf dem Server/Eltern-Interface ein Pairing-Geraet anlegen (Pfad: Admin-UI ->
   Geraete -> "Windows-Agent koppeln"; der Server zeigt den einmalig angezeigten Token).
2. Auf dem Kinder-Windows-PC `%LOCALAPPDATA%\YuvomiAgent\config.json` anlegen:

```json
{
  "baseUrl": "https://dein-server.example.org",
  "deviceToken": "<TOKEN AUS DEM PAIRING>",
  "idleThresholdSec": 60,
  "heartbeatSec": 60,
  "syncIntervalSec": 120,
  "mergeGapSec": 3
}
```

3. `YuvomiAgent.exe` einmal starten. Beim Erststart erzeugt er `device.json`
   (deviceGuid + DPAPI-verschluesselter Token) und installiert Autostart automatisch.

`deviceToken` steht damit nur in der lokalen config.json bzw. dpapi-verschluesselt in
device.json - niemals in Logs.

## Autostart

Beim Start installiert der Agent beide Eintraege (idempotent):
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\YuvomiAgent`
- Task Scheduler: Task `YuvomiAgent`, "At log on" (sichtbar in taskschd.msc, NICHT im
  Task-Manager-Startup-Tab)

Entfernen: Tray-Menue -> "Autostart entfernen", oder manuell
`schtasks /Delete /TN YuvomiAgent /F` + Run-Key-Wert loeschen.

## Bauen & Testen auf einem Windows-PC

Exakte Schritte inkl. erstem Funktionstest:

1. .NET 8 SDK installieren (https://dotnet.microsoft.com/download/dotnet/8.0).
2. Repo klonen/aktualisieren, in `tools\windows-agent` wechseln.
3. `dotnet build -c Release` - muss fehlerfrei durchlaufen (prueft u. a. alle
   P/Invoke-Signaturen).
4. `dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true`
5. config.json wie oben angelegt in `%LOCALAPPDATA%\YuvomiAgent\` schreiben.
6. `YuvomiAgent.exe` per Doppelklick starten. Im Tray erscheint das App-Icon
   (Kontextmenue: Status, Autostart, Beenden).
7. **Erster Funktionstest (online):** Zwischen zwei Fenstern wechseln (z. B. Notepad ->
   Explorer). Nach spaetestens `syncIntervalSec` (Default 120 s) muss im Server-Log ein
   `POST /api/v1/media-time/tracker/sync` mit `sessions[]` (package = Prozessname,
   foreground_ms > 0) erscheinen; alle 60 s ein heartbeat.
8. **Erster Funktionstest (offline):** Server-URL in config.json auf eine nicht
   existierende Host setzen, Agent neu starten, Fenster wechseln. Erwartung: Es erscheint
   kein Fehlerdialog, der Agent laeuft weiter, und
   `%LOCALAPPDATA%\YuvomiAgent\outbox.jsonl` waechst (eine Zeile pro gepuffertem sync).
   Nach zurueckgesetzter URL + Warten leert sich die Datei wieder (Backoff: erste
   Wiederholung nach 5 s, dann verdoppelt bis 5 min).
9. Lock-Test: Win+L, 2 Minuten warten, entsperren. Die Sperrzeit darf NICHT als
   Bildschirmzeit erscheinen (WTS_SESSION_LOCK schliesst das Intervall sofort).
10. Autostart-Test: Abmelden/Anmelden -> Agent ist ohne Doppelklick wieder im Tray
    (Einzelinstanz-Mutex verhindert die Run-Key+Task-Doppelung).

## Bekannte Grenzen (ehrlich)

- **Task-Manager-Kill:** Der Agent-Prozess ist per Task-Manager beendbar. Gegenhalt ist
  der Watchdog-Zwilling (Task Scheduler "Restart on failure" + gegenseitige Ueberwachung
  zweier Prozesse) - bewusst als spaeterer Schritt dokumentiert, noch nicht implementiert.
- **Admin des Kindes ist der eigentliche Hebel:** Ein Kind mit Admin-PIN stoppt Agent,
  Task und Autostart. Wirksam wird das Modell erst mit Kinder-Account als Standarduser und
  Eltern-PIN fuer den Admin-Account (siehe Konzept-Doku).
- **SendInput-Jiggler** zaehlt bei `GetLastInputInfo` als Eingabe (dokumentierter
  Jiggler-Vektor); Gegenhalt ist eine serverseitige Heuristik, nicht der Agent.
- **DPAPI ist kein Schutz gegen das angemeldete Kind:** Geraet in Kinderhand = Token
  angreifbar. Device-Token serverseitig kurzlebig halten (Anti-Cheat-Tabelle im Konzept).
- **Kein Per-App-Bildschirmzeit-API von Microsoft:** Der Agent integriert Foreground
  selbst (Referenzklasse ActivityWatch); Randfaelle (Dialog-Fenster derselben App,
  UAC-Prompt) zaehlen naherungsweise auf die Prozess-der-App-Ebene.

## Konfiguration

`appsettings.json` (neben der EXE, Fallback) wird ueberschrieben durch
`%LOCALAPPDATA%\YuvomiAgent\config.json`:

| Key | Default | Bedeutung |
|---|---|---|
| `baseUrl` | - | Server-Basis (ohne /api-Suffix) |
| `deviceToken` | "" | Pairing-Token (Bearer); niemals ins Log |
| `idleThresholdSec` | 60 | Ab wann Bildschirmzeit nicht mehr zaehlt |
| `heartbeatSec` | 60 | Heartbeat-Intervall |
| `syncIntervalSec` | 120 | Sync-Intervall (abgeschlossene Segmente) |
| `mergeGapSec` | 3 | Luecken <= N s zwischen Intervallen derselben App werden merged |
