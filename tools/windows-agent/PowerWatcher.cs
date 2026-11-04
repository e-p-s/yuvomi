using Microsoft.Win32;

namespace YuvomiAgent;

/// <summary>
/// Ueberwacht Standby/Ruhezustand ueber SystemEvents.PowerModeChanged.
/// Suspend: aktive Session wird SOFORT geschlossen (nicht erst per Idle-Timeout) und
/// ein Clock-Resync-Marker gesetzt - nach Resume darf die Spanne ueber den Sleep nicht
/// als Bildschirmzeit zaehlen. Resume: Messung neu starten, Marker zuruecksetzen.
///
/// Hinweis: SystemEvents braucht einen Message-Loop (der Main-Thread via Application.Run
/// liefert ihn). Events kommen auf dem Main-Thread, Handler sind kurz gehalten.
/// </summary>
public sealed class PowerWatcher : IDisposable
{
    private readonly Action<string> _onBoundary;
    private volatile bool _suspended;

    /// <summary>True zwischen Suspend und Resume: Coordinator zaehlt dann keine Zeit.</summary>
    public bool IsSuspended => _suspended;

    /// <summary>Tick, zu dem der letzte Suspend beobachtet wurde (Clock-Resync-Marker).</summary>
    public long SuspendTickCount { get; private set; }

    public PowerWatcher(Action<string> onSessionBoundary)
    {
        _onBoundary = onSessionBoundary;
        SystemEvents.PowerModeChanged += OnPowerModeChanged;
    }

    private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
    {
        try
        {
            switch (e.Mode)
            {
                case PowerModes.Suspend:
                    _suspended = true;
                    SuspendTickCount = (long)NativeMethods.GetTickCount64();
                    _onBoundary("power-suspend");
                    AgentLog.Info("Suspend: Session geschlossen, Clock-Resync-Marker gesetzt");
                    break;

                case PowerModes.Resume:
                    // Zeitablauf waehrend Sleep NICHT zaehlen: Aggregator startet Intervalle neu.
                    _suspended = false;
                    _onBoundary("power-resume");
                    AgentLog.Info("Resume: Messlauf neu gestartet (Clock-Resync)");
                    break;

                case PowerModes.StatusChange:
                    // Akkustatus etc. - keine Session-Grenze.
                    break;
            }
        }
        catch (Exception ex)
        {
            AgentLog.Warn("PowerModeChanged: " + ex.Message);
        }
    }

    public void Dispose()
    {
        try { SystemEvents.PowerModeChanged -= OnPowerModeChanged; } catch { /* best effort */ }
    }
}
