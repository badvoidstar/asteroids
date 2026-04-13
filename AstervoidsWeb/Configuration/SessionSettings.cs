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
    /// How long (in seconds) a session can remain empty (no connected members) before being destroyed.
    /// Default is 30 seconds.
    /// </summary>
    public int EmptyTimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// Maximum lifetime (in minutes) for any session, regardless of member activity.
    /// Default is 20 minutes.
    /// </summary>
    public int AbsoluteTimeoutMinutes { get; set; } = 20;

    /// <summary>
    /// SignalR client timeout interval in seconds. If the server doesn't receive a message
    /// (including keep-alive) within this interval, it considers the client disconnected.
    /// Default is 20 seconds.
    /// </summary>
    public int ClientTimeoutSeconds { get; set; } = 20;

    /// <summary>
    /// SignalR keep-alive ping interval in seconds. The server sends a ping to the client
    /// at this interval to keep the connection alive. Should be roughly half of
    /// <see cref="ClientTimeoutSeconds"/> so a single missed ping doesn't kill the connection.
    /// Default is 10 seconds.
    /// </summary>
    public int KeepAliveSeconds { get; set; } = 10;
}
