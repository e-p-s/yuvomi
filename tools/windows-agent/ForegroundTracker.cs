using System.Runtime.InteropServices;

namespace YuvomiAgent;

/// <summary>
/// Erfasst Foreground-Wechsel per SetWinEventHook(EVENT_SYSTEM_FOREGROUND,
/// WINEVENT_OUTOFCONTEXT). Der Callback laeuft auf dem Thread, der die Hook-Pumpe
/// besitzt: Er schreibt NUR hwnd/pid in eine BlockingCollection (kein Blockieren,
/// keine Fenster- oder Prozess-APIs im Callback). Ein separater Consumer-Thread loest
/// daraus Prozessnamen auf.
///
/// Null-Handle-Absicherung: GetForegroundWindow kann 0 zurueckgeben (Lock-Screen,
/// Aktivierungsuebergaben). In dem Fall wird das aktuelle Intervall geschlossen, ohne
/// ein neues zu oeffnen (die Zeit zaehlt nicht als App-Zeit).
/// </summary>
public sealed class ForegroundTracker : IDisposable
{
    private readonly BlockingCollection<ForegroundEvent> _events = new(boundedCapacity: 4096);
    private readonly CancellationTokenSource _cts = new();
    private readonly NativeMethods.WinEventDelegate _hookProc; // GC-Keepalive - Feld, nie lokale Variable!
    private readonly AutoResetEvent _pumpReady = new(false);

    private Thread? _pumpThread;
    private Thread? _consumerThread;
    private Thread? _pollThread;
    private IntPtr _hook = IntPtr.Zero;
    private uint _pumpThreadId;

    private IntPtr _lastSeenHwnd;
    private uint _lastSeenPid;

    public sealed record ForegroundEvent(IntPtr Hwnd, uint ProcessId, DateTime AtUtc);

    /// <summary>
    /// Foreground-Event (hwnd + pid) - der Consumer loest den Prozessnamen auf
    /// (Process.GetProcessById - nie im Callback).
    /// </summary>
    public event Action<ForegroundEvent>? ForegroundChanged;

    public ForegroundTracker()
    {
        // Delegate einmal erzeugen und als Feld halten: wuerde er garbage-collected,
        // ruft die native Seite in freed memory (AccessViolation).
        _hookProc = OnWinEvent;
    }

    public void Start()
    {
        _pumpThread = new Thread(PumpLoop) { IsBackground = true, Name = "yuvomi-pump" };
        _consumerThread = new Thread(ConsumerLoop) { IsBackground = true, Name = "yuvomi-consumer" };
        _pollThread = new Thread(PollLoop) { IsBackground = true, Name = "yuvomi-poll" };
        _pumpThread.Start();
        _consumerThread.Start();
        _pollThread.Start();
        _pumpReady.WaitOne(TimeSpan.FromSeconds(5));
    }

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private void PumpLoop()
    {
        _pumpThreadId = GetCurrentThreadId();

        // Hook JETZT auf diesem Thread registrieren, damit Events hier ankommen.
        // OUTOFCONTEXT: Rueckruf asynchron auf diesem Thread, blockiert den Sender nicht.
        _hook = NativeMethods.SetWinEventHook(
            NativeMethods.EVENT_SYSTEM_FOREGROUND,
            NativeMethods.EVENT_SYSTEM_FOREGROUND,
            IntPtr.Zero,
            _hookProc,
            0, 0,
            NativeMethods.WINEVENT_OUTOFCONTEXT);

        if (_hook == IntPtr.Zero)
        {
            AgentLog.Warn("SetWinEventHook fehlgeschlagen, nur Polling aktiv (Err " +
                          Marshal.GetLastWin32Error() + ")");
        }
        _pumpReady.Set();

        // Klassische Win32 Message-Loop - die Bedingung fuer OUTOFCONTEXT-Delivery.
        while (true)
        {
            var rc = NativeMethods.GetMessageW(out var msg, IntPtr.Zero, 0, 0);
            if (rc == 0) break; // WM_QUIT
            if (rc == -1)
            {
                AgentLog.Warn("GetMessageW-Fehler, Pump-Thread endet");
                break;
            }
            NativeMethods.TranslateMessage(ref msg);
            NativeMethods.DispatchMessageW(ref msg);
        }
    }

    /// <summary>WinEvent-Callback: NUR enqueue. Kein Blockieren, keine Fenster-/Prozess-APIs.</summary>
    private void OnWinEvent(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
    {
        try
        {
            uint pid = 0;
            if (hwnd != IntPtr.Zero)
            {
                NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
            }
            _events.Add(new ForegroundEvent(hwnd, pid, DateTime.UtcNow));
        }
        catch (Exception ex)
        {
            // Add kann bei Shutdown/Capacity fehlschlagen - niemals im Callback werfen.
            AgentLog.Warn("Foreground-Event enqueue: " + ex.Message);
        }
    }

    /// <summary>Consumer: reicht Events an den Aggregator weiter (Process-Aufloesung dort).</summary>
    private void ConsumerLoop()
    {
        try
        {
            foreach (var ev in _events.GetConsumingEnumerable(_cts.Token))
            {
                try { ForegroundChanged?.Invoke(ev); }
                catch (Exception ex) { AgentLog.Warn("Foreground-Consumer: " + ex.Message); }
            }
        }
        catch (OperationCanceledException)
        {
            // normaler Shutdown
        }
    }

    /// <summary>
    /// 1s-Poll-Fallback (GetForegroundWindow + GetWindowThreadProcessId): faengt verlorene
    /// Events. Enqueue NUR bei echter Aenderung (verhindert Doppelzaehlung neben dem Hook).
    /// </summary>
    private void PollLoop()
    {
        while (!_cts.IsCancellationRequested)
        {
            try
            {
                var hwnd = NativeMethods.GetForegroundWindow();
                uint pid = 0;
                if (hwnd != IntPtr.Zero)
                {
                    NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
                }

                if (hwnd != _lastSeenHwnd || pid != _lastSeenPid)
                {
                    _lastSeenHwnd = hwnd;
                    _lastSeenPid = pid;
                    _events.Add(new ForegroundEvent(hwnd, pid, DateTime.UtcNow));
                }
            }
            catch (Exception ex)
            {
                AgentLog.Warn("Poll-Fallback: " + ex.Message);
            }

            try { Task.Delay(1000, _cts.Token).Wait(_cts.Token); }
            catch (OperationCanceledException) { break; }
        }
    }

    public void Dispose()
    {
        _cts.Cancel();
        if (_hook != IntPtr.Zero)
        {
            NativeMethods.UnhookWinEvent(_hook);
            _hook = IntPtr.Zero;
        }
        // Pump-Thread beenden: WM_QUIT an die Message-Queue.
        try
        {
            if (_pumpThreadId != 0)
                NativeMethods.PostThreadMessageW(_pumpThreadId, NativeMethods.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        }
        catch { /* Best Effort */ }
        try { _events.CompleteAdding(); } catch { /* Best Effort */ }
    }
}
