using System.Threading;

namespace YuvomiAgent;

internal static class Program
{
    private const string MutexName = @"Local\YuvomiAgent.SingleInstance";

    [STAThread]
    private static void Main(string[] args)
    {
        // Single-Instance-Mutex: CreatedNew=true heisst, wir sind die erste Instanz.
        using var mutex = new Mutex(initiallyOwned: true, MutexName, out bool createdNew);
        if (!createdNew)
        {
            // Zweite Instanz: nicht 'using' zurueckgeben (sonst fuehrt das Release beim
            // Dispose zum Freigeben eines Mutex, dem wir nie gehoerten) - einfach beenden.
            return;
        }

        ApplicationConfiguration.Initialize();

        try
        {
            AgentPaths.EnsureRoot();
            var cfg = AgentConfig.Load();
            var device = DeviceIdentity.Load(cfg);
            // Token steht nach dem Pairing in der lokalen config.json - dort hat ihn der
            // Erststart in device.json uebernommen; hier wieder auf null setzen, damit der
            // Speicher nur eine massgebliche Token-Quelle traegt (device.json, dpapi).
            cfg.DeviceToken = "";
            using var api = new ApiClient(cfg, device);
            using var coordinator = BuildCoordinator(cfg, device, api, out var power);

            // Verstecktes Fenster fuer WTS-Sitzungsbenachrichtigungen (braucht ein HWND).
            using var msgWindow = new MessageWindow(wtsEvent => OnWtsEvent(coordinator, wtsEvent));
            msgWindow.RegisterSessionNotifications();

            coordinator.Start();

            // Autostart beim ersten Lauf installieren (idempotent, ueberschreibt sich selbst).
            AutostartInstaller.Install();

            using var tray = new TrayController(coordinator, api);

            Application.Run(); // Message-Loop des Main-Threads (SystemEvents + WTS + Tray)
        }
        catch (Exception ex)
        {
            AgentLog.Error("Schwerer Fehler: " + ex);
        }
        finally
        {
            GC.KeepAlive(mutex); // Mutex bis Prozessende halten
        }
    }

    private static AgentCoordinator BuildCoordinator(AgentConfig cfg, DeviceIdentity device,
        ApiClient api, out PowerWatcher power)
    {
        // PowerWatcher braucht die Session-Grenzen des Coordinators -> Zykik per
        // Null-pruefendem Lambda aufloesen (der Handler feuert erst nach Start()).
        AgentCoordinator? coord = null;
        power = new PowerWatcher(reason => coord?.OnSessionBoundary("power:" + reason));
        coord = new AgentCoordinator(cfg, device, api, power);
        return coord;
    }

    private static void OnWtsEvent(AgentCoordinator coordinator, int wtsEventType)
    {
        switch (wtsEventType)
        {
            case NativeMethods.WTS_SESSION_LOCK:
            case NativeMethods.WTS_CONSOLE_LOGOFF:
            case NativeMethods.WTS_REMOTE_LOGOFF:
                coordinator.OnSessionBoundary("wts-lock-" + wtsEventType);
                break;
            case NativeMethods.WTS_SESSION_UNLOCK:
            case NativeMethods.WTS_CONSOLE_LOGON:
            case NativeMethods.WTS_REMOTE_LOGIN:
                coordinator.OnSessionBoundary("wts-unlock-" + wtsEventType);
                break;
        }
    }
}
