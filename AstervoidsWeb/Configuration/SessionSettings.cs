namespace AstervoidsWeb.Configuration;

/// <summary>
/// Configuration settings for session management.
/// </summary>
public class SessionSettings
{
    public const string SectionName = "Session";
    
    /// <summary>
    /// Maximum number of concurrent sessions allowed. Default is 6.
    /// </summary>
    public int MaxSessions { get; set; } = 6;

    /// <summary>
    /// Maximum number of members per session. Default is 4.
    /// </summary>
    public int MaxMembersPerSession { get; set; } = 4;

    /// <summary>
    /// When true, distributes orphaned Session-scoped objects round-robin across remaining members
    /// on member departure. When false, all objects go to a single member. Default is true.
    /// </summary>
    public bool DistributeOrphanedObjects { get; set; } = true;

    /// <summary>
    /// When true, broadcasts trimmed update DTOs (id, data, version only) instead of full
    /// ObjectInfo. Reduces bandwidth by omitting metadata that doesn't change after creation.
    /// Default is true.
    /// </summary>
    public bool TrimUpdateMetadata { get; set; } = true;
}
