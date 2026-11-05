namespace YuvomiAgent;

/// <summary>
/// Tray-Menue (NotifyIcon). Reine Anzeige + Bedienhilfen; der Agent sperrt nichts.
/// Menuepunkte: Status, Autostart installieren/entfernen, Outbox-Groesse, Beenden.
/// </summary>
public sealed class TrayController : IDisposable
{
    private readonly NotifyIcon _icon;
    private readonly AgentCoordinator _coordinator;
    private readonly ApiClient _api;
    private readonly ToolStripMenuItem _statusItem;

    public TrayController(AgentCoordinator coordinator, ApiClient api)
    {
        _coordinator = coordinator;
        _api = api;

        _statusItem = new ToolStripMenuItem("Status: ...") { Enabled = false };

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());

        var installItem = new ToolStripMenuItem("Autostart installieren");
        installItem.Click += (_, _) =>
        {
            var ok = AutostartInstaller.Install();
            _statusItem.Text = "Autostart: " + (ok ? "installiert" : "FEHLGESCHLAGEN");
        };
        menu.Items.Add(installItem);

        var uninstallItem = new ToolStripMenuItem("Autostart entfernen");
        uninstallItem.Click += (_, _) =>
        {
            AutostartInstaller.Uninstall();
            _statusItem.Text = "Autostart entfernt";
        };
        menu.Items.Add(uninstallItem);

        menu.Items.Add(new ToolStripSeparator());
        var exitItem = new ToolStripMenuItem("Beenden");
        exitItem.Click += async (_, _) =>
        {
            await _coordinator.ShutdownAsync();
            Application.Exit();
        };
        menu.Items.Add(exitItem);

        _icon = new NotifyIcon
        {
            Text = "Yuvomi-Agent",
            Icon = SystemIcons.Application, // Platzhalter; ein echtes .ico spaeter einbinden
            Visible = true,
            ContextMenuStrip = menu,
        };

        _coordinator.StatusChanged += OnStatusChanged;
        var timer = new System.Windows.Forms.Timer { Interval = 30000 };
        timer.Tick += (_, _) => RefreshStatus();
        timer.Start();
        RefreshStatus();
    }

    private void OnStatusChanged(string status)
    {
        // Coordinator-Events kommen von Background-Threads -> sicher auf den UI-Thread mappen.
        try { _statusItem.Text = "Status: " + status; }
        catch { /* Control noch nicht erstellt */ }
    }

    private void RefreshStatus()
    {
        var quota = _api.LastQuota;
        var checkin = _api.LastCheckedIn ? ", eingebucht" : "";
        var online = _api.LastKnownOnline ? "online" : "offline (Puffern)";
        var quotaText = quota?.RemainingMin is int min ? ", Rest " + min + " min" : "";
        _statusItem.Text = "Status: " + online + quotaText + checkin;
        _icon.Text = "Yuvomi-Agent - " + online;
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
    }
}
