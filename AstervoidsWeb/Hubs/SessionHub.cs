using System.Runtime.CompilerServices;
using AstervoidsWeb.Formatters;
using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using MessagePack;
using MessagePack.Resolvers;
using Microsoft.AspNetCore.SignalR;

namespace AstervoidsWeb.Hubs;

/// <summary>
/// Game-agnostic SignalR hub for real-time session management and object synchronization.
/// Handles sessions, members, objects, ownership, scopes, and batched state updates.
/// All game logic lives on the frontend and communicates through the object system.
/// </summary>
public class SessionHub : Hub
{
    private readonly ISessionService _sessionService;
    private readonly IObjectService _objectService;
    private readonly ILogger<SessionHub> _logger;
    private readonly ServerMetricsService _metrics;

    // Group name for all connected clients to receive session list updates
    internal const string AllClientsGroup = "AllClients";

    public SessionHub(
        ISessionService sessionService,
        IObjectService objectService,
        ILogger<SessionHub> logger,
        ServerMetricsService metrics)
    {
        _sessionService = sessionService;
        _objectService = objectService;
        _logger = logger;
        _metrics = metrics;
    }

    // ── Payload byte estimation ────────────────────────────────────────

    /// <summary>
    /// MessagePack options matching Program.cs configuration, used to estimate
    /// serialized payload sizes for bandwidth tracking.
    /// </summary>
    private static readonly MessagePackSerializerOptions _estimatorOptions =
        MessagePackSerializerOptions.Standard
            .WithResolver(CompositeResolver.Create(
                BinaryGuidResolver.Instance,
                ContractlessStandardResolver.Instance))
            .WithSecurity(MessagePackSecurity.UntrustedData);

    /// <summary>
    /// Estimates the serialized byte size of hub method arguments using MessagePack.
    /// Used for per-member bandwidth tracking in <see cref="ServerMetricsService"/>.
    /// Best-effort: returns 0 on any serialization error so monitoring never breaks hub functionality.
    /// </summary>
    private static long EstimatePayloadBytes(params object?[] args)
    {
        long total = 0;
        foreach (var arg in args)
        {
            if (arg == null) { total += 1; continue; } // MessagePack nil = 1 byte
            try
            {
                total += MessagePackSerializer.Serialize(arg, _estimatorOptions).Length;
            }
            catch
            {
                // Best-effort — monitoring must not break hub functionality
            }
        }
        return total;
    }

    // ── Helper methods ──────────────────────────────────────────────────

    /// <summary>
    /// Looks up the calling member and their session in one step.
    /// Logs a warning (tagged with the calling hub method name) and returns null when
    /// the connection is not associated with an active session member; callers should
    /// early-exit on null.
    /// </summary>
    private (Member Member, Session Session)? GetCallerContext([CallerMemberName] string caller = "")
    {
        var ctx = _sessionService.GetMemberAndSessionByConnectionId(Context.ConnectionId);
        if (ctx == null)
        {
            _logger.LogWarning("{Method} failed - member not found for connection {ConnectionId}",
                caller, Context.ConnectionId);
        }
        return ctx;
    }

    /// <summary>
    /// Broadcasts <paramref name="method"/> with <paramref name="args"/> to every member
    /// of <paramref name="session"/> except the one identified by <paramref name="excludeMemberId"/>,
    /// while recording the estimated payload bytes on each recipient's RX counter.
    /// Use for "OthersInGroup" semantics (sender already has authoritative state via the invoke response).
    /// </summary>
    private async Task BroadcastToOthersAsync(Session session, Guid excludeMemberId, string method, params object?[] args)
    {
        var bytes = EstimatePayloadBytes(args);
        var recipients = session.Members.Keys.Where(id => id != excludeMemberId);
        _metrics.OnBroadcastToMembers(recipients, bytes);
        await Clients.OthersInGroup(session.Id.ToString()).SendAsync(method, args);
    }

    /// <summary>
    /// Broadcasts <paramref name="method"/> with <paramref name="args"/> to every member
    /// of <paramref name="session"/> (including the sender), while recording the estimated
    /// payload bytes on each recipient's RX counter.
    /// </summary>
    private async Task BroadcastToAllAsync(Session session, string method, params object?[] args)
    {
        var bytes = EstimatePayloadBytes(args);
        _metrics.OnBroadcastToMembers(session.Members.Keys, bytes);
        await Clients.Group(session.Id.ToString()).SendAsync(method, args);
    }

    /// <summary>
    /// Looks up an object and verifies ownership by the given member.
    /// This is a fast early-return check only; ownership is also enforced atomically
    /// inside the service layer so correctness does not depend on this pre-check.
    /// Returns null and logs a warning if the object doesn't exist or isn't owned by the member.
    /// </summary>
    private SessionObject? GetOwnedObject(Member member, Guid objectId)
    {
        var obj = _objectService.GetObject(member.SessionId, objectId);
        if (obj == null)
            return null;

        if (obj.OwnerMemberId != member.Id)
        {
            _logger.LogWarning("{Method} rejected - member {MemberId} does not own object {ObjectId}",
                nameof(GetOwnedObject), member.Id, objectId);
            return null;
        }

        return obj;
    }

    private static MemberInfo ToMemberInfo(Member member) =>
        new(member.Id, member.Role.ToString(), member.JoinedAt);

    /// <summary>
    /// Converts a <see cref="SessionObject"/> to a <see cref="ObjectInfo"/> DTO.
    /// Clones <c>Data</c> so the caller receives a stable snapshot that cannot be
    /// mutated by concurrent object updates.
    /// </summary>
    private static ObjectInfo ToObjectInfo(SessionObject o) =>
        new(o.Id, o.CreatorMemberId, o.OwnerMemberId, o.Scope.ToString(),
            new Dictionary<string, object?>(o.Data), o.Version);

    /// <summary>
    /// Takes a consistent point-in-time snapshot of a session's members and objects.
    /// Acquires <c>session.SyncRoot</c> for the duration of the read so that no
    /// concurrent mutation can produce a torn snapshot.
    /// </summary>
    private static (MemberInfo[] Members, ObjectInfo[] Objects) ToSessionSnapshot(Session session)
    {
        lock (session.SyncRoot)
        {
            return (
                [.. session.Members.Values.Select(ToMemberInfo)],
                [.. session.Objects.Values.Select(ToObjectInfo)]
            );
        }
    }

    private static ObjectScope ParseScope(string scope) =>
        scope.Equals("Session", StringComparison.OrdinalIgnoreCase) ? ObjectScope.Session : ObjectScope.Member;

    private static Guid? ParseOwnerGuid(string? ownerMemberId) =>
        ownerMemberId != null && Guid.TryParse(ownerMemberId, out var parsed) ? parsed : null;

    /// <summary>
    /// Called when a client connects - add them to the AllClients group for broadcasts.
    /// </summary>
    public override async Task OnConnectedAsync()
    {
        _metrics.OnConnected();
        await Groups.AddToGroupAsync(Context.ConnectionId, AllClientsGroup);
        await base.OnConnectedAsync();
    }

    /// <summary>
    /// Creates a new session and joins as the server.
    /// </summary>
    /// <param name="metadata">Optional key-value metadata for the session (e.g. aspect ratio, game mode).</param>
    public async Task<CreateSessionResponse?> CreateSession(Dictionary<string, object?>? metadata = null)
    {
        var result = _sessionService.CreateSession(Context.ConnectionId, metadata);

        if (!result.Success)
        {
            _logger.LogWarning("CreateSession failed: {Error}", result.ErrorMessage);
            return null;
        }

        var session = result.Session!;
        var creator = result.Creator!;

        _metrics.OnHubInvocation(creator.Id, EstimatePayloadBytes(metadata));

        await Groups.AddToGroupAsync(Context.ConnectionId, session.Id.ToString());

        _logger.LogInformation(
            "Session {SessionName} ({SessionId}) created by member {MemberId}",
            session.Name, session.Id, creator.Id);

        // Broadcast session list update to all connected clients
        await BroadcastSessionsChanged();

        return new CreateSessionResponse(
            session.Id,
            session.Name,
            creator.Id,
            creator.Role.ToString(),
            session.Metadata
        );
    }

    /// <summary>
    /// Joins an existing session as a client.
    /// </summary>
    /// <param name="sessionId">The session to join.</param>
    /// <param name="evictMemberId">
    /// Optional member ID to evict before joining. Used during auto-rejoin after a
    /// network drop: the old member may still be in the session because the server
    /// hasn't detected the dead connection yet (up to ClientTimeoutInterval).
    /// Passing the old member ID lets the server clean it up atomically before
    /// adding the new member.
    /// </param>
    public async Task<JoinSessionResponse?> JoinSession(Guid sessionId, Guid? evictMemberId = null)
    {
        var result = _sessionService.JoinSession(sessionId, Context.ConnectionId, evictMemberId);
        if (!result.Success)
        {
            _logger.LogWarning("Failed to join session {SessionId}: {Error}", sessionId, result.ErrorMessage);
            return null;
        }

        var session = result.Session!;
        var member = result.Member!;

        _metrics.OnHubInvocation(member.Id, EstimatePayloadBytes(sessionId, evictMemberId));

        if (evictMemberId.HasValue)
            _metrics.OnReconnect(member.Id);

        // ── Broadcast eviction to remaining members ────────────────────────────
        // When a stale member was evicted during this join, notify the group
        // BEFORE adding the new member. This ensures remaining members remove
        // the ghost member's objects (ship, bullets) and process any migrations
        // of session-scoped objects (asteroids). The joining member is not yet
        // in the group, so they won't receive this — they get the full snapshot.
        if (result.Eviction is { } eviction)
        {
            var evictTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            // Remove the evicted member's dead connection from the group so
            // SignalR doesn't try to deliver to a stale transport.
            await Groups.RemoveFromGroupAsync(eviction.EvictedConnectionId, session.Id.ToString());

            var evictionInfo = new MemberLeftInfo(
                eviction.EvictedMemberId,
                eviction.PromotedMember?.Id,
                eviction.PromotedMember?.Role.ToString(),
                eviction.DeletedObjectIds,
                eviction.MigratedObjects
            );
            // The new joiner isn't in the SignalR group yet, so excluding member.Id
            // matches the actual delivery set and keeps RX accounting accurate.
            await BroadcastToOthersAsync(session, member.Id, "OnMemberLeft",
                evictionInfo, eviction.EvictedMemberId, (long)0, evictTimestamp);

            _metrics.RemoveMember(eviction.EvictedMemberId);

            _logger.LogInformation(
                "Broadcast eviction of stale member {EvictedMemberId} from session {SessionName}. " +
                "Deleted {DeletedCount} objects, migrated {MigratedCount} objects.",
                eviction.EvictedMemberId, session.Name,
                eviction.DeletedObjectIds.Count, eviction.MigratedObjects.Count);
        }

        // Order: AddToGroupAsync FIRST, then take the snapshot.
        //
        // The reverse order (snapshot before AddToGroupAsync) creates a window where
        // a concurrent broadcast (e.g. OnObjectsUpdated) is sent to the SignalR group
        // BEFORE the new connection is in the group, so the joiner never receives it.
        // The snapshot then carries an older view of that object and the joiner has
        // no way to recover the missed event content (e.g. a pendingHit bit that
        // doesn't appear in subsequent updates).
        //
        // With this order, the joiner may briefly receive a broadcast for an object
        // that also appears in the snapshot. The client's handleSessionJoined and
        // handleRemoteObjectsUpdated both compare versions and apply whichever is
        // newer, so duplicates are dedup'd.
        await Groups.AddToGroupAsync(Context.ConnectionId, session.Id.ToString());

        var (members, objects) = ToSessionSnapshot(session);

        var memberSequence = NextMemberSequence(member);
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var joinedMemberInfo = ToMemberInfo(member);
        await BroadcastToOthersAsync(session, member.Id, "OnMemberJoined",
            joinedMemberInfo, member.Id, memberSequence, serverTimestamp);

        _logger.LogInformation(
            "Member {MemberId} joined session {SessionName} ({SessionId})",
            member.Id, session.Name, session.Id);

        // Broadcast session list update to all connected clients
        await BroadcastSessionsChanged();

        return new JoinSessionResponse(
            session.Id,
            session.Name,
            member.Id,
            member.Role.ToString(),
            members,
            objects,
            session.Metadata
        );
    }

    /// <summary>
    /// Leaves the current session.
    /// All object cleanup (member-scoped deletion, session-scoped migration) and server
    /// promotion happen atomically inside <see cref="ISessionService.LeaveSession"/>.
    /// A duplicate call (explicit leave overlapping with <c>OnDisconnectedAsync</c>) is
    /// a no-op and does not emit warnings.
    /// </summary>
    public async Task LeaveSession()
    {
        var result = _sessionService.LeaveSession(Context.ConnectionId);
        if (result == null)
        {
            // Expected when explicit leave and disconnect overlap — no warning needed.
            _logger.LogDebug("LeaveSession: no session found for connection {ConnectionId} (already departed)",
                Context.ConnectionId);
            return;
        }

        await Groups.RemoveFromGroupAsync(Context.ConnectionId, result.SessionId.ToString());

        if (!result.SessionDestroyed && result.RemainingMemberIds.Count > 0)
        {
            var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            // Notify remaining members with enriched departure info.
            // Promotion info and object disposal are all in the single LeaveSessionResult,
            // captured atomically by the service. The leaver has already been removed
            // from session.Members, so session.Members.Keys == result.RemainingMemberIds.
            var departureInfo = new MemberLeftInfo(
                result.MemberId,
                result.PromotedMember?.Id,
                result.PromotedMember?.Role.ToString(),
                result.DeletedObjectIds,
                result.MigratedObjects
            );
            var session = _sessionService.GetSession(result.SessionId);
            if (session != null)
            {
                await BroadcastToAllAsync(session, "OnMemberLeft",
                    departureInfo, result.MemberId, (long)0, serverTimestamp);
            }

            if (result.PromotedMember != null)
            {
                _logger.LogInformation(
                    "Member {PromotedMemberId} promoted to Server in session {SessionName}. " +
                    "Migrated {MigratedCount} objects, deleted {DeletedCount} objects.",
                    result.PromotedMember.Id, result.SessionName,
                    result.MigratedObjects.Count,
                    result.DeletedObjectIds.Count);
            }
        }
        else if (result.RemainingMemberIds.Count == 0)
        {
            _logger.LogInformation("Session {SessionName} ({SessionId}) is now empty",
                result.SessionName, result.SessionId);
        }

        _logger.LogInformation("Member {MemberId} left session {SessionName}", result.MemberId, result.SessionName);

        _metrics.RemoveMember(result.MemberId);

        // Broadcast session list update to all connected clients
        await BroadcastSessionsChanged();
    }

    /// <summary>
    /// Gets all active sessions.
    /// </summary>
    public ActiveSessionsResponse GetActiveSessions()
    {
        var result = _sessionService.GetActiveSessions();
        return new ActiveSessionsResponse(
            result.Sessions.Select(s => new SessionListItem(s.Id, s.Name, s.MemberCount, s.MaxMembers, s.CreatedAt)),
            result.MaxSessions,
            result.CanCreateSession
        );
    }

    /// <summary>
    /// Broadcasts a signal to all connected clients that the session list has changed.
    /// Clients should call GetActiveSessions() to fetch updated data.
    /// </summary>
    private async Task BroadcastSessionsChanged()
    {
        await Clients.Group(AllClientsGroup).SendAsync("OnSessionsChanged");
    }

    /// <summary>
    /// Creates a new synchronized object in the session.
    /// Broadcast uses OthersInGroup — the sender registers the object from the
    /// invoke response (response-first, since server-assigned ID is needed).
    /// This means the sender's own memberSequence for this
    /// event is not delivered via broadcast; it is returned in the response instead.
    /// Trade-off: if the invoke response is lost (rare — TCP/WebSocket guarantees delivery,
    /// but SignalR reconnection could cause this), the sender's local state would diverge
    /// until reconciliation recovers it. See trackMemberSequence() in object-sync.js.
    /// </summary>
    public async Task<CreateObjectResponse?> CreateObject(Dictionary<string, object?>? data, string scope = "Member", string? ownerMemberId = null)
    {
        var ctx = GetCallerContext();
        if (ctx == null) return null;
        var (member, session) = ctx.Value;

        _metrics.OnHubInvocation(member.Id, EstimatePayloadBytes(data, scope, ownerMemberId));

        var obj = _objectService.CreateObject(member.SessionId, member.Id, ParseScope(scope), data, ParseOwnerGuid(ownerMemberId));
        if (obj == null)
        {
            _logger.LogWarning("CreateObject failed - could not create object in session");
            return null;
        }

        var objectInfo = ToObjectInfo(obj);

        var memberSequence = NextMemberSequence(member);
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Broadcast to other members only — sender registers from invoke response (response-first).
        // Sender's own memberSequence is returned in the response, not via broadcast echo.
        await BroadcastToOthersAsync(session, member.Id, "OnObjectCreated",
            objectInfo, member.Id, memberSequence, serverTimestamp);

        _logger.LogDebug("Object {ObjectId} created in session by member {MemberId} (scope: {Scope})", obj.Id, member.Id, obj.Scope);

        return new CreateObjectResponse(objectInfo, memberSequence);
    }

    /// <summary>
    /// Updates multiple objects atomically.
    /// Ownership is enforced inside the service layer (atomically with the update) so
    /// correctness does not depend on this hub's pre-checks.
    /// </summary>
    public async Task<UpdateObjectsResponse?> UpdateObjects(IEnumerable<ObjectUpdateRequest> updates, long? senderSequence = null, long? clientTimestamp = null, long? senderSendIntervalMs = null)
    {
        var ctx = GetCallerContext();
        if (ctx == null) return null;
        var (member, session) = ctx.Value;

        _metrics.OnHubInvocation(member.Id, EstimatePayloadBytes(updates, senderSequence, clientTimestamp, senderSendIntervalMs));

        // Map hub request type to service type; ownership enforcement is inside the service.
        var serviceUpdates = updates.Select(u => new ObjectUpdate(u.ObjectId, u.Data));
        var updatedObjects = _objectService.UpdateObjects(member.SessionId, member.Id, serviceUpdates).ToList();

        var objectInfos = updatedObjects.Select(ToObjectInfo).ToList();

        long memberSequence = 0;
        long serverTimestamp = 0;
        if (objectInfos.Count > 0)
        {
            memberSequence = NextMemberSequence(member);
            serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            // Build a map from objectId → requested data for the broadcast payload.
            // Use the service updates (which own the data dictionaries we passed in).
            var requestDataByObjectId = serviceUpdates
                .GroupBy(u => u.ObjectId)
                .ToDictionary(g => g.Key, g => g.Last().Data);
            var updateInfos = updatedObjects
                .Where(o => requestDataByObjectId.ContainsKey(o.Id))
                .Select(o => new ObjectUpdateInfo(o.Id, requestDataByObjectId[o.Id], o.Version))
                .ToList();

            // Broadcast to other members only — sender gets versions/RTT from the response
            await BroadcastToOthersAsync(session, member.Id, "OnObjectsUpdated",
                updateInfos, member.Id, senderSequence, memberSequence, serverTimestamp, clientTimestamp, senderSendIntervalMs);
        }

        var versions = updatedObjects.ToDictionary(o => o.Id.ToString(), o => o.Version);
        return new UpdateObjectsResponse(versions, memberSequence, serverTimestamp);
    }

    /// <summary>
    /// Deletes an object from the session.
    /// Only allows deletion of objects owned by the caller.
    /// Broadcast uses OthersInGroup — the sender deletes locally before invoking (local-first).
    /// Same trade-off as CreateObject: sender's memberSequence comes from the response, not
    /// a broadcast echo. Lost response would leave sender's sequence map stale until
    /// reconciliation. See trackMemberSequence() in object-sync.js.
    ///
    /// Ownership is enforced atomically inside <see cref="IObjectService.DeleteObject"/>
    /// under the session lock, so the hub-level <c>GetOwnedObject</c> pre-check is only a
    /// fast early-return and cannot be TOCTOU-exploited.
    /// </summary>
    public async Task<DeleteObjectResponse?> DeleteObject(Guid objectId)
    {
        var ctx = GetCallerContext();
        if (ctx == null) return null;
        var (member, session) = ctx.Value;

        _metrics.OnHubInvocation(member.Id, EstimatePayloadBytes(objectId));

        // Ownership is enforced atomically inside the service.
        var deletedObj = _objectService.DeleteObject(member.SessionId, objectId, member.Id);
        if (deletedObj == null)
        {
            _logger.LogWarning("DeleteObject rejected - object {ObjectId} not found or not owned by member {MemberId}",
                objectId, member.Id);
            return null;
        }

        var memberSequence = NextMemberSequence(member);
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Broadcast to other members only — sender deleted locally before invoking (local-first).
        // Sender's own memberSequence is returned in the response, not via broadcast echo.
        await BroadcastToOthersAsync(session, member.Id, "OnObjectDeleted",
            objectId, member.Id, memberSequence, serverTimestamp);
        _logger.LogDebug("Object {ObjectId} deleted from session {SessionId}", objectId, member.SessionId);

        return new DeleteObjectResponse(true, memberSequence);
    }

    /// <summary>
    /// Atomically deletes an object and creates replacement objects in a single broadcast.
    /// Used for splitting objects where all members need to see the deletion and creation together.
    /// Ownership check, creation of replacements, and deletion of the original all happen
    /// atomically under the session lock inside the service layer.
    /// </summary>
    public async Task<List<ObjectInfo>?> ReplaceObject(Guid deleteObjectId, List<Dictionary<string, object?>> replacements, string scope = "Session", string? ownerMemberId = null)
    {
        var ctx = GetCallerContext();
        if (ctx == null) return null;
        var (member, session) = ctx.Value;

        _metrics.OnHubInvocation(member.Id, EstimatePayloadBytes(deleteObjectId, replacements, scope, ownerMemberId));

        var objectScope = ParseScope(scope);
        var ownerGuid = ParseOwnerGuid(ownerMemberId);

        // Build replacement specs; service enforces ownership atomically
        var specs = replacements
            .Select(data => new ReplacementObjectSpec(objectScope, data, ownerGuid))
            .ToList();

        var createdObjects = _objectService.ReplaceObject(member.SessionId, deleteObjectId, member.Id, specs);
        if (createdObjects == null)
        {
            _logger.LogWarning("ReplaceObject failed - object {ObjectId} not found, not owned by member {MemberId}, or session not active",
                deleteObjectId, member.Id);
            return null;
        }

        var createdInfos = createdObjects.Select(ToObjectInfo).ToList();

        var memberSequence = NextMemberSequence(member);
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Single atomic broadcast to ALL members (including sender).
        // NOTE: Cannot use OthersInGroup here — sender relies on this broadcast to
        // update its local object map (replaceObject is not local-first). Would need
        // to refactor replaceObject to process the invoke response locally first.
        var replaceEvent = new ObjectReplacedEvent(deleteObjectId, createdInfos);
        await BroadcastToAllAsync(session, "OnObjectReplaced",
            replaceEvent, member.Id, memberSequence, serverTimestamp);

        _logger.LogDebug("Object {ObjectId} replaced with {Count} objects in session {SessionId}",
            deleteObjectId, createdObjects.Count, member.SessionId);

        return createdInfos;
    }

    /// <summary>
    /// Returns the current session state for reconciliation.
    /// No side effects — does not broadcast or modify any state.
    /// </summary>
    public SessionStateSnapshot? GetSessionState()
    {
        var ctx = GetCallerContext();
        if (ctx == null) return null;
        var (member, session) = ctx.Value;

        _metrics.OnHubInvocation(member.Id, 1); // GetSessionState has no payload arguments
        _metrics.OnReconciliation(member.Id);

        var (members, objects) = ToSessionSnapshot(session);

        var memberSequences = session.Members.Values.ToDictionary(
            m => m.Id.ToString(), m => Interlocked.Read(ref m.EventSequence));

        return new SessionStateSnapshot(members, objects, memberSequences);
    }

    /// <summary>
    /// Handles client disconnection.
    /// </summary>
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (exception != null)
        {
            _logger.LogWarning(exception, "Client disconnected with exception: {ConnectionId}", Context.ConnectionId);
        }

        _metrics.OnDisconnected();

        // Clean up session membership - must not throw to prevent orphaned entries
        try
        {
            await LeaveSession();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during disconnect cleanup for {ConnectionId}", Context.ConnectionId);
        }

        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>
    /// Atomically increments and returns the next event sequence number for a member.
    /// </summary>
    private static long NextMemberSequence(Member member)
    {
        return Interlocked.Increment(ref member.EventSequence);
    }
}
