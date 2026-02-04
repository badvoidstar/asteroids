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
    /// <returns>Result indicating success/failure with session and member if successful.</returns>
    CreateSessionResult CreateSession(string creatorConnectionId);

    /// <summary>
    /// Joins an existing session as a client.
    /// </summary>
    /// <param name="sessionId">The session to join.</param>
    /// <param name="connectionId">SignalR connection ID of the joining member.</param>
    /// <returns>Result indicating success/failure with session and member if successful.</returns>
    JoinSessionResult JoinSession(Guid sessionId, string connectionId);

    /// <summary>
    /// Removes a member from their session.
    /// Triggers server promotion if the leaving member was the server.
    /// </summary>
    /// <param name="connectionId">SignalR connection ID of the leaving member.</param>
    /// <returns>Result containing session info and promotion details if applicable.</returns>
    LeaveSessionResult? LeaveSession(string connectionId);

    /// <summary>
    /// Gets all active sessions that can be joined, along with capacity info.
    /// </summary>
    ActiveSessionsResult GetActiveSessions();

    /// <summary>
    /// Gets the maximum number of concurrent sessions allowed.
    /// </summary>
    int MaxSessions { get; }

    /// <summary>
    /// Gets the maximum number of members per session.
    /// </summary>
    int MaxMembersPerSession { get; }

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
    int MaxMembers,
    DateTime CreatedAt
);

/// <summary>
/// Result of listing active sessions, includes capacity info.
/// </summary>
public record ActiveSessionsResult(
    IEnumerable<SessionInfo> Sessions,
    int MaxSessions,
    bool CanCreateSession
);

/// <summary>
/// Result of attempting to create a session.
/// </summary>
public record CreateSessionResult(
    bool Success,
    Session? Session,
    Member? Creator,
    string? ErrorMessage
);

/// <summary>
/// Result of attempting to join a session.
/// </summary>
public record JoinSessionResult(
    bool Success,
    Session? Session,
    Member? Member,
    string? ErrorMessage
);
