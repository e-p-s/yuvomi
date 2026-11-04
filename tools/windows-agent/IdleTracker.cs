namespace YuvomiAgent;

/// <summary>
/// Idle-Erkennung via GetLastInputInfo (Differenz der ms-Ticks zu GetTickCount64,
/// sekundengenau). Die Idle-Schwelle (Default 60 s) bestimmt, ab wann Bildschirmzeit
/// nicht mehr zaehlt. Session-Grenzen (Lock) behandelt der Coordinator ueber
/// WTSRegisterSessionNotification - dieser Tracker liefert nur "idle/aktiv".
///
/// Achtung laut Doku: synthetische Eingabe (SendInput-Jiggler) zaehlt hier als Eingabe.
/// Gegenhalt ist serverseitig als Heuristik vorgesehen (docs/medienzeit-windows-agent.md).
/// </summary>
public sealed class IdleTracker
{
    private readonly int _thresholdSec;
    private bool _lastIdle;

    public IdleTracker(int thresholdSec)
    {
        _thresholdSec = Math.Max(5, thresholdSec);
    }

    /// <summary>True, wenn seit der letzten Eingabe mehr als die Schwelle vergangen ist.</summary>
    public bool IsIdle()
    {
        var pli = new NativeMethods.LASTINPUTINFO();
        pli.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.LASTINPUTINFO>();
        if (!NativeMethods.GetLastInputInfo(ref pli))
        {
            // API-Fehler: konservativ "aktiv" (nie Zeit wegen API-Panik streichen).
            return false;
        }

        ulong now = NativeMethods.GetTickCount64();
        // dwTime ist uint (wrappt nach ~49,7 Tagen) - ulong-Subtraktion bleibt korrekt.
        ulong idleMs = now - pli.dwTime;
        bool idle = idleMs >= (ulong)_thresholdSec * 1000UL;

        if (idle != _lastIdle)
        {
            _lastIdle = idle;
            AgentLog.Info(idle
                ? "Idle erkannt (>=" + _thresholdSec + "s ohne Eingabe)"
                : "Aktivitaet zurueck");
        }
        return idle;
    }

    /// <summary>Sekunden seit letzter Eingabe (fuer Heartbeat-Diagnose).</summary>
    public double IdleSeconds()
    {
        var pli = new NativeMethods.LASTINPUTINFO();
        pli.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.LASTINPUTINFO>();
        if (!NativeMethods.GetLastInputInfo(ref pli)) return 0;
        return (NativeMethods.GetTickCount64() - pli.dwTime) / 1000.0;
    }
}
