namespace YuvomiAgent;

/// <summary>
/// Verstecktes NativeWindow (Handle via AllocateHandle auf dem Main-Thread, unsichtbar),
/// mit dem sich WTSRegisterSessionNotification anmelden laesst. Ueber WndProc kommen
/// WM_WTSSESSION_CHANGE (Lock/Unlock/Logon/Logoff) als scharfe Session-Grenzen.
///
/// Ein eigens dafuer angelegtes Fenster ist noetig, weil WTS-Notifications an ein HWND
/// gebunden sind; ein unsichtbares Fenster kostet keine UI und verschwindet nie im
/// Alt-Tab (WS_EX_TOOLWINDOW + nie Show()).
/// </summary>
public sealed class MessageWindow : NativeWindow, IDisposable
{
    private readonly Action<int> _onSessionChange;
    private bool _registered;

    public MessageWindow(Action<int> onWtsSessionChange)
    {
        _onSessionChange = onWtsSessionChange;
        var cp = new CreateParams
        {
            Caption = "YuvomiAgentMessageWindow",
            // nie sichtbar, nie in Taskbar/Alt-Tab
            Style = 0,
            ExStyle = 0x80, // WS_EX_TOOLWINDOW
        };
        CreateHandle(cp);
    }

    public void RegisterSessionNotifications()
    {
        if (_registered) return;
        _registered = NativeMethods.WTSRegisterSessionNotification(Handle, NativeMethods.NOTIFY_FOR_THIS_SESSION);
        if (!_registered)
        {
            AgentLog.Warn("WTSRegisterSessionNotification fehlgeschlagen - Lock/Unlock-Events fehlen; " +
                          "Idle + PowerModeChanged greifen trotzdem");
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == NativeMethods.WM_WTSSESSION_CHANGE)
        {
            try { _onSessionChange(m.WParam.ToInt32()); }
            catch (Exception ex) { AgentLog.Warn("WTS-Handler: " + ex.Message); }
        }
        base.WndProc(ref m);
    }

    public new void Dispose()
    {
        try
        {
            if (_registered)
            {
                NativeMethods.WTSUnRegisterSessionNotification(Handle);
                _registered = false;
            }
        }
        catch { /* best effort */ }
        try { DestroyHandle(); } catch { /* best effort */ }
    }
}
