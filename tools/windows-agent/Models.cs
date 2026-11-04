namespace YuvomiAgent;

/// <summary>
/// Ein Foreground-/Idle-Intervall, bereit zum Hochladen als Session.
/// Zeiten sind UTC; die Server-Endpunkte erwarten ISO-8601.
/// </summary>
public sealed class UsageSegment
{
    public required string Package { get; init; }
    public required DateTime StartedAt { get; init; }
    /// <summary>null = laeuft noch (wird vor dem Versand geschlossen).</summary>
    public DateTime? EndedAt { get; set; }
    public long ForegroundMs { get; set; }
    public long ScreenOnMs { get; set; }
    /// <summary>"app" fuer Foreground-Zeit eines Prozesses.</summary>
    public string Kind { get; init; } = "app";

    public DateTime EffectiveEnd => EndedAt ?? DateTime.UtcNow;
    public long DurationMs => Math.Max(0, (long)(EffectiveEnd - StartedAt).TotalMilliseconds);
}
