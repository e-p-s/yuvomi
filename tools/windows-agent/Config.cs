using System.Text.Json.Serialization;

namespace YuvomiAgent;

/// <summary>
/// Agent-Konfiguration. Laedt aus config.json in %LOCALAPPDATA%\YuvomiAgent\config.json,
/// mit Fallback auf das mitgelieferte appsettings.json neben der EXE.
/// deviceToken wird NIEMALS geloggt.
/// </summary>
public sealed class AgentConfig
{
    public string BaseUrl { get; set; } = "http://localhost:8000";
    public string DeviceToken { get; set; } = "";
    public int IdleThresholdSec { get; set; } = 60;
    public int HeartbeatSec { get; set; } = 60;
    public int SyncIntervalSec { get; set; } = 120;
    /// <summary>Luecken <= N Sekunden zwischen Foreground-Intervallen werden mergiert.</summary>
    public int MergeGapSec { get; set; } = 3;

    [JsonExtensionData]
    public IDictionary<string, object?>? Extra { get; set; }

    public static AgentConfig Load()
    {
        var cfg = new AgentConfig();

        var appSettings = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
        var local = Path.Combine(AgentPaths.Root, "config.json");

        foreach (var path in new[] { appSettings, local })
        {
            try
            {
                if (File.Exists(path))
                {
                    var json = File.ReadAllText(path);
                    var loaded = System.Text.Json.JsonSerializer.Deserialize<AgentConfig>(json);
                    if (loaded is not null)
                    {
                        if (!string.IsNullOrWhiteSpace(loaded.BaseUrl)) cfg.BaseUrl = loaded.BaseUrl;
                        if (!string.IsNullOrWhiteSpace(loaded.DeviceToken)) cfg.DeviceToken = loaded.DeviceToken;
                        if (loaded.IdleThresholdSec > 0) cfg.IdleThresholdSec = loaded.IdleThresholdSec;
                        if (loaded.HeartbeatSec > 0) cfg.HeartbeatSec = loaded.HeartbeatSec;
                        if (loaded.SyncIntervalSec > 0) cfg.SyncIntervalSec = loaded.SyncIntervalSec;
                        if (loaded.MergeGapSec >= 0) cfg.MergeGapSec = loaded.MergeGapSec;
                    }
                }
            }
            catch (Exception ex)
            {
                AgentLog.Warn("Konfiguration aus " + path + " nicht lesbar: " + ex.Message);
            }
        }

        cfg.BaseUrl = cfg.BaseUrl.TrimEnd('/');
        return cfg;
    }

    /// <summary>Schreibt baseUrl + deviceToken in die lokale config.json (Pairing-Ergebnis).</summary>
    public void PersistLocal()
    {
        AgentPaths.EnsureRoot();
        var local = Path.Combine(AgentPaths.Root, "config.json");
        var json = System.Text.Json.JsonSerializer.Serialize(this, new System.Text.Json.JsonSerializerOptions
        {
            WriteIndented = true,
        });
        File.WriteAllText(local, json);
    }
}

/// <summary>
/// Pfad-Helfer: alles unter %LOCALAPPDATA%\YuvomiAgent (device.json, outbox.jsonl, logs).
/// </summary>
public static class AgentPaths
{
    public static string Root =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YuvomiAgent");

    public static string DeviceFile => Path.Combine(Root, "device.json");
    public static string OutboxFile => Path.Combine(Root, "outbox.jsonl");
    public static string LogFile => Path.Combine(Root, "agent.log");

    public static void EnsureRoot() => Directory.CreateDirectory(Root);
}

/// <summary>Duerftiges Datei-Logging. Token-Werte werden nie geschrieben.</summary>
public static class AgentLog
{
    private static readonly object Gate = new();

    public static void Info(string msg) => Write("INFO", msg);
    public static void Warn(string msg) => Write("WARN", msg);
    public static void Error(string msg) => Write("ERROR", msg);

    private static void Write(string level, string msg)
    {
        try
        {
            AgentPaths.EnsureRoot();
            var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + level + " " + msg;
            lock (Gate)
            {
                File.AppendAllText(AgentPaths.LogFile, line + Environment.NewLine);
            }
        }
        catch
        {
            // Logging darf den Agenten nie zu Fall bringen.
        }
    }
}
