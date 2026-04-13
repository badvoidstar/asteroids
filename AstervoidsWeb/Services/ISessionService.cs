using AstervoidsWeb.Models;

namespace AstervoidsWeb.Services;

/// <summary>
/// Service for managing game sessions.
/// </summary>
public interface ISessionService
{
    /// <summary>
    /// Creates a new session with a name provided by the configured <see cref="ISessionNameGenerator"/>.
    /// </summary>
    /// <param name="creatorConnectionId">SignalR connection ID of the creator.</param>
    /// <param name="metadata">Optional key-value metadata for the session (e.g. aspect ratio, game mode).</param>
    /// <returns>Result indicating success/failure with session and member if successful.</returns>
    CreateSessionResult CreateSession(string creatorConnectionId, Dictionary<string, object?>? metadata = null);

    /// <summary>
    /// Joins an existing session as a client.
    /// </summary>
    /// <param name="sessionId">The session to join.</param>
    /// <param name="connectionId">SignalR connection ID of the joining member.</param>
    /// <param name="evictMemberId">
    /// Optional member ID to evict before joining (for reconnection scenarios where the
    /// server hasn't yet detected the old connection's death). If the member exists in the
    /// session and its connection differs from <paramref name="connectionId"/>, it is
    /// removed atomically before the new member is added.
    /// </param>
    /// <returns>Result indicating success/failure with session and member if successful.</returns>
    JoinSessionResult JoinSession(Guid sessionId, string connectionId, Guid? evictMemberId = null);

    /// <summary>
    /// Removes a member from their session, performs server promotion if needed, and
    /// handles object cleanup (delete member-scoped, migrate session-scoped) — all in one
    /// atomic operation under the session's <c>SyncRoot</c>.
    /// This method is idempotent: a second call for the same connection returns null
    /// without warnings.
    /// </summary>
    /// <param name="connectionId">SignalR connection ID of the leaving member.</param>
    /// <param name="distributeOrphanedObjects">
    /// When true and multiple members remain, session-scoped objects are distributed
    /// round-robin; otherwise all go to the first remaining member.
    /// </param>
    /// <returns>
    /// Combined result with membership changes and object disposal info, or null if the
    /// connection was not registered in any session (idempotent no-op).
    /// </returns>
    LeaveSessionResult? LeaveSession(string connectionId, bool distributeOrphanedObjects = true);

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
    /// The session lifecycle is set to <c>Destroying</c> before teardown and
    /// <c>Destroyed</c> on completion, so concurrent operations see a consistent state.
    /// This method is idempotent: a second call for the same session returns null.
    /// </summary>
    /// <param name="sessionId">The session to destroy.</param>
    /// <param name="shouldDestroy">
    /// Optional predicate evaluated under the session lock to re-confirm the session
    /// should still be destroyed (guards against join-vs-cleanup races).  When null the
    /// session is always destroyed.
    /// </param>
    /// <returns>Result with connection IDs of removed members, or null if session not found
    /// or already destroyed / predicate returned false.</returns>
    ForceDestroySessionResult? ForceDestroySession(Guid sessionId, Func<Session, bool>? shouldDestroy = null);
}

/// <summary>
/// Result of a member leaving a session.
/// Contains both membership changes (promotion) and object disposal (deleted/migrated
/// objects) so the hub can broadcast a single coherent <c>OnMemberLeft</c> event.
/// All fields are captured atomically inside <see cref="ISessionService.LeaveSession"/>
/// so callers do not need to make a second service call to retrieve object info.
/// </summary>
public record LeaveSessionResult(
    Guid SessionId,
    string SessionName,
    Guid MemberId,
    bool SessionDestroyed,
    Member? PromotedMember,
    IReadOnlyList<Guid> RemainingMemberIds,
    /// <summary>IDs of member-scoped objects that were deleted on departure.</summary>
    IReadOnlyList<Guid> DeletedObjectIds,
    /// <summary>Session-scoped objects that were migrated to other members on departure.</summary>
    IReadOnlyList<ObjectMigration> MigratedObjects
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
    string? ErrorMessage,
    /// <summary>
    /// When non-null, a stale member was evicted during this join (reconnection path).
    /// The hub must broadcast <c>OnMemberLeft</c> with this info so remaining members
    /// can remove the ghost member's objects from their local state.
    /// </summary>
    EvictionInfo? Eviction = null
);

/// <summary>
/// Information about a stale member that was evicted during <see cref="ISessionService.JoinSession"/>.
/// Contains everything needed to broadcast an <c>OnMemberLeft</c> event to remaining members.
/// </summary>
public record EvictionInfo(
    Guid EvictedMemberId,
    string EvictedConnectionId,
    Member? PromotedMember,
    IReadOnlyList<Guid> DeletedObjectIds,
    IReadOnlyList<ObjectMigration> MigratedObjects
);

/// <summary>
/// Result of force-destroying a session.
/// </summary>
public record ForceDestroySessionResult(
    IEnumerable<string> ConnectionIds,
    string SessionName
);
