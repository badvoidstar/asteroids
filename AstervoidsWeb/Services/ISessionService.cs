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
    /// <param name="aspectRatio">The aspect ratio (width/height) to lock for this session.</param>
    /// <returns>Result indicating success/failure with session and member if successful.</returns>
    CreateSessionResult CreateSession(string creatorConnectionId, double aspectRatio);

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

    /// <summary>
    /// Gets both the member and session for a connection in a single lookup.
    /// More efficient than calling GetMemberByConnectionId + GetSession separately.
    /// </summary>
    (Member Member, Session Session)? GetMemberAndSessionByConnectionId(string connectionId);

    /// <summary>
    /// Gets all sessions (including empty ones awaiting cleanup).
    /// Used by the cleanup service to check for expired sessions.
    /// </summary>
    IEnumerable<Session> GetAllSessions();

    /// <summary>
    /// Force-destroys a session, removing all members and cleaning up lookup dictionaries.
    /// Used by the cleanup service for expired sessions.
    /// </summary>
    /// <param name="sessionId">The session to destroy.</param>
    /// <returns>Result with connection IDs of removed members, or null if session not found.</returns>
    ForceDestroySessionResult? ForceDestroySession(Guid sessionId);
}

/// <summary>
/// Result of a member leaving a session.
/// RemainingMemberIds is captured atomically inside LeaveSession() after member removal
/// and any promotion, so it can be used directly for object migration without a
/// second GetSession() call that could race with concurrent joins/leaves.
/// </summary>
public record LeaveSessionResult(
    Guid SessionId,
    string SessionName,
    Guid MemberId,
    bool SessionDestroyed,
    Member? PromotedMember,
    IReadOnlyList<Guid> RemainingMemberIds
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

/// <summary>
/// Result of force-destroying a session.
/// </summary>
public record ForceDestroySessionResult(
    IEnumerable<string> ConnectionIds,
    string SessionName
);
