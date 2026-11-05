using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace YuvomiAgent;

/// <summary>Antwort-Quota aus sync/heartbeat: Der Server sagt nur erlaubt/gesperrt - der
/// Agent sperrt nichts hart (Treuhaender-Modell).</summary>
public sealed class QuotaInfo
{
    [JsonPropertyName("remaining_min")]
    public int? RemainingMin { get; set; }

    [JsonPropertyName("state")]
    public string? State { get; set; }

    /// <summary>'count' = reine Meldespur (alter Zustand). 'lock' = der Haushalt
    /// will Sperre: bei state exceeded oder quiet darf der Agent melden und
    /// (PC) abmelden. Entscheidung des Nutzers: "sind die 30min weg soll es
    /// nicht weiter gehen duerfen, beim PC koennte man ein logout initieren".</summary>
    [JsonPropertyName("enforcement")]
    public string? Enforcement { get; set; }

    /// <summary>Sperre gewollt? Nur 'lock' + exceeded/quiet, sonst nie.</summary>
    public bool ShouldLock =>
        Enforcement == "lock" && (State == "exceeded" || State == "quiet");
}

public sealed class TrackerResponse
{
    [JsonPropertyName("quota")]
    public QuotaInfo? Quota { get; set; }

    [JsonPropertyName("ok")]
    public bool Ok { get; set; } = true;
}

/// <summary>
/// HTTP-Client fuer die bestehenden /api/v1/media-time/tracker-Endpunkte.
///
/// Grundregel "keine Antwort = erlaubt": Jeder Fehler (Timeout, 5xx, DNS) fuehrt NUR dazu,
/// dass der Datensatz in den Offline-Puffer (outbox.jsonl) geschrieben wird. Der Agent
/// sperrt oder bestraft lokal NIEMALS - auch nicht bei state="gesperrt" (das ist Sache der
/// Apps/Eltern, der Agent ist reiner Melder).
///
/// Retry: Backoff 5s -> 10s -> ... -> 5min (Verdopplung, gedeckelt). Puffer ist JSONL,
/// jede Zeile ein abgeschlossener Upload-Enqueue-Eintrag.
/// </summary>
public sealed class ApiClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly AgentConfig _cfg;
    private readonly DeviceIdentity _device;
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private DateTime _nextRetryUtc = DateTime.UtcNow;
    private double _backoffSec = 5;
    private const double MaxBackoffSec = 300;

    /// <summary>Letzte vom Server gemeldete Quota (fuer Tray-Tooltip, rein informativ).</summary>
    public QuotaInfo? LastQuota { get; private set; }

    public ApiClient(AgentConfig cfg, DeviceIdentity device)
    {
        _cfg = cfg;
        _device = device;
        _http = new HttpClient(new HttpClientHandler
        {
            // Server-Zertifikate normal pruefen (kein Trust-All-Kindertrick).
            UseCookies = false,
        })
        {
            BaseAddress = new Uri(cfg.BaseUrl + "/"),
            Timeout = TimeSpan.FromSeconds(15),
        };
    }

    /// <summary>Ehrlicher State fuer die UI: zuletzt erfolgreich erreichbar?</summary>
    public bool LastKnownOnline { get; private set; }

    /// <summary>
    /// POST /api/v1/media-time/tracker/sync. Bei Fehlern: Segmente zurueck in den Puffer.
    /// Gibt true zurueck, wenn der Server die Daten bestaetigt hat.
    /// </summary>
    public async Task<bool> SyncAsync(IReadOnlyList<SyncSession> sessions, CancellationToken ct)
    {
        if (sessions.Count == 0) return true;
        var payload = new { sessions = sessions };
        return await PostWithBufferAsync("api/v1/media-time/tracker/sync", payload,
            bufferFallback: () => BufferSessions(sessions), ct).ConfigureAwait(false);
    }

    /// <summary>POST /api/v1/media-time/tracker/heartbeat - Antwort enthaelt quota.</summary>
    public async Task<bool> HeartbeatAsync(string sessionKey, CancellationToken ct)
    {
        var payload = new
        {
            session_key = sessionKey,
            device_time = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
        };
        return await PostWithBufferAsync("api/v1/media-time/tracker/heartbeat", payload,
            bufferFallback: () => BufferRaw("heartbeat", payload), ct).ConfigureAwait(false);
    }

    private async Task<bool> PostWithBufferAsync(string path, object payload, Action bufferFallback, CancellationToken ct)
    {
        if (DateTime.UtcNow < _nextRetryUtc)
        {
            // Im Backoff-Fenster: gar nicht erst haemmern, direkt puffern.
            // Gilt fuer sync UND heartbeat - sonst wuerde der Heartbeat das Backoff-Fenster umgehen.
            bufferFallback();
            return false;
        }

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, path);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _device.DeviceToken);
            req.Headers.UserAgent.ParseAdd("YuvomiAgent/0.1 (win)");
            req.Content = new StringContent(JsonSerializer.Serialize(payload, JsonOpts), Encoding.UTF8, "application/json");

            using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            if (resp.IsSuccessStatusCode)
            {
                var body = await SafeReadAsync(resp, ct).ConfigureAwait(false);
                TryParseQuota(body);
                LastKnownOnline = true;
                ResetBackoff();
                return true;
            }

            AgentLog.Warn(path + " -> HTTP " + (int)resp.StatusCode);
            MarkOffline();
            bufferFallback();
            BumpBackoff();
            return false;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Shutdown: Daten nicht verlieren.
            bufferFallback();
            throw;
        }
        catch (Exception ex)
        {
            // "keine Antwort = erlaubt": nur puffern, nie sperren.
            AgentLog.Warn(path + " nicht erreichbar (" + ex.GetType().Name + "): gepuffert");
            MarkOffline();
            bufferFallback();
            BumpBackoff();
            return false;
        }
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        try { return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false); }
        catch { return ""; }
    }

    private void TryParseQuota(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return;
        try
        {
            var parsed = JsonSerializer.Deserialize<TrackerResponse>(body, JsonOpts);
            if (parsed?.Quota is not null) LastQuota = parsed.Quota;
        }
        catch
        {
            // Antwortformat darf den Agenten nie stoppen.
        }
    }

    private void MarkOffline() => LastKnownOnline = false;

    private void ResetBackoff()
    {
        _backoffSec = 5;
        _nextRetryUtc = DateTime.UtcNow;
    }

    private void BumpBackoff()
    {
        _backoffSec = Math.Min(_backoffSec * 2, MaxBackoffSec);
        _nextRetryUtc = DateTime.UtcNow.AddSeconds(_backoffSec);
    }

    // ------------------------------------------------------------ Offline-Puffer

    private sealed record OutboxEntry(string Type, string Json, DateTime QueuedAtUtc);

    private void BufferSessions(IReadOnlyList<SyncSession> sessions)
    {
        AppendToOutbox("sync", JsonSerializer.Serialize(new { sessions }, JsonOpts));
    }

    private void BufferRaw(string type, object payload)
    {
        AppendToOutbox(type, JsonSerializer.Serialize(payload, JsonOpts));
    }

    private void AppendToOutbox(string type, string json)
    {
        try
        {
            AgentPaths.EnsureRoot();
            var entry = new OutboxEntry(type, json, DateTime.UtcNow);
            lock (_http) // einfaches Gate fuer JSONL-Anhang
            {
                File.AppendAllText(AgentPaths.OutboxFile,
                    JsonSerializer.Serialize(entry, JsonOpts) + Environment.NewLine);
            }
        }
        catch (Exception ex)
        {
            AgentLog.Error("Outbox-Schreiben fehlgeschlagen: " + ex.Message);
        }
    }

    /// <summary>
    /// Puffer abarbeiten (der Coordinator ruft das nach erfolgreichem Connectivity-Check).
    /// Eintrag-fuer-Eintrag: erster Fehler => Rest bleibt stehen (Reihenfolge = Integritaet).
    /// </summary>
    public async Task<int> FlushOutboxAsync(CancellationToken ct)
    {
        if (!File.Exists(AgentPaths.OutboxFile)) return 0;

        string[] lines;
        try { lines = File.ReadAllLines(AgentPaths.OutboxFile); }
        catch { return 0; }
        if (lines.Length == 0) return 0;

        int sent = 0;
        var remaining = new List<string>();
        foreach (var line in lines)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            OutboxEntry? entry;
            try { entry = JsonSerializer.Deserialize<OutboxEntry>(line, JsonOpts); }
            catch { continue; } // kaputte Zeile verwerfen
            if (entry is null) continue;

            if (DateTime.UtcNow < _nextRetryUtc)
            {
                remaining.Add(line);
                continue;
            }

            bool ok = entry.Type == "heartbeat"
                ? await PostRawAsync("api/v1/media-time/tracker/heartbeat", entry.Json, ct).ConfigureAwait(false)
                : await PostRawAsync("api/v1/media-time/tracker/sync", entry.Json, ct).ConfigureAwait(false);

            if (ok) { sent++; ResetBackoff(); }
            else { remaining.Add(line); BumpBackoff(); }
        }

        try
        {
            if (remaining.Count == 0) File.Delete(AgentPaths.OutboxFile);
            else File.WriteAllLines(AgentPaths.OutboxFile, remaining);
        }
        catch (Exception ex)
        {
            AgentLog.Error("Outbox-Umschreiben fehlgeschlagen: " + ex.Message);
        }
        return sent;
    }

    private async Task<bool> PostRawAsync(string path, string rawJson, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, path);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _device.DeviceToken);
            req.Content = new StringContent(rawJson, Encoding.UTF8, "application/json");
            using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            if (resp.IsSuccessStatusCode)
            {
                TryParseQuota(await SafeReadAsync(resp, ct).ConfigureAwait(false));
                LastKnownOnline = true;
                return true;
            }
            MarkOffline();
            return false;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            MarkOffline();
            return false;
        }
    }

    public void Dispose() => _http.Dispose();
}
