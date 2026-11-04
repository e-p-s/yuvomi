using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace YuvomiAgent;

/// <summary>
/// Geraete-GUID + Device-Token, persistent in %LOCALAPPDATA%\YuvomiAgent\device.json.
/// Der Token wird nach Moeglichkeit mit DPAPI (ProtectedData, CurrentUser) verschluesselt.
///
/// DOKUMENTIERTE GRENZE: Ein Geraet in Kinderhand ist ein Angreifer-Host - DPAPI schuetzt
/// nur gegen Auslesen von einem ANDEREN Benutzer-/Geraetekonto. Wer als das Kind angemeldet
/// ist, kann den dpapi-geschuetzten Token gleichwohl lesen. Deshalb muss der serverseitige
/// deviceToken kurzlebig sein (siehe docs/medienzeit-windows-agent.md, Anti-Cheat-Tabelle).
/// DPAPI ist depth-in-defense, kein Sicherheitsversprechen.
/// </summary>
public sealed class DeviceIdentity
{
    public required Guid DeviceGuid { get; init; }
    public required string DeviceToken { get; init; }
    public string? Source { get; init; }

    internal const string EncPrefix = "dpapi:";

    public static DeviceIdentity Load(AgentConfig cfg)
    {
        AgentPaths.EnsureRoot();
        var path = AgentPaths.DeviceFile;

        if (File.Exists(path))
        {
            try
            {
                var raw = File.ReadAllText(path);
                var stored = JsonSerializer.Deserialize<StoredDevice>(raw);
                if (stored is not null)
                {
                    return new DeviceIdentity
                    {
                        DeviceGuid = stored.DeviceGuid,
                        DeviceToken = ProtectHelper.Unprotect(stored.DeviceToken),
                        Source = "device.json",
                    };
                }
            }
            catch (Exception ex)
            {
                AgentLog.Warn("device.json unlesbar, neuer Anlauf: " + ex.Message);
            }
        }

        // Erststart: GUID erzeugen, Token aus config uebernehmen (Pairing muss stattgefunden haben).
        var guid = Guid.NewGuid();
        var token = string.IsNullOrWhiteSpace(cfg.DeviceToken) ? "" : cfg.DeviceToken;
        var identity = new DeviceIdentity { DeviceGuid = guid, DeviceToken = token, Source = "config" };
        identity.Persist();
        if (string.IsNullOrEmpty(token))
        {
            AgentLog.Warn("Kein deviceToken konfiguriert - Sync/Heartbeat werden abgelehnt (Server 401). " +
                          "Bitte via Pairing konfigurieren (README).");
        }
        return identity;
    }

    public void Persist()
    {
        AgentPaths.EnsureRoot();
        var stored = new StoredDevice
        {
            DeviceGuid = DeviceGuid,
            DeviceToken = ProtectHelper.Protect(DeviceToken),
        };
        File.WriteAllText(AgentPaths.DeviceFile,
            JsonSerializer.Serialize(stored, new JsonSerializerOptions { WriteIndented = true }));
    }

    /// <summary>session_key = SHA256(deviceGuid | package | started_at UTC ISO), Idempotenz.</summary>
    public string SessionKeyFor(string package, DateTime startedAtUtc)
    {
        var canonical = startedAtUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
        var input = DeviceGuid.ToString("N") + "|" + package + "|" + canonical;
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(input));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private sealed class StoredDevice
    {
        public Guid DeviceGuid { get; set; }
        public string DeviceToken { get; set; } = "";
    }
}

/// <summary>DPAPI-Wrapper (CurrentUser-Scope); Exception => Klartext mit Warnung (Doku oben).</summary>
internal static class ProtectHelper
{
    public static string Protect(string plain)
    {
        if (string.IsNullOrEmpty(plain)) return plain;
        try
        {
            var bytes = ProtectedData.Protect(
                Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
            return DeviceIdentity.EncPrefix + Convert.ToBase64String(bytes);
        }
        catch (Exception ex)
        {
            AgentLog.Warn("DPAPI nicht verfuegbar, Token als Klartext gespeichert: " + ex.Message);
            return plain;
        }
    }

    public static string Unprotect(string stored)
    {
        if (string.IsNullOrEmpty(stored)) return stored;
        if (!stored.StartsWith(DeviceIdentity.EncPrefix, StringComparison.Ordinal))
        {
            // Klartext aus einem frueheren Lauf oder nicht-DPAPI-Pfad.
            return stored;
        }
        try
        {
            var b64 = stored.Substring(DeviceIdentity.EncPrefix.Length);
            var bytes = ProtectedData.Unprotect(
                Convert.FromBase64String(b64), null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
        }
        catch (Exception ex)
        {
            AgentLog.Warn("DPAPI-Entschluesselung fehlgeschlagen: " + ex.Message);
            return "";
        }
    }
}
