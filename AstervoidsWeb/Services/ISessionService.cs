using AstervoidsWeb.Models;

namespace AstervoidsWeb.Services;

/// <summary>
/// Service for managing game sessions.
/// </summary>
public interface ISessionService
{
    /// <summary>
    /// Creates a new session with a randomly generated fruit name.
    /// </summary>
    /// <param name="creatorConnectionId">SignalR connection ID of the creator.</param>
    /// <returns>The created session and the creator's member record.</returns>
    (Session Session, Member Creator) CreateSession(string creatorConnectionId);

    /// <summary>
    /// Joins an existing session as a client.
    /// </summary>
    /// <param name="sessionId">The session to join.</param>
    /// <param name="connectionId">SignalR connection ID of the joining member.</param>
    /// <returns>The session and member record, or null if session not found.</returns>
    (Session Session, Member Member)? JoinSession(Guid sessionId, string connectionId);

    /// <summary>
    /// Removes a member from their session.
    /// Triggers server promotion if the leaving member was the server.
    /// </summary>
    /// <param name="connectionId">SignalR connection ID of the leaving member.</param>
    /// <returns>Result containing session info and promotion details if applicable.</returns>
    LeaveSessionResult? LeaveSession(string connectionId);

    /// <summary>
    /// Gets all active sessions that can be joined.
    /// </summary>
    IEnumerable<SessionInfo> GetActiveSessions();

    /// <summary>
    /// Gets a session by ID.
    /// </summary>
    Session? GetSession(Guid sessionId);

    /// <summary>
    /// Gets a member by their connection ID.
    /// </summary>
    Member? GetMemberByConnectionId(string connectionId);

    /// <summary>
    /// Gets the session a connection belongs to.
    /// </summary>
    Session? GetSessionByConnectionId(string connectionId);
}

/// <summary>
/// Result of a member leaving a session.
/// </summary>
public record LeaveSessionResult(
    Guid SessionId,
    string SessionName,
    Guid MemberId,
    bool SessionDestroyed,
    Member? PromotedMember,
    IEnumerable<Guid> AffectedObjectIds
);

/// <summary>
/// Lightweight session info for listing.
/// </summary>
public record SessionInfo(
    Guid Id,
    string Name,
    int MemberCount,
    DateTime CreatedAt
);
