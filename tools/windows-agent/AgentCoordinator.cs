namespace YuvomiAgent;

/// <summary>
/// Verdrahtet die Bausteine: ForegroundTracker -> SessionAggregator, Idle/Power/WTS ->
/// Session-Grenzen, plus den 1s-Tick, den 60s-Heartbeat und den periodischen Sync.
/// Laeuft auf Background-Tasks; UI-Elemente (Tray) bleiben auf dem Main-Thread.
/// </summary>
public sealed class AgentCoordinator : IDisposable
{
    private readonly AgentConfig _cfg;
    private readonly DeviceIdentity _device;
    private readonly ForegroundTracker _foreground;
    private readonly IdleTracker _idle;
    private readonly PowerWatcher _power;
    private readonly SessionAggregator _aggregator;
    private readonly ApiClient _api;
    private readonly EnforcementController? _enforcement;

    private readonly CancellationTokenSource _cts = new();
    private Task? _tickTask;
    private Task? _heartbeatTask;
    private Task? _syncTask;

    public event Action<string>? StatusChanged;

    public AgentCoordinator(AgentConfig cfg, DeviceIdentity device, ApiClient api, PowerWatcher power)
    {
        _cfg = cfg;
        _device = device;
        _api = api;
        _power = power;
        _foreground = new ForegroundTracker();
        _idle = new IdleTracker(cfg.IdleThresholdSec);
        _aggregator = new SessionAggregator(device, cfg);
        // Enforcement (Nutzer 04.11.): bei enforcement='lock' vom Server meldet
        // der Agent "Zeit ist um" und meldet den PC nach Ablauf der Frist ab.
        // 'count' (Default) = reine Meldespur, der Agent sperrt nie.
        _enforcement = new EnforcementController(api, cfg);
    }

    public void Start()
    {
        _foreground.ForegroundChanged += ev => _aggregator.OnForegroundEvent(ev);
        _foreground.Start();

        _tickTask = Task.Run(TickLoopAsync);
        _heartbeatTask = Task.Run(HeartbeatLoopAsync);
        _syncTask = Task.Run(SyncLoopAsync);
        AgentLog.Info("Coordinator gestartet (idle=" + _cfg.IdleThresholdSec + "s, heartbeat=" +
                      _cfg.HeartbeatSec + "s, sync=" + _cfg.SyncIntervalSec + "s)");
    }

    /// <summary>Vom MessageWindow (WTS) und PowerWatcher aufgerufen.</summary>
    public void OnSessionBoundary(string reason)
    {
        _aggregator.OnSessionBoundary(reason);
        StatusChanged?.Invoke("Session-Grenze: " + reason);
    }

    private async Task TickLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            try
            {
                var idle = _idle.IsIdle();
                // Nach Resume bis zum naechsten Foreground-Event keine Sleep-Spanne zaehlen:
                // PowerWatcher.IsSuspended blockiert das Zaehlen komplett.
                var screenOn = !_power.IsSuspended && !idle;
                _aggregator.OnTick(DateTime.UtcNow, idle || _power.IsSuspended, screenOn);
            }
            catch (Exception ex)
            {
                AgentLog.Warn("Tick: " + ex.Message);
            }
            await DelaySafe(1000);
        }
    }

    private async Task HeartbeatLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            await DelaySafe(_cfg.HeartbeatSec * 1000);
            try
            {
                // session_key des offenen Intervalls (stabil, Idempotent); sonst generischer
                // periodischer Key (auf die Minute gerundet), damit der Key nie leer ist.
                var key = _aggregator.CurrentOpenSessionKey() ?? _device.SessionKeyFor("heartbeat",
                    new DateTime(DateTime.UtcNow.Ticks / TimeSpan.TicksPerMinute * TimeSpan.TicksPerMinute,
                        DateTimeKind.Utc));
                var ok = await _api.HeartbeatAsync(key, _cts.Token);
                _enforcement?.Evaluate();
                StatusChanged?.Invoke(ok ? "online" : "offline");
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { AgentLog.Warn("Heartbeat: " + ex.Message); }
        }
    }

    private async Task SyncLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            await DelaySafe(_cfg.SyncIntervalSec * 1000);
            try
            {
                // Erst Puffer abarbeiten (Reihenfolge), dann frische Segmente.
                var flushed = await _api.FlushOutboxAsync(_cts.Token);
                if (flushed > 0) AgentLog.Info("Outbox: " + flushed + " Saetze nachgeliefert");

                var payload = _aggregator.BuildSyncPayload();
                if (payload.Count > 0)
                {
                    var ok = await _api.SyncAsync(payload, _cts.Token);
                    _enforcement?.Evaluate();
                    if (ok) AgentLog.Info("Sync: " + payload.Count + " Sessions uebertragen");
                    // ok==false heisst: zurueck im Puffer, beim naechsten Durchlauf erneut.
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { AgentLog.Warn("Sync: " + ex.Message); }
        }
    }

    private async Task DelaySafe(int ms)
    {
        try { await Task.Delay(ms, _cts.Token); }
        catch (OperationCanceledException) { /* Shutdown */ }
    }

    /// <summary>Beim Beenden: offene Intervalle schliessen und ein letzter Sync-Versuch.</summary>
    public async Task ShutdownAsync()
    {
        _aggregator.OnSessionBoundary("agent-exit");
        try
        {
            var payload = _aggregator.BuildSyncPayload();
            if (payload.Count > 0)
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                await _api.SyncAsync(payload, timeout.Token);
            }
        }
        catch { /* letzter Versuch, Puffer haelt die Daten anyway */ }
    }

    public void Dispose()
    {
        _cts.Cancel();
        _enforcement?.Dispose();
        _foreground.Dispose();
        _aggregator.Dispose();
    }
}
