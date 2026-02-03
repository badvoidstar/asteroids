namespace AstervoidsWeb.Models;

/// <summary>
/// Represents a participant in a session.
/// </summary>
public class Member
{
    /// <summary>
    /// Globally unique identifier for this member.
    /// </summary>
    public Guid Id { get; init; } = Guid.NewGuid();

    /// <summary>
    /// SignalR connection ID for this member.
    /// </summary>
    public required string ConnectionId { get; set; }

    /// <summary>
    /// The member's role within the session (Server or Client).
    /// </summary>
    public MemberRole Role { get; set; }

    /// <summary>
    /// Timestamp when the member joined the session.
    /// </summary>
    public DateTime JoinedAt { get; init; } = DateTime.UtcNow;

    /// <summary>
    /// The session this member belongs to.
    /// </summary>
    public Guid SessionId { get; init; }
}
