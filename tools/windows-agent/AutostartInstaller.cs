using Microsoft.Win32;

namespace YuvomiAgent;

/// <summary>
/// Autostart, doppelt ausgelegt (Redundanz):
///  1) HKCU\Software\Microsoft\Windows\CurrentVersion\Run   (Standard, im Startup-Tab sichtbar)
///  2) Task Scheduler via 'schtasks /Create' "At log on"    (taucht NICHT im Startup-Tab auf)
///
/// Beide Eintraege zeigen auf dieselbe EXE. Der Task ist der robuste Anteil; der Run-Key
/// ist der einfache. Der Watchdog-Zwilling (Restart-on-failure) ist als spaeterer Schritt
/// dokumentiert (README, Grenzen) - bewusst nicht implementiert, um diesen Schnitt klein
/// zu halten.
///
/// Benotigt keine Admin-Rechte (HKCU + Task im User-Kontext).
/// </summary>
public static class AutostartInstaller
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "YuvomiAgent";
    private const string TaskName = "YuvomiAgent";

    private static string ExePath =>
        Environment.ProcessPath ?? System.Reflection.Assembly.GetEntryAssembly()?.Location ?? "YuvomiAgent.exe";

    /// <summary>Beide Autostart-Pfade installieren. Gibt true zurueck, wenn mindestens einer klappte.</summary>
    public static bool Install()
    {
        var okRun = InstallRunKey();
        var okTask = InstallScheduledTask();
        if (!okRun && !okTask)
        {
            AgentLog.Warn("Autostart: beide Wege fehlgeschlagen");
            return false;
        }
        AgentLog.Info("Autostart installiert (Run-Key=" + okRun + ", Task=" + okTask + ")");
        return true;
    }

    public static void Uninstall()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
            key?.DeleteValue(RunValueName, throwOnMissingValue: false);
        }
        catch (Exception ex) { AgentLog.Warn("Run-Key entfernen: " + ex.Message); }

        TryRunSchtasks("/Delete /TN \"" + TaskName + "\" /F");
        AgentLog.Info("Autostart deinstalliert");
    }

    private static bool InstallRunKey()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath);
            if (key is null) return false;
            key.SetValue(RunValueName, "\"" + ExePath + "\"");
            return true;
        }
        catch (Exception ex)
        {
            AgentLog.Warn("Run-Key setzen fehlgeschlagen: " + ex.Message);
            return false;
        }
    }

    private static bool InstallScheduledTask()
    {
        var exe = "\"" + ExePath + "\"";
        // At log on, im Kontext des angemeldeten Users, kein Admin noetig.
        var args = "/Create /F /TN \"" + TaskName + "\" /SC ONLOGON /TR " + exe;
        return TryRunSchtasks(args);
    }

    private static bool TryRunSchtasks(string arguments)
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "schtasks.exe",
                Arguments = arguments,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using var p = System.Diagnostics.Process.Start(psi);
            if (p is null) return false;
            var stdout = p.StandardOutput.ReadToEnd();
            var stderr = p.StandardError.ReadToEnd();
            p.WaitForExit(15000);
            var ok = p.HasExited && p.ExitCode == 0;
            if (!ok)
            {
                AgentLog.Warn("schtasks exit=" + (p.HasExited ? p.ExitCode.ToString() : "timeout") +
                              " " + stderr.Trim());
            }
            return ok;
        }
        catch (Exception ex)
        {
            AgentLog.Warn("schtasks-Aufruf: " + ex.Message);
            return false;
        }
    }
}
