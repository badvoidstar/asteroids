namespace AsteroidsWeb.Configuration;

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
}
