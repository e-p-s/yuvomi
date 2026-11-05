using System.Runtime.InteropServices;
using System.Diagnostics;

namespace YuvomiAgent;

/// <summary>
/// Sperr-Entscheider des Agenten. Grundregel bleibt: keine Server-Antwort = keine
/// Sperre (Netzwerkprobleme bestrafen kein Kind). Sperre gibt es nur, wenn der
/// Server antwortet und 'lock' + state exceeded/quiet sagt (ApiClient.LastQuota).
///
/// Ablauf bei Sperre:
///   1. sofort: Vollbild-Hinweis "Zeit ist um" (Kind sieht die Nachricht,
///      wie der User es verlangt hat).
///   2. nach SperrFristSec (Default 30s): Logout des Benutzers
///      (user32 ExitWindowsEx mit EWX_LOGOFF; ohne Admin - ein normaler
///      Kind-Account darf sich selbst abmelden).
///   3. Der Hinweis bleibt bis Logout oder bis der Server "erlaubt" sagt
///      (Kontingent wurde von den Eltern erhoeht oder aufgebraucht war ein
///      Irrtum). Der Agent wartet auf keine Bestaetigung des Kindes ab.
///
/// Sicherheit: kein Sperrebefehl ohne Serverbestaetigung; Shutdown/Restart
/// niemals, nur Logoff; Prozess-Titel des Fensters ist sichtbar ehrlich.
/// </summary>
public sealed class EnforcementController : IDisposable
{
    private readonly ApiClient _api;
    private readonly AgentConfig _cfg;
    private readonly object _gate = new();
    private System.Threading.Timer? _watchdog;
    private MessageOverlay? _overlay;
    private bool _locked;
    private DateTime _lockSinceUtc;

    public EnforcementController(ApiClient api, AgentConfig cfg)
    {
        _api = api;
        _cfg = cfg;
    }

    /// <summary>Vom Coordinator nach jedem sync/heartbeat aufgerufen (die
    /// Antwort traegt quota.enforcement + state).</summary>
    public void Evaluate()
    {
        var q = _api.LastQuota;
        var shouldLock = q?.ShouldLock ?? false;
        lock (_gate)
        {
            if (shouldLock && !_locked) StartLock();
            else if (!shouldLock && _locked) ReleaseLock();
        }
    }

    private void StartLock()
    {
        _locked = true;
        _lockSinceUtc = DateTime.UtcNow;
        AgentLog.Info("Enforcement: Sperre aktiv (Server sagt " + _api.LastQuota?.State + ").");
        try
        {
            _overlay = new MessageOverlay(
                "Zeit ist um",
                "Dein Tageskontingent ist aufgebraucht. Der PC meldet sich gleich ab. " +
                "Wenn Du denkst, das stimmt nicht: frag Deine Eltern.");
            _overlay.Show();
        }
        catch (Exception ex) { AgentLog.Warn("Overlay: " + ex.Message); }
        var due = TimeSpan.FromSeconds(Math.Clamp(_cfg.SperrFristSec, 5, 600));
        _watchdog = new System.Threading.Timer(_ => Logoff(), null, due, Timeout.InfiniteTimeSpan);
    }

    private void ReleaseLock()
    {
        _locked = false;
        AgentLog.Info("Enforcement: Sperre aufgehoben (Server sagt erlaubt).");
        _watchdog?.Dispose();
        _watchdog = null;
        try { _overlay?.Close(); } catch { /* Fenster ist evtl. schon weg */ }
        _overlay = null;
    }

    private void Logoff()
    {
        try
        {
            // EWX_LOGOFF (0) ohne FORCE: laufende Programme fahren sauber herunter.
            // Ein Kind-Prozess darf seinen eigenen Session-Logoff anstossen;
            // Fehlgeschlagener Logoff (fehlende Rechte) bleibt folgenlos - der
            // Hinweis steht trotzdem, die Eltern sehen den Tracker-Stand.
            NativeMethods.ExitWindowsEx(NativeMethods.EWX_LOGOFF, 0);
        }
        catch (Exception ex) { AgentLog.Warn("Logoff: " + ex.Message); }
    }

    public void Dispose()
    {
        _watchdog?.Dispose();
        try { _overlay?.Close(); } catch { /* egal */ }
    }
}

/// <summary>Vollbild-Hinweis ohne Rand, Topmost, dunkel. Kein Eingabefenster,
/// damit das Kind lesen kann; der Logoff kommt vom Timer, nicht vom Klick.</summary>
internal sealed class MessageOverlay
{
    private readonly System.Windows.Window _window;

    public MessageOverlay(string title, string body)
    {
        _window = new System.Windows.Window
        {
            Title = "Yuvomi Medienzeit",
            WindowStyle = System.Windows.WindowStyle.None,
            ResizeMode = System.Windows.ResizeMode.NoResize,
            WindowState = System.Windows.WindowState.Maximized,
            Topmost = true,
            ShowInTaskbar = true,
            Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(24, 26, 32)),
            Content = BuildContent(title, body),
        };
    }

    private static System.Windows.FrameworkElement BuildContent(string title, string body)
    {
        var panel = new System.Windows.Controls.StackPanel
        {
            VerticalAlignment = System.Windows.VerticalAlignment.Center,
            HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            Margin = new System.Windows.Thickness(48),
        };
        panel.Children.Add(new System.Windows.Controls.TextBlock
        {
            Text = title,
            FontSize = 42,
            FontWeight = System.Windows.FontWeights.Bold,
            Foreground = System.Windows.Brushes.White,
            HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            TextAlignment = System.Windows.TextAlignment.Center,
        });
        panel.Children.Add(new System.Windows.Controls.TextBlock
        {
            Text = body,
            FontSize = 20,
            Margin = new System.Windows.Thickness(0, 16, 0, 0),
            Foreground = System.Windows.Brushes.WhiteSmoke,
            TextWrapping = System.Windows.TextWrapping.Wrap,
            TextAlignment = System.Windows.TextAlignment.Center,
        });
        return panel;
    }

    public void Show()
    {
        // WPF braucht einen UI-Thread; der Agent laeuft ohne Fenster, also hier
        // ein eigener STA-Thread (wie TrayController ihn fuer NotifyIcon nutzt).
        var t = new System.Threading.Thread(() =>
        {
            var app = new System.Windows.Application();
            app.Run(_window);
        });
        t.SetApartmentState(System.Threading.ApartmentState.STA);
        t.IsBackground = true;
        t.Start();
    }

    public void Close()
    {
        try { _window.Dispatcher.Invoke(() => _window.Close()); } catch { /* egal */ }
    }
}
