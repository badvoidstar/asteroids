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
    private readonly SyncSchemaRegistry _schemaRegistry;

    // Group name for all connected clients to receive session list updates
    internal const string AllClientsGroup = "AllClients";

    public SessionHub(
        ISessionService sessionService,
        IObjectService objectService,
        ILogger<SessionHub> logger,
        ServerMetricsService metrics,
        SyncSchemaRegistry schemaRegistry)
    {
        _sessionService = sessionService;
        _objectService = objectService;
        _logger = logger;
        _metrics = metrics;
        _schemaRegistry = schemaRegistry;
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
        // SendCoreAsync, NOT SendAsync — the latter has no params object?[] overload, so
        // SendCoreAsync(method, args) would resolve to SendAsync(string, object?) and wrap
        // the entire args array as a single client argument, breaking handlers that
        // expect multiple positional arguments.
        await Clients.OthersInGroup(session.Id.ToString()).SendCoreAsync(method, args);
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
        // SendCoreAsync — see BroadcastToOthersAsync for the rationale.
        await Clients.Group(session.Id.ToString()).SendCoreAsync(method, args);
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
        new(member.Id, member.Role, member.JoinedAt);

    /// <summary>
    /// Converts a <see cref="SessionObject"/> to a <see cref="ObjectInfo"/> DTO.
    /// Wraps <c>Data</c> in a <see cref="SyncPayload"/> envelope (Phase 3 wire
    /// shape: SchemaId=0 + MessagePack-encoded dict bytes); the underlying dict
    /// is implicitly cloned by serialization so callers cannot mutate the
    /// stored dict via the returned bytes.
    /// </summary>
    private static ObjectInfo ToObjectInfo(SessionObject o) =>
        new(o.Id, o.CreatorMemberId, o.OwnerMemberId, o.Scope,
            SyncPayloadCodec.EncodeDict(o.Data), o.Version);

    /// <summary>
    /// Takes a consistent point-in-time snapshot of a session's members and objects.
    /// Acquires <c>session.SyncRoot</c> for the duration of the read so that no
    /// concurrent mutation can produce a torn snapshot.
    ///
    /// Returns a parallel <c>validAts</c> array (objectId, validAt pairs) so the
    /// snapshot keeps per-object timing without duplicating the field on every
    /// <see cref="ObjectInfo"/>; live broadcasts use a single batch-level
    /// <c>validAt</c> trailing argument and never need this map.
    /// </summary>
    private static (MemberInfo[] Members, ObjectInfo[] Objects, GuidLongPair[] ValidAts) ToSessionSnapshot(Session session)
    {
        lock (session.SyncRoot)
        {
            var objs = session.Objects.Values.ToArray();
            var validAts = objs.Select(o => new GuidLongPair(o.Id, o.ValidAt)).ToArray();
            return (
                [.. session.Members.Values.Select(ToMemberInfo)],
                [.. objs.Select(ToObjectInfo)],
                validAts
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

        // Phase 4 wireopt: register any schemas the game declared in
        // metadata.schemas before any object events can flow. Schemas are
        // session-create-time only; later joins inherit them via the
        // metadata round-trip in JoinSessionResponse.
        try
        {
            var schemas = SyncSchemaRegistry.ParseFromMetadata(metadata);
            _schemaRegistry.SetSessionSchemas(session.Id, schemas);
            if (schemas.Count > 0)
            {
                _logger.LogInformation(
                    "Session {SessionId} registered {Count} positional schemas: {Ids}",
                    session.Id, schemas.Count, string.Join(",", schemas.Select(s => s.Id)));
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Session {SessionId} metadata.schemas parse failed; positional payloads will be rejected",
                session.Id);
        }

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
            creator.Role,
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
        // Capture serverTimestamp at hub-method entry so it represents the
        // moment the action was authoritatively realized, not the moment the
        // broadcast was assembled. Receivers use this for adaptive-delay
        // tracking and as the fallback validAt when the owner's clientValidAt
        // is null or fails the ±2s sanity clamp.
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

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
            // Reuse the hub-entry serverTimestamp captured above — the eviction
            // is realized as part of this join call's atomic processing.
            // Remove the evicted member's dead connection from the group so
            // SignalR doesn't try to deliver to a stale transport.
            await Groups.RemoveFromGroupAsync(eviction.EvictedConnectionId, session.Id.ToString());

            var evictionInfo = new MemberLeftInfo(
                eviction.EvictedMemberId,
                eviction.PromotedMember?.Id,
                eviction.PromotedMember?.Role,
                eviction.DeletedObjectIds,
                eviction.MigratedObjects
            );
            // The new joiner isn't in the SignalR group yet, so excluding member.Id
            // matches the actual delivery set and keeps RX accounting accurate.
            await BroadcastToOthersAsync(session, member.Id, "OnMemberLeft",
                evictionInfo, eviction.EvictedMemberId, (long)0, serverTimestamp);

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

        var (members, objects, validAts) = ToSessionSnapshot(session);

        var memberSequence = NextMemberSequence(member);

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
            member.Role,
            members,
            objects,
            validAts,
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
        // Hub-entry serverTimestamp — see JoinSession for rationale.
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

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

            // Notify remaining members with enriched departure info.
            // Promotion info and object disposal are all in the single LeaveSessionResult,
            // captured atomically by the service. The leaver has already been removed
            // from session.Members, so session.Members.Keys == result.RemainingMemberIds.
            var departureInfo = new MemberLeftInfo(
                result.MemberId,
                result.PromotedMember?.Id,
                result.PromotedMember?.Role,
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
            // Last member departed. The session is NOT torn down yet — the
            // service only marks LastMemberLeftAt and lets the session sit
            // in an empty grace window so a rejoin can promote the rejoiner
            // to Server with the existing schemas/state intact.
            // SyncSchemaRegistry.ClearSession is therefore deferred to
            // SessionCleanupService, which calls it at the actual destroy
            // point (ForceDestroySession). Clearing it here would break the
            // rejoin path: positional payloads from the rejoiner would
            // throw "Schema not registered for session" until the empty
            // grace window expired and a brand-new session was created.
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
    /// <param name="clientValidAt">
    /// Owner's NTP-aligned server-time estimate of the simulation tick that
    /// produced this object's initial state. Forwarded to receivers as the
    /// broadcast's <c>validAt</c> after a ±2s sanity clamp so they can place
    /// the snapshot on the unified server-time interpolation axis. Null when
    /// the owner's clock isn't yet initialized; server falls back to its
    /// hub-entry timestamp (upload-biased but always usable).
    /// </param>
    public async Task<CreateObjectResponse?> CreateObject(SyncPayload? data, string scope = "Member", string? ownerMemberId = null, long? clientValidAt = null)
    {
        // Hub-entry serverTimestamp — see JoinSession for rationale.
        // clientValidAt is forwarded into the service which validates it (±2 s
        // clamp + monotonic cap) and stamps the result on SessionObject.ValidAt.
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var ctx = GetCallerContext();
        if (ctx == null) return null;
        var (member, session) = ctx.Value;

        _metrics.OnHubInvocation(member.Id, EstimatePayloadBytes(data, scope, ownerMemberId, clientValidAt));

        // Phase 3 envelope: decode the wire payload to the server-internal
        // dict shape that ObjectService consumes. SchemaId=0 → MessagePack
        // dict; SchemaId>=1 → positional codec via the per-session registry.
        var dataDict = SyncPayloadCodec.DecodeDict(
            data ?? SyncPayloadCodec.EncodeDict(null),
            member.SessionId,
            _schemaRegistry);

        var obj = _objectService.CreateObject(member.SessionId, member.Id, ParseScope(scope), dataDict, ParseOwnerGuid(ownerMemberId), clientValidAt, serverTimestamp);
        if (obj == null)
        {
            _logger.LogWarning("CreateObject failed - could not create object in session");
            return null;
        }

        var objectInfo = ToObjectInfo(obj);

        var memberSequence = NextMemberSequence(member);

        // Broadcast to other members only — sender registers from invoke response (response-first).
        // Sender's own memberSequence is returned in the response, not via broadcast echo.
        // ValidAt is now a single batch-level trailing argument (per-batch is
        // sufficient because every object in a single broadcast shares the same
        // owner-stamped sample time after server validation).
        await BroadcastToOthersAsync(session, member.Id, "OnObjectCreated",
            objectInfo, member.Id, memberSequence, serverTimestamp, obj.ValidAt);

        _logger.LogDebug("Object {ObjectId} created in session by member {MemberId} (scope: {Scope})", obj.Id, member.Id, obj.Scope);

        return new CreateObjectResponse(objectInfo, memberSequence, obj.ValidAt);
    }

    /// <summary>
    /// Updates multiple objects atomically.
    /// Ownership is enforced inside the service layer (atomically with the update) so
    /// correctness does not depend on this hub's pre-checks.
    /// </summary>
    /// <param name="clientValidAt">
    /// Owner's NTP-aligned server-time estimate of the simulation tick that
    /// produced this batch of updates. Forwarded to receivers as the
    /// broadcast's <c>validAt</c> trailing argument after a ±2s sanity clamp +
    /// per-object monotonic cap so they can place every snapshot on the unified
    /// server-time interpolation axis. Null when the owner's clock isn't yet
    /// initialized; server falls back to its hub-entry timestamp.
    /// </param>
    public async Task<UpdateObjectsResponse?> UpdateObjects(IEnumerable<ObjectUpdateRequest> updates, long? senderSequence = null, long? senderSendIntervalMs = null, long? clientValidAt = null)
    {
        // Hub-entry serverTimestamp — see JoinSession for rationale. Always
        // populated (even when no objects are updated) so the response carries
        // a valid timestamp the client's clock-offset estimator can use.
        // clientValidAt is validated inside the service (±2 s clamp + monotonic cap)
        // and stamped on each SessionObject.ValidAt.
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var ctx = GetCallerContext();
        if (ctx == null) return null;
        var (member, session) = ctx.Value;

        _metrics.OnHubInvocation(member.Id, EstimatePayloadBytes(updates, senderSequence, senderSendIntervalMs, clientValidAt));

        // Phase 3 envelope: decode each request's SyncPayload to the dict
        // shape the service consumes. We cache the original SyncPayload by
        // objectId so the broadcast can echo the SAME bytes the sender sent
        // (avoids a wasteful decode-then-reencode round-trip and preserves
        // any compactness the sender's encoder achieved).
        var updatesList = updates.ToList();
        var requestPayloadByObjectId = updatesList
            .GroupBy(u => u.ObjectId)
            .ToDictionary(g => g.Key, g => g.Last().Data);
        var serviceUpdates = updatesList
            .Select(u => new ObjectUpdate(u.ObjectId, SyncPayloadCodec.DecodeDict(u.Data, member.SessionId, _schemaRegistry)))
            .ToList();
        var updatedObjects = _objectService.UpdateObjects(member.SessionId, member.Id, serviceUpdates, clientValidAt, serverTimestamp).ToList();

        long memberSequence = 0;
        if (updatedObjects.Count > 0)
        {
            memberSequence = NextMemberSequence(member);
            // Build broadcast payload from the cached request payloads (verbatim
            // bytes from the sender) — no need to re-encode the dict the service
            // already merged into obj.Data.
            var updateInfos = updatedObjects
                .Where(o => requestPayloadByObjectId.ContainsKey(o.Id))
                .Select(o => new ObjectUpdateInfo(o.Id, requestPayloadByObjectId[o.Id], o.Version))
                .ToList();

            // ValidAt is a single batch-level trailing argument: every object in
            // this batch was sampled at the same owner tick and shares the same
            // server-validated value. Read it from any updated object — they're
            // all equal after ValidateValidAt collapses to the call-level input.
            var batchValidAt = updatedObjects[0].ValidAt;

            await BroadcastToOthersAsync(session, member.Id, "OnObjectsUpdated",
                updateInfos, member.Id, senderSequence, memberSequence, serverTimestamp, senderSendIntervalMs, batchValidAt);
        }

        var versions = updatedObjects.Select(o => new GuidLongPair(o.Id, o.Version)).ToArray();
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
        // Hub-entry serverTimestamp — see JoinSession for rationale.
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

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
    /// <summary>
    /// Atomically deletes an object and creates replacement objects in a single broadcast.
    /// Used for splitting objects where all members need to see the deletion and creation together.
    /// Ownership check, creation of replacements, and deletion of the original all happen
    /// atomically under the session lock inside the service layer.
    /// </summary>
    /// <param name="clientValidAt">
    /// Owner's NTP-aligned server-time estimate of the simulation tick that
    /// produced the replacement (for asteroid splits this is the moment of
    /// collision detection on the owner). Forwarded to receivers as the
    /// broadcast's <c>validAt</c> after a ±2s sanity clamp so they can place
    /// each new child snapshot on the unified server-time interpolation axis,
    /// eliminating the owner→server upload-time bias from spawn placement.
    /// Null when the owner's clock isn't yet initialized; server falls back
    /// to its hub-entry timestamp.
    /// </param>
    public async Task<List<ObjectInfo>?> ReplaceObject(Guid deleteObjectId, List<SyncPayload> replacements, string scope = "Session", string? ownerMemberId = null, long? clientValidAt = null)
    {
        // Hub-entry serverTimestamp — used by recordPacketArrival (network arrival
        // timing, includes server processing time). NOT used as the spawn anchor;
        // the owner-stamped clientValidAt is validated and stored on each child
        // SessionObject by the service, then read back for the broadcast.
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var ctx = GetCallerContext();
        if (ctx == null) return null;
        var (member, session) = ctx.Value;

        _metrics.OnHubInvocation(member.Id, EstimatePayloadBytes(deleteObjectId, replacements, scope, ownerMemberId, clientValidAt));

        var objectScope = ParseScope(scope);
        var ownerGuid = ParseOwnerGuid(ownerMemberId);

        // Build replacement specs; service enforces ownership atomically and stamps
        // the validated collision-time on each child's ValidAt. Phase 3 envelope:
        // each replacement's SyncPayload is decoded to the dict the service expects.
        var specs = replacements
            .Select(payload => new ReplacementObjectSpec(objectScope, SyncPayloadCodec.DecodeDict(payload, member.SessionId, _schemaRegistry), ownerGuid))
            .ToList();

        var createdObjects = _objectService.ReplaceObject(member.SessionId, deleteObjectId, member.Id, specs, clientValidAt, serverTimestamp);
        if (createdObjects == null)
        {
            _logger.LogWarning("ReplaceObject failed - object {ObjectId} not found, not owned by member {MemberId}, or session not active",
                deleteObjectId, member.Id);
            return null;
        }

        var createdInfos = createdObjects.Select(ToObjectInfo).ToList();

        var memberSequence = NextMemberSequence(member);

        // Single atomic broadcast to ALL members (including sender).
        // NOTE: Cannot use OthersInGroup here — sender relies on this broadcast to
        // update its local object map (replaceObject is not local-first). Would need
        // to refactor replaceObject to process the invoke response locally first.
        // ValidAt is a single batch-level trailing argument (all children share the
        // same server-validated collision-time value).
        var batchValidAt = createdObjects.Count > 0 ? createdObjects[0].ValidAt : serverTimestamp;
        var replaceEvent = new ObjectReplacedEvent(deleteObjectId, createdInfos);
        await BroadcastToAllAsync(session, "OnObjectReplaced",
            replaceEvent, member.Id, memberSequence, serverTimestamp, batchValidAt);

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

        var (members, objects, validAts) = ToSessionSnapshot(session);

        var memberSequences = session.Members.Values.Select(
            m => new GuidLongPair(m.Id, Interlocked.Read(ref m.EventSequence))).ToArray();

        return new SessionStateSnapshot(members, objects, validAts, memberSequences);
    }

    /// <summary>
    /// Broadcasts a small per-object event to all other members of the session.
    /// Server is a relay — <paramref name="payload"/> is opaque (game-defined
    /// dictionary). Used for low-frequency state transitions that don't belong
    /// on the per-frame update path (score changes, one-shot impact reports,
    /// etc.). Owner-only: caller must own <paramref name="objectId"/>.
    ///
    /// Ordering: emitted under the same broadcast pattern as OnObjectsUpdated /
    /// OnObjectReplaced, so SignalR per-connection FIFO preserves
    /// "event-before-next-update" at every receiver. Hazard L2 (bullet-hit
    /// must arrive before asteroid Replace) is structurally satisfied so long
    /// as the sender emits the event before the next per-frame flush.
    /// </summary>
    /// <param name="clientValidAt">
    /// Owner's NTP-aligned server-time estimate of the simulation moment that
    /// produced this event. Forwarded to receivers as the broadcast's
    /// <c>validAt</c> trailing argument after a ±2s sanity clamp. Null when
    /// the owner's clock isn't yet initialized; server falls back to its
    /// hub-entry timestamp.
    /// </param>
    public async Task<bool> BroadcastObjectEvent(Guid objectId, byte eventKind, Dictionary<string, object?>? payload, long? clientValidAt = null)
    {
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var ctx = GetCallerContext();
        if (ctx == null) return false;
        var (member, session) = ctx.Value;

        _metrics.OnHubInvocation(member.Id, EstimatePayloadBytes(objectId, eventKind, payload, clientValidAt));

        // Ownership check — events are owner-attested observations about the
        // object's state; non-owners cannot fabricate them.
        var owned = GetOwnedObject(member, objectId);
        if (owned == null) return false;

        var memberSequence = NextMemberSequence(member);

        // Inline ±2s clamp (events don't go through ObjectService.ValidateValidAt).
        long validAt = serverTimestamp;
        if (clientValidAt.HasValue)
        {
            var diff = clientValidAt.Value - serverTimestamp;
            if (diff >= -2000 && diff <= 2000) validAt = clientValidAt.Value;
        }

        var eventInfo = new ObjectEventInfo(objectId, eventKind, payload);
        await BroadcastToOthersAsync(session, member.Id, "OnObjectEvent",
            eventInfo, member.Id, memberSequence, serverTimestamp, validAt);

        return true;
    }

    /// <summary>
    /// Returns the current server UTC time in unix milliseconds. Used by clients
    /// to compute their clock offset relative to the server (NTP-style):
    /// <c>offset = serverTime + (rtt / 2) − clientReceiveTime</c>.
    ///
    /// The timestamp is captured on the return statement itself for minimum
    /// server-side processing bias. No session membership is required, so the
    /// client can run a clock-sync bootstrap immediately after connect, before
    /// joining a session.
    /// </summary>
    public long Ping()
    {
        // Track for bandwidth metrics if the caller is associated with a member,
        // but tolerate calls before session join (sessionless clock sync).
        var ctx = GetCallerContext();
        if (ctx != null)
        {
            _metrics.OnHubInvocation(ctx.Value.Member.Id, 0);
        }
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
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
