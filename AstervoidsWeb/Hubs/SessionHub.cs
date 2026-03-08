using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
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

    // Group name for all connected clients to receive session list updates
    internal const string AllClientsGroup = "AllClients";

    public SessionHub(
        ISessionService sessionService,
        IObjectService objectService,
        ILogger<SessionHub> logger)
    {
        _sessionService = sessionService;
        _objectService = objectService;
        _logger = logger;
    }

    // ── Helper methods ──────────────────────────────────────────────────

    /// <summary>
    /// Looks up the calling member and their session in one step.
    /// Returns null if either is missing (caller should return null/early-exit).
    /// </summary>
    private (Member Member, Session Session)? GetCallerContext()
        => _sessionService.GetMemberAndSessionByConnectionId(Context.ConnectionId);

    /// <summary>
    /// Looks up an object and verifies ownership by the given member.
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

    private static ObjectInfo ToObjectInfo(SessionObject o) =>
        new(o.Id, o.CreatorMemberId, o.OwnerMemberId, o.Scope.ToString(), o.Data, o.Version);

    private static ObjectScope ParseScope(string scope) =>
        scope.Equals("Session", StringComparison.OrdinalIgnoreCase) ? ObjectScope.Session : ObjectScope.Member;

    private static Guid? ParseOwnerGuid(string? ownerMemberId) =>
        ownerMemberId != null && Guid.TryParse(ownerMemberId, out var parsed) ? parsed : null;

    /// <summary>
    /// Called when a client connects - add them to the AllClients group for broadcasts.
    /// </summary>
    public override async Task OnConnectedAsync()
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, AllClientsGroup);
        await base.OnConnectedAsync();
    }

    /// <summary>
    /// Creates a new session and joins as the server.
    /// </summary>
    /// <param name="aspectRatio">The aspect ratio (width/height) to lock for this session.</param>
    public async Task<CreateSessionResponse?> CreateSession(double aspectRatio)
    {
        var result = _sessionService.CreateSession(Context.ConnectionId, aspectRatio);

        if (!result.Success)
        {
            _logger.LogWarning("CreateSession failed: {Error}", result.ErrorMessage);
            return null;
        }

        var session = result.Session!;
        var creator = result.Creator!;

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
            session.AspectRatio
        );
    }

    /// <summary>
    /// Joins an existing session as a client.
    /// </summary>
    public async Task<JoinSessionResponse?> JoinSession(Guid sessionId)
    {
        var result = _sessionService.JoinSession(sessionId, Context.ConnectionId);
        if (!result.Success)
        {
            _logger.LogWarning("Failed to join session {SessionId}: {Error}", sessionId, result.ErrorMessage);
            return null;
        }

        var session = result.Session!;
        var member = result.Member!;

        await Groups.AddToGroupAsync(Context.ConnectionId, session.Id.ToString());

        var memberSequence = NextMemberSequence(member);
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Notify other members
        await Clients.OthersInGroup(session.Id.ToString()).SendAsync("OnMemberJoined",
            new MemberInfo(member.Id, member.Role.ToString(), member.JoinedAt),
            member.Id, memberSequence, serverTimestamp);

        _logger.LogInformation(
            "Member {MemberId} joined session {SessionName} ({SessionId})",
            member.Id, session.Name, session.Id);

        // Broadcast session list update to all connected clients
        await BroadcastSessionsChanged();

        // Return session state including existing objects
        var members = session.Members.Values.Select(m => new MemberInfo(m.Id, m.Role.ToString(), m.JoinedAt));
        var objects = session.Objects.Values.Select(ToObjectInfo);

        return new JoinSessionResponse(
            session.Id,
            session.Name,
            member.Id,
            member.Role.ToString(),
            members,
            objects,
            session.AspectRatio
        );
    }

    /// <summary>
    /// Leaves the current session.
    /// </summary>
    public async Task LeaveSession()
    {
        var result = _sessionService.LeaveSession(Context.ConnectionId);
        if (result == null)
        {
            _logger.LogWarning("Failed to leave session - member not found for connection {ConnectionId}", Context.ConnectionId);
            return;
        }

        // Handle object cleanup — gather remaining member IDs for round-robin distribution
        var remainingMemberIds = new List<Guid>();
        Session? session = null;
        if (!result.SessionDestroyed)
        {
            session = _sessionService.GetSession(result.SessionId);
            if (session != null)
            {
                remainingMemberIds = session.Members.Keys.ToList();
            }
        }
        var departureResult = _objectService.HandleMemberDeparture(
            result.SessionId, result.MemberId, remainingMemberIds);

        await Groups.RemoveFromGroupAsync(Context.ConnectionId, result.SessionId.ToString());

        if (!result.SessionDestroyed && session != null)
        {
            var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            // Notify remaining members with enriched departure info
            // Use departing member's ID as sender (this runs on their connection)
            await Clients.Group(result.SessionId.ToString()).SendAsync("OnMemberLeft",
                new MemberLeftInfo(
                    result.MemberId,
                    result.PromotedMember?.Id,
                    result.PromotedMember?.Role.ToString(),
                    departureResult.DeletedObjectIds,
                    departureResult.MigratedObjects
                ),
                result.MemberId, (long)0, serverTimestamp);

            if (result.PromotedMember != null)
            {
                _logger.LogInformation(
                    "Member {PromotedMemberId} promoted to Server in session {SessionName}. Migrated {MigratedCount} objects, deleted {DeletedCount} objects.",
                    result.PromotedMember.Id, result.SessionName,
                    departureResult.MigratedObjects.Count(),
                    departureResult.DeletedObjectIds.Count());
            }
        }
        else
        {
            _logger.LogInformation("Session {SessionName} ({SessionId}) destroyed - no members remaining",
                result.SessionName, result.SessionId);
        }

        _logger.LogInformation("Member {MemberId} left session {SessionName}", result.MemberId, result.SessionName);

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
        if (ctx == null)
        {
            _logger.LogWarning("CreateObject failed - member not found for connection {ConnectionId}", Context.ConnectionId);
            return null;
        }
        var (member, session) = ctx.Value;

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
        await Clients.OthersInGroup(member.SessionId.ToString()).SendAsync("OnObjectCreated",
            objectInfo, member.Id, memberSequence, serverTimestamp);

        _logger.LogDebug("Object {ObjectId} created in session by member {MemberId} (scope: {Scope})", obj.Id, member.Id, obj.Scope);

        return new CreateObjectResponse(objectInfo, memberSequence);
    }

    /// <summary>
    /// Updates multiple objects atomically.
    /// Only allows updates to objects owned by the caller.
    /// </summary>
    public async Task<UpdateObjectsResponse?> UpdateObjects(IEnumerable<ObjectUpdateRequest> updates, long? senderSequence = null, long? clientTimestamp = null, long? senderSendIntervalMs = null)
    {
        var ctx = GetCallerContext();
        if (ctx == null)
        {
            _logger.LogWarning("UpdateObjects failed - member not found for connection {ConnectionId}", Context.ConnectionId);
            return null;
        }
        var (member, session) = ctx.Value;

        // Filter to only objects owned by the caller
        var authorizedUpdates = new List<ObjectUpdate>();
        foreach (var u in updates)
        {
            var obj = _objectService.GetObject(member.SessionId, u.ObjectId);
            if (obj != null && obj.OwnerMemberId == member.Id)
            {
                authorizedUpdates.Add(new ObjectUpdate(u.ObjectId, u.Data, u.ExpectedVersion));
            }
        }

        var updatedObjects = _objectService.UpdateObjects(member.SessionId, authorizedUpdates);

        var objectInfos = updatedObjects.Select(ToObjectInfo).ToList();

        long memberSequence = 0;
        long serverTimestamp = 0;
        if (objectInfos.Count > 0)
        {
            memberSequence = NextMemberSequence(member);
            serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var requestDataByObjectId = authorizedUpdates
                .GroupBy(u => u.ObjectId)
                .ToDictionary(g => g.Key, g => g.Last().Data);
            var updateInfos = updatedObjects
                .Where(o => requestDataByObjectId.ContainsKey(o.Id))
                .Select(o => new ObjectUpdateInfo(o.Id, requestDataByObjectId[o.Id], o.Version))
                .ToList();
            // Broadcast to other members only — sender gets versions/RTT from the response
            await Clients.OthersInGroup(member.SessionId.ToString()).SendAsync("OnObjectsUpdated",
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
    /// Ownership safety: the local-first deletion is safe because ownership only changes
    /// via HandleMemberDeparture (when a member leaves). A member that is actively deleting
    /// objects is not departing, so no concurrent ownership migration can occur. The hub
    /// enforces ownership (OwnerMemberId == member.Id) and rejects the delete if ownership
    /// has changed, but the local Map would already be out of sync until reconciliation.
    /// If voluntary ownership transfer is ever added, local-first deletion would need to
    /// check ownership locally before removing, or defer removal until server confirms.
    /// </summary>
    public async Task<DeleteObjectResponse?> DeleteObject(Guid objectId)
    {
        var ctx = GetCallerContext();
        if (ctx == null)
        {
            _logger.LogWarning("DeleteObject failed - member not found for connection {ConnectionId}", Context.ConnectionId);
            return null;
        }
        var (member, _) = ctx.Value;

        // Verify ownership before deleting
        var obj = GetOwnedObject(member, objectId);
        if (obj == null)
            return null;

        var deletedObj = _objectService.DeleteObject(member.SessionId, objectId);
        if (deletedObj == null)
            return null;

        var memberSequence = NextMemberSequence(member);
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Broadcast to other members only — sender deleted locally before invoking (local-first).
        // Sender's own memberSequence is returned in the response, not via broadcast echo.
        await Clients.OthersInGroup(member.SessionId.ToString()).SendAsync("OnObjectDeleted",
            objectId, member.Id, memberSequence, serverTimestamp);
        _logger.LogDebug("Object {ObjectId} deleted from session {SessionId}", objectId, member.SessionId);

        return new DeleteObjectResponse(true, memberSequence);
    }

    /// <summary>
    /// Atomically deletes an object and creates replacement objects in a single broadcast.
    /// Used for splitting objects where all members need to see the deletion and creation together.
    /// </summary>
    public async Task<List<ObjectInfo>?> ReplaceObject(Guid deleteObjectId, List<Dictionary<string, object?>> replacements, string scope = "Session", string? ownerMemberId = null)
    {
        var ctx = GetCallerContext();
        if (ctx == null)
        {
            _logger.LogWarning("ReplaceObject failed - member not found");
            return null;
        }
        var (member, _) = ctx.Value;

        // Verify ownership of the object being replaced
        var existingObj = GetOwnedObject(member, deleteObjectId);
        if (existingObj == null)
            return null;

        var objectScope = ParseScope(scope);
        var ownerGuid = ParseOwnerGuid(ownerMemberId);

        // Create all replacements first (so we can roll back if any fail)
        var createdObjects = new List<SessionObject>();
        foreach (var data in replacements)
        {
            var obj = _objectService.CreateObject(member.SessionId, member.Id, objectScope, data, ownerGuid);
            if (obj == null)
            {
                // Roll back any objects we already created
                foreach (var created in createdObjects)
                {
                    _objectService.DeleteObject(member.SessionId, created.Id);
                }
                _logger.LogWarning("ReplaceObject failed - could not create replacement object");
                return null;
            }
            createdObjects.Add(obj);
        }

        // Delete the original object
        var deletedObj = _objectService.DeleteObject(member.SessionId, deleteObjectId);
        if (deletedObj == null)
        {
            // Roll back created objects
            foreach (var created in createdObjects)
            {
                _objectService.DeleteObject(member.SessionId, created.Id);
            }
            _logger.LogWarning("ReplaceObject failed - could not delete original object");
            return null;
        }

        var createdInfos = createdObjects.Select(ToObjectInfo).ToList();

        var memberSequence = NextMemberSequence(member);
        var serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Single atomic broadcast
        // NOTE: Cannot use OthersInGroup here — sender relies on this broadcast to
        // update its local object map (replaceObject is not local-first). Would need
        // to refactor replaceObject to process the invoke response locally first.
        await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectReplaced",
            new ObjectReplacedEvent(deleteObjectId, createdInfos),
            member.Id, memberSequence, serverTimestamp);

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
        if (ctx == null)
        {
            _logger.LogWarning("GetSessionState failed - member not found for connection {ConnectionId}", Context.ConnectionId);
            return null;
        }
        var (_, session) = ctx.Value;

        var members = session.Members.Values.Select(m => new MemberInfo(m.Id, m.Role.ToString(), m.JoinedAt));
        var objects = session.Objects.Values.Select(ToObjectInfo);

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
