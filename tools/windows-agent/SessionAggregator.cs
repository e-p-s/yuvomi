using System.Collections.Concurrent;

namespace YuvomiAgent;

/// <summary>
/// Foreground-Events + Idle-Status -> UsageSegments pro Prozess (package = Prozessname).
/// Schliesst ein Intervall bei: Fensterwechsel, Idle-Schwelle, Lock, Suspend.
/// Merge: Luecken <= MergeGapSec zwischen Intervallen derselben package werden zusammengefasst.
/// Session-Key = SHA256(deviceGuid|package|started_at) (Idempotenz).
/// </summary>
public sealed class SessionAggregator : IDisposable
{
    private readonly DeviceIdentity _device;
    private readonly AgentConfig _cfg;
    private readonly object _gate = new();

    // Es gibt genau EIN aktives Intervall (das foreground-Fenster). Wir halten es als Feld;
    // das Dictionary-Pattern ware possible, aber ein Slot ist hier exakt die Domaene.
    private UsageSegment? _active;
    // abgeschlossene Segmente, die noch nicht hochgeladen wurden
    private readonly List<UsageSegment> _pending = new();

    private readonly ConcurrentDictionary<uint, string> _processNameCache = new();
    private DateTime _lastTickUtc = DateTime.UtcNow;

    public SessionAggregator(DeviceIdentity device, AgentConfig cfg)
    {
        _device = device;
        _cfg = cfg;
    }

    /// <summary>Wird vom ForegroundTracker (Consumer-Thread) aufgerufen.</summary>
    public void OnForegroundEvent(ForegroundTracker.ForegroundEvent ev)
    {
        var package = ResolvePackage(ev);
        var now = ev.AtUtc;

        lock (_gate)
        {
            if (_active is not null)
            {
                // Wechsel auf andere App (oder Null-Handle): aktives Intervall schliessen.
                if (package is null || package != _active.Package)
                {
                    CloseSegment(_active, now);
                    _active = null;
                }
                else
                {
                    // Gleiches Paket: Luecke <= mergeGap => weiterlaufen, sonst neu eroffnen.
                    var gap = (now - (_active.EndedAt ?? _active.StartedAt)).TotalSeconds;
                    if (gap > _cfg.MergeGapSec)
                    {
                        CloseSegment(_active, now);
                        _active = NewSegment(package, now);
                    }
                    // sonst: Intervall laeuft weiter
                    return;
                }
            }

            if (package is not null)
            {
                // Null-Handle (Lock/Activation): kein neues Intervall, Zeit zaehlt nicht als App-Zeit.
                _active = NewSegment(package, now);
            }
        }
    }

    /// <summary>
    /// Tick (1x/s vom Coordinator): haelt foreground/screen-on-ms pro Sekunde fest und
    /// schliesst bei Idle ueber Schwelle (scharfe Grenze).
    /// </summary>
    public void OnTick(DateTime nowUtc, bool idle, bool screenOn)
    {
        lock (_gate)
        {
            var deltaMs = (long)(nowUtc - _lastTickUtc).TotalMilliseconds;
            _lastTickUtc = nowUtc;
            if (deltaMs <= 0 || deltaMs > 60_000) deltaMs = 1000; // Clock-Sprung absichern

            if (_active is null) return;

            if (idle)
            {
                CloseSegment(_active, nowUtc);
                _active = null;
                return;
            }

            _active.ForegroundMs += deltaMs;
            if (screenOn) _active.ScreenOnMs += deltaMs;
        }
    }

    /// <summary>Lock/Suspend/Logoff: aktives Intervall sofort schliessen (scharfe Session-Grenze).</summary>
    public void OnSessionBoundary(string reason)
    {
        var now = DateTime.UtcNow;
        lock (_gate)
        {
            if (_active is not null)
            {
                CloseSegment(_active, now);
                _active = null;
            }
            _lastTickUtc = now; // Clock-Resync: Spanne ueber die Grenze nie nachzaehlen
        }
        AgentLog.Info("Session-Grenze (" + reason + "): aktives Intervall geschlossen");
    }

    /// <summary>Sessions fuer den Upload finalisieren (EndedAt gesetzt, session_key erzeugt).</summary>
    public List<SyncSession> BuildSyncPayload(int max = 200)
    {
        List<UsageSegment> batch;
        lock (_gate)
        {
            var take = Math.Min(max, _pending.Count);
            batch = _pending.GetRange(0, take);
            _pending.RemoveRange(0, take);
        }

        var result = new List<SyncSession>(batch.Count);
        foreach (var seg in batch)
        {
            if (seg.DurationMs < 1000) continue; // Rauschen < 1 s ignorieren
            result.Add(new SyncSession
            {
                SessionKey = _device.SessionKeyFor(seg.Package, seg.StartedAt),
                Package = seg.Package,
                StartedAt = seg.StartedAt,
                EndedAt = seg.EndedAt ?? DateTime.UtcNow,
                ForegroundMs = seg.ForegroundMs,
                ScreenOnMs = seg.ScreenOnMs,
                Kind = seg.Kind,
            });
        }
        return result;
    }

    /// <summary>Session-Key des aktuell offenen Intervalls (Heartbeat), sonst null.</summary>
    public string? CurrentOpenSessionKey()
    {
        lock (_gate)
        {
            return _active is null ? null : _device.SessionKeyFor(_active.Package, _active.StartedAt);
        }
    }

    private static UsageSegment NewSegment(string package, DateTime startUtc) => new()
    {
        Package = package,
        StartedAt = startUtc,
        Kind = "app",
    };

    private void CloseSegment(UsageSegment seg, DateTime end)
    {
        seg.EndedAt = end;
        seg.ForegroundMs = Math.Max(0, Math.Min(seg.ForegroundMs, seg.DurationMs));
        seg.ScreenOnMs = Math.Max(0, Math.Min(seg.ScreenOnMs, seg.DurationMs));
        _pending.Add(seg);
    }

    /// <summary>hwnd/pid -> Prozessname (cache). Null-Handle oder toter Prozess -> null.</summary>
    private string? ResolvePackage(ForegroundTracker.ForegroundEvent ev)
    {
        if (ev.Hwnd == IntPtr.Zero || ev.ProcessId == 0) return null;
        return _processNameCache.GetOrAdd(ev.ProcessId, pid =>
        {
            try
            {
                using var p = System.Diagnostics.Process.GetProcessById((int)pid);
                return p.ProcessName;
            }
            catch
            {
                return "pid-" + pid;
            }
        });
    }

    public void Dispose()
    {
        var now = DateTime.UtcNow;
        lock (_gate)
        {
            if (_active is not null)
            {
                CloseSegment(_active, now);
                _active = null;
            }
        }
    }
}

/// <summary>Draht-Format fuer POST /api/v1/media-time/tracker/sync (sessions[]-Element).</summary>
public sealed class SyncSession
{
    public required string SessionKey { get; init; }
    public required string Package { get; init; }
    public required DateTime StartedAt { get; init; }
    public DateTime? EndedAt { get; init; }
    public long ForegroundMs { get; init; }
    public long ScreenOnMs { get; init; }
    public required string Kind { get; init; }
}
