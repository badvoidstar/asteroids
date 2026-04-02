using System.Collections.Concurrent;
using AstervoidsWeb.Configuration;
using AstervoidsWeb.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Services;

/// <summary>
/// In-memory implementation of session management.
///
/// Locking strategy
/// ────────────────
/// <c>_sessionLock</c> (global): serialises session creation and join capacity checks.
///   It must never be held at the same time as a per-session lock on another session.
///
/// <c>session.SyncRoot</c> (per-session): serialises all mutations local to one session
///   (member add/remove, promotion, object create/update/delete/migrate, lifecycle
///   transitions, and <see cref="Session.LastMemberLeftAt"/> updates).
///
/// When both locks are needed the acquisition order is always
///   <c>_sessionLock</c> → <c>session.SyncRoot</c>.
///
/// Idempotency guarantee
/// ─────────────────────
/// Duplicate <see cref="LeaveSession"/> calls (e.g. explicit leave overlapping with
/// <c>OnDisconnectedAsync</c>) are handled cleanly: the first call removes the connection
/// from <c>_connectionToMember</c> and completes the departure; subsequent calls find no
/// entry and return null at Debug level without emitting warnings.
/// </summary>
public class SessionService : ISessionService
{
    private readonly ConcurrentDictionary<Guid, Session> _sessions = new();
    private readonly ConcurrentDictionary<string, Guid> _connectionToMember = new();
    private readonly ConcurrentDictionary<Guid, Guid> _memberToSession = new();
    private readonly Random _random = new();
    private readonly object _sessionLock = new();
    private readonly ILogger<SessionService>? _logger;
    private readonly int _maxSessions;
    private readonly int _maxMembersPerSession;
    private readonly bool _distributeOrphanedObjects;

    public int MaxSessions => _maxSessions;
    public int MaxMembersPerSession => _maxMembersPerSession;

    private static readonly string[] FruitNames = 
    [
        "Apple", "Banana", "Cherry", "Date", "Elderberry",
        "Fig", "Grape", "Honeydew", "Kiwi", "Lemon",
        "Mango", "Nectarine", "Orange", "Papaya", "Quince",
        "Raspberry", "Strawberry", "Tangerine", "Watermelon", "Blueberry",
        "Coconut", "Dragonfruit", "Guava", "Jackfruit", "Lychee",
        "Mulberry", "Olive", "Peach", "Pear", "Plum",
        "Pomegranate", "Apricot", "Avocado", "Blackberry", "Cantaloupe",
        "Clementine", "Cranberry", "Currant", "Durian", "Grapefruit",
        "Lime", "Mandarin", "Passion", "Persimmon", "Pineapple",
        "Plantain", "Starfruit", "Tamarind", "Yuzu", "Kumquat"
    ];

    public SessionService() 
    {
        _maxSessions = 6;
        _maxMembersPerSession = 4;
        _distributeOrphanedObjects = true;
    }

    public SessionService(IOptions<SessionSettings> settings, ILogger<SessionService> logger)
    {
        _maxSessions = settings.Value.MaxSessions;
        _maxMembersPerSession = settings.Value.MaxMembersPerSession;
        _distributeOrphanedObjects = settings.Value.DistributeOrphanedObjects;
        _logger = logger;
    }

    /// <summary>Creates a failed CreateSessionResult with the specified error message.</summary>
    private static CreateSessionResult CreateSessionFailure(string errorMessage)
        => new(false, null, null, errorMessage);

    /// <summary>Creates a failed JoinSessionResult with the specified error message.</summary>
    private static JoinSessionResult JoinSessionFailure(string errorMessage)
        => new(false, null, null, errorMessage);

    public CreateSessionResult CreateSession(string creatorConnectionId, double aspectRatio)
    {
        lock (_sessionLock)
        {
            // Check if connection is already in a session
            if (_connectionToMember.ContainsKey(creatorConnectionId))
            {
                _logger?.LogWarning("CreateSession failed: connection {ConnectionId} is already in a session", creatorConnectionId);
                return CreateSessionFailure("Already in a session. Leave current session before creating a new one.");
            }

            // Check if we've reached the maximum number of sessions
            var activeCount = _sessions.Count(s => !s.Value.Members.IsEmpty);
            if (activeCount >= _maxSessions)
            {
                _logger?.LogWarning("CreateSession failed: maximum sessions ({MaxSessions}) reached", _maxSessions);
                return CreateSessionFailure($"Maximum number of sessions ({_maxSessions}) has been reached");
            }

            // Validate aspect ratio (reasonable bounds: 0.25 to 4.0)
            var clampedAspectRatio = Math.Clamp(aspectRatio, 0.25, 4.0);

            var session = new Session
            {
                Name = GenerateUniqueFruitName(),
                AspectRatio = clampedAspectRatio
            };

            _sessions.TryAdd(session.Id, session);
            var creator = RegisterMember(creatorConnectionId, session, MemberRole.Server);

            _logger?.LogInformation("Session created: {SessionName} ({SessionId}) by {MemberId}", 
                session.Name, session.Id, creator.Id);

            return new CreateSessionResult(true, session, creator, null);
        }
    }

    public JoinSessionResult JoinSession(Guid sessionId, string connectionId, Guid? evictMemberId = null)
    {
        lock (_sessionLock)
        {
            // Check if connection is already in a session
            if (_connectionToMember.ContainsKey(connectionId))
            {
                _logger?.LogWarning("JoinSession failed: connection {ConnectionId} is already in a session", connectionId);
                return JoinSessionFailure("Already in a session. Leave current session before joining another.");
            }

            if (!_sessions.TryGetValue(sessionId, out var session))
            {
                _logger?.LogWarning("JoinSession failed: session {SessionId} not found", sessionId);
                return JoinSessionFailure("Session not found");
            }

            // Per-session checks and mutation under SyncRoot while _sessionLock prevents
            // concurrent joins from racing on the capacity check.
            lock (session.SyncRoot)
            {
                if (session.LifecycleState != SessionLifecycleState.Active)
                {
                    _logger?.LogWarning("JoinSession failed: session {SessionId} is not active (state: {State})",
                        sessionId, session.LifecycleState);
                    return JoinSessionFailure("Session is no longer available.");
                }

                // ── Evict stale member (reconnection support) ─────────────────────
                // When a client reconnects after a network drop, the server may not
                // have detected the old connection's death yet (up to ClientTimeoutInterval).
                // The client passes its old memberId so we can evict the stale entry
                // before adding the new one, avoiding a window where objects are owned
                // by a ghost member.
                if (evictMemberId.HasValue && session.Members.TryGetValue(evictMemberId.Value, out var staleMember))
                {
                    // Only evict if the stale member's connection differs from the joining one
                    // (safety: never evict the caller's own active connection)
                    if (staleMember.ConnectionId != connectionId)
                    {
                        EvictMemberInternal(session, evictMemberId.Value, staleMember);
                    }
                }

                // Check if session is full
                if (session.Members.Count >= _maxMembersPerSession)
                {
                    _logger?.LogWarning("JoinSession failed: session {SessionId} is full ({MaxMembers} members)", sessionId, _maxMembersPerSession);
                    return JoinSessionFailure($"Session is full (maximum {_maxMembersPerSession} members)");
                }

                // Assign Server role if session has no members (rejoining an empty session)
                var wasEmpty = session.Members.IsEmpty;
                var role = wasEmpty ? MemberRole.Server : MemberRole.Client;
                var member = RegisterMember(connectionId, session, role);

                // When rejoining an empty session, adopt orphaned session-scoped objects.
                // These were left without a valid owner when the last member departed
                // (HandleObjectDeparture can't migrate when there are no remaining members).
                if (wasEmpty)
                    AdoptOrphanedObjects(session, member.Id);

                // Clear empty-session tracking since we now have a member
                session.LastMemberLeftAt = null;

                _logger?.LogInformation("Member {MemberId} joined session {SessionName} ({SessionId}) as {Role}",
                    member.Id, session.Name, session.Id, role);

                return new JoinSessionResult(true, session, member, null);
            }
        }
    }

    /// <inheritdoc/>
    public LeaveSessionResult? LeaveSession(string connectionId, bool distributeOrphanedObjects = true)
    {
        // ── Tentative lookups (no lock, read-only) ─────────────────────────────────
        // These establish the likely session without mutating anything.  We re-validate
        // under session.SyncRoot before committing.
        if (!_connectionToMember.TryGetValue(connectionId, out var memberId))
        {
            // Connection not registered — either never joined or already departed.
            // This is expected when explicit LeaveSession() overlaps OnDisconnectedAsync().
            _logger?.LogDebug("LeaveSession: connection {ConnectionId} not found (already departed or never joined)",
                connectionId);
            return null;
        }

        if (!_memberToSession.TryGetValue(memberId, out var sessionId))
            return null;

        if (!_sessions.TryGetValue(sessionId, out var session))
            return null;

        // ── Atomic departure under session.SyncRoot ────────────────────────────────
        lock (session.SyncRoot)
        {
            // Re-validate under the lock (idempotent: someone else may have already removed this connection)
            if (!_connectionToMember.ContainsKey(connectionId))
            {
                _logger?.LogDebug(
                    "LeaveSession: connection {ConnectionId} already removed (concurrent departure)",
                    connectionId);
                return null;
            }

            if (session.LifecycleState == SessionLifecycleState.Destroyed)
            {
                // Session is already gone — clean up stale index entries silently
                _connectionToMember.TryRemove(connectionId, out _);
                _memberToSession.TryRemove(memberId, out _);
                return null;
            }

            // Remove the member from global indexes and session.Members atomically
            _connectionToMember.TryRemove(connectionId, out _);
            _memberToSession.TryRemove(memberId, out _);

            if (!session.Members.TryRemove(memberId, out var member))
            {
                // Member was already removed (should not normally happen given the
                // connection check above, but guard anyway)
                return null;
            }

            // ── Server promotion ───────────────────────────────────────────────────
            // If the departing member was the server, promote the oldest remaining
            // member (deterministic: earliest JoinedAt, then lowest Id as tie-breaker).
            Member? promotedMember = null;
            if (member.Role == MemberRole.Server && session.Members.Count > 0)
            {
                var promoted = session.Members.Values
                    .OrderBy(m => m.JoinedAt)
                    .ThenBy(m => m.Id)
                    .First();
                promoted.Role = MemberRole.Server;
                promotedMember = promoted;
                session.Version++;

                _logger?.LogInformation(
                    "Member {PromotedMemberId} promoted to Server in session {SessionName} ({SessionId})",
                    promoted.Id, session.Name, session.Id);
            }

            // Snapshot remaining member IDs *after* removal and promotion
            var remainingMemberIds = session.Members.Keys.ToList();

            // ── Object cleanup ─────────────────────────────────────────────────────
            // Performed inside SyncRoot so that no concurrent update/delete/replace
            // can race between membership change and object migration.
            var (deletedObjectIds, migratedObjects) = HandleObjectDeparture(
                session, memberId, remainingMemberIds, distributeOrphanedObjects);

            // ── Empty-session bookkeeping ──────────────────────────────────────────
            // If the last member has left, mark the session for deferred cleanup.
            // Empty sessions are kept alive to allow auto-rejoin within the timeout
            // window (see SessionCleanupService).  Any remaining objects owned by the
            // departed member stay in the session without an owner until cleanup.
            if (session.Members.IsEmpty)
                session.LastMemberLeftAt = DateTime.UtcNow;

            _logger?.LogInformation(
                "Member {MemberId} left session {SessionName} ({SessionId}). " +
                "Deleted {DeletedCount} objects, migrated {MigratedCount} objects.",
                member.Id, session.Name, session.Id,
                deletedObjectIds.Count, migratedObjects.Count);

            return new LeaveSessionResult(
                sessionId,
                session.Name,
                memberId,
                false,
                promotedMember,
                remainingMemberIds,
                deletedObjectIds,
                migratedObjects
            );
        }
    }

    public ActiveSessionsResult GetActiveSessions()
    {
        var sessions = _sessions.Values
            .Where(s => !s.Members.IsEmpty)
            .Select(s => new SessionInfo(s.Id, s.Name, s.Members.Count, _maxMembersPerSession, s.CreatedAt))
            .OrderByDescending(s => s.CreatedAt)
            .ToList();

        return new ActiveSessionsResult(
            sessions,
            _maxSessions,
            sessions.Count < _maxSessions
        );
    }

    public Session? GetSession(Guid sessionId)
        => _sessions.TryGetValue(sessionId, out var session) ? session : null;

    public Member? GetMemberByConnectionId(string connectionId)
    {
        var resolved = ResolveConnectionToSession(connectionId);
        if (resolved == null) return null;
        var (memberId, session) = resolved.Value;
        return session.Members.TryGetValue(memberId, out var member) ? member : null;
    }

    public Session? GetSessionByConnectionId(string connectionId)
        => ResolveConnectionToSession(connectionId)?.session;

    public (Member Member, Session Session)? GetMemberAndSessionByConnectionId(string connectionId)
    {
        var resolved = ResolveConnectionToSession(connectionId);
        if (resolved == null) return null;
        var (memberId, session) = resolved.Value;
        return session.Members.TryGetValue(memberId, out var member) ? (member, session) : null;
    }

    public IEnumerable<Session> GetAllSessions()
        => _sessions.Values.ToList();

    /// <inheritdoc/>
    public ForceDestroySessionResult? ForceDestroySession(Guid sessionId, Func<Session, bool>? shouldDestroy = null)
    {
        if (!_sessions.TryGetValue(sessionId, out var session))
            return null;

        lock (session.SyncRoot)
        {
            // Idempotent: already being destroyed by another concurrent call
            if (session.LifecycleState != SessionLifecycleState.Active)
                return null;

            // Re-check the caller's condition while holding the lock (guards join-vs-cleanup races)
            if (shouldDestroy != null && !shouldDestroy(session))
                return null;

            // Mark as destroying before making any changes visible to other operations
            session.LifecycleState = SessionLifecycleState.Destroying;

            // Remove from global sessions dict so new joins cannot find this session
            _sessions.TryRemove(sessionId, out _);

            // Remove all members from global indexes
            var connectionIds = new List<string>();
            foreach (var member in session.Members.Values)
            {
                _memberToSession.TryRemove(member.Id, out _);
                _connectionToMember.TryRemove(member.ConnectionId, out _);
                connectionIds.Add(member.ConnectionId);
            }

            session.LifecycleState = SessionLifecycleState.Destroyed;

            _logger?.LogInformation(
                "Session {SessionName} ({SessionId}) force-destroyed. Removed {MemberCount} members.",
                session.Name, session.Id, connectionIds.Count);

            return new ForceDestroySessionResult(connectionIds, session.Name);
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────────────

    /// <summary>
    /// Resolves a connection ID to its member ID and session.
    /// Shared lookup chain used by GetMemberByConnectionId, GetSessionByConnectionId,
    /// and GetMemberAndSessionByConnectionId.
    /// </summary>
    private (Guid memberId, Session session)? ResolveConnectionToSession(string connectionId)
    {
        if (!_connectionToMember.TryGetValue(connectionId, out var memberId))
            return null;

        if (!_memberToSession.TryGetValue(memberId, out var sessionId))
            return null;

        return _sessions.TryGetValue(sessionId, out var session) ? (memberId, session) : null;
    }

    /// <summary>
    /// Forcefully removes a stale member from a session during reconnection.
    /// Removes global index entries, the member from <c>session.Members</c>, and
    /// deletes all objects owned by the member (no migration — the caller will join
    /// immediately after and adopt orphaned session-scoped objects).
    ///
    /// Must be called while holding both <c>_sessionLock</c> and <c>session.SyncRoot</c>.
    /// </summary>
    private void EvictMemberInternal(Session session, Guid memberId, Member member)
    {
        // Remove from global indexes
        _connectionToMember.TryRemove(member.ConnectionId, out _);
        _memberToSession.TryRemove(memberId, out _);
        session.Members.TryRemove(memberId, out _);

        // Clean up objects owned by the evicted member:
        // - Member-scoped objects are deleted (ship, bullets — not useful after eviction).
        // - Session-scoped objects are left in place for adoption by the new joiner
        //   via AdoptOrphanedObjects (asteroids, GameState, etc.).
        foreach (var obj in session.Objects.Values.ToList())
        {
            if (obj.OwnerMemberId != memberId)
                continue;
            if (obj.Scope == ObjectScope.Member)
                session.Objects.TryRemove(obj.Id, out _);
            // Session-scoped objects are left in place for adoption
        }

        _logger?.LogInformation(
            "Evicted stale member {MemberId} (connection {ConnectionId}) from session {SessionName} ({SessionId}) during rejoin",
            memberId, member.ConnectionId, session.Name, session.Id);
    }

    /// <summary>
    /// Creates a member, adds it to the session, and registers it in the lookup dictionaries.
    /// Must be called while holding either <c>_sessionLock</c> (for creates/joins)
    /// or <c>session.SyncRoot</c>.
    /// </summary>
    private Member RegisterMember(string connectionId, Session session, MemberRole role)
    {
        var member = new Member
        {
            ConnectionId = connectionId,
            Role = role,
            SessionId = session.Id
        };

        session.Members.TryAdd(member.Id, member);
        _connectionToMember.TryAdd(connectionId, member.Id);
        _memberToSession.TryAdd(member.Id, session.Id);

        return member;
    }

    /// <summary>
    /// Handles object cleanup for a departing member inside a session lock.
    /// Member-scoped objects are deleted; session-scoped objects are migrated to remaining
    /// members (round-robin when distribute is true and multiple members remain; to the
    /// first member otherwise).
    ///
    /// Must be called while holding <c>session.SyncRoot</c>.
    /// </summary>
    private (List<Guid> DeletedObjectIds, List<ObjectMigration> MigratedObjects) HandleObjectDeparture(
        Session session,
        Guid departingMemberId,
        IReadOnlyList<Guid> remainingMemberIds,
        bool distribute)
    {
        var deletedIds = new List<Guid>();
        var migratedObjects = new List<ObjectMigration>();
        var roundRobinIndex = 0;

        foreach (var obj in session.Objects.Values.ToList())
        {
            if (obj.OwnerMemberId != departingMemberId)
                continue;

            if (obj.Scope == ObjectScope.Member)
            {
                if (session.Objects.TryRemove(obj.Id, out _))
                    deletedIds.Add(obj.Id);
            }
            else if (obj.Scope == ObjectScope.Session && remainingMemberIds.Count > 0)
            {
                Guid newOwnerId;
                if (distribute && remainingMemberIds.Count > 1)
                {
                    newOwnerId = remainingMemberIds[roundRobinIndex % remainingMemberIds.Count];
                    roundRobinIndex++;
                }
                else
                {
                    newOwnerId = remainingMemberIds[0];
                }

                obj.OwnerMemberId = newOwnerId;
                // Replace Data with a new dictionary so snapshot reads outside the lock
                // see a stable copy (copy-on-write pattern).
                obj.Data = new Dictionary<string, object?>(obj.Data);
                obj.Version++;
                obj.UpdatedAt = DateTime.UtcNow;
                migratedObjects.Add(new ObjectMigration(obj.Id, newOwnerId, obj.Version));
            }
            // If scope == Session but no remaining members, leave the object in place;
            // it will be cleaned up when the session is eventually destroyed.
        }

        return (deletedIds, migratedObjects);
    }

    /// <summary>
    /// Reassigns orphaned session-scoped objects to the given new owner.
    /// An object is "orphaned" when its <c>OwnerMemberId</c> no longer matches
    /// any current session member.  This happens when the last member leaves:
    /// <see cref="HandleObjectDeparture"/> can't migrate session-scoped objects
    /// when <c>remainingMemberIds</c> is empty, so they stay with the departed
    /// member's ID.  When a new member joins the empty session, this method
    /// transfers those objects so the game can resume.
    /// Must be called under <c>session.SyncRoot</c>.
    /// </summary>
    private void AdoptOrphanedObjects(Session session, Guid newOwnerId)
    {
        var memberIds = session.Members.Keys.ToHashSet();
        var adopted = 0;

        foreach (var obj in session.Objects.Values)
        {
            if (obj.Scope == ObjectScope.Session && !memberIds.Contains(obj.OwnerMemberId))
            {
                obj.OwnerMemberId = newOwnerId;
                obj.Data = new Dictionary<string, object?>(obj.Data); // copy-on-write
                obj.Version++;
                obj.UpdatedAt = DateTime.UtcNow;
                adopted++;
            }
        }

        if (adopted > 0)
        {
            _logger?.LogInformation(
                "Adopted {Count} orphaned session-scoped objects for new member {MemberId} in session {SessionName} ({SessionId})",
                adopted, newOwnerId, session.Name, session.Id);
        }
    }

    private string GenerateUniqueFruitName()
    {
        // Called within _sessionLock, no additional lock needed
        var usedNames = _sessions.Values.Select(s => s.Name).ToHashSet();
        var availableNames = FruitNames.Where(n => !usedNames.Contains(n)).ToList();

        if (availableNames.Count == 0)
        {
            // All fruit names used, append a number
            var counter = 2;
            while (true)
            {
                var candidateName = $"{FruitNames[_random.Next(FruitNames.Length)]}{counter}";
                if (!usedNames.Contains(candidateName))
                    return candidateName;
                counter++;
            }
        }

        return availableNames[_random.Next(availableNames.Count)];
    }
}
