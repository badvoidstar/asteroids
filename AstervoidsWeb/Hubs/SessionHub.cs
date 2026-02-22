using AstervoidsWeb.Configuration;
using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Hubs;

/// <summary>
/// SignalR hub for real-time session management and object synchronization.
/// </summary>
public class SessionHub : Hub
{
    private readonly ISessionService _sessionService;
    private readonly IObjectService _objectService;
    private readonly ILogger<SessionHub> _logger;
    private readonly SessionSettings _settings;

    // Group name for all connected clients to receive session list updates
    private const string AllClientsGroup = "AllClients";

    public SessionHub(
        ISessionService sessionService,
        IObjectService objectService,
        ILogger<SessionHub> logger,
        IOptions<SessionSettings> settings)
    {
        _sessionService = sessionService;
        _objectService = objectService;
        _logger = logger;
        _settings = settings.Value;
    }

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

        // Notify other members
        await Clients.OthersInGroup(session.Id.ToString()).SendAsync("OnMemberJoined", new MemberInfo(
            member.Id,
            member.Role.ToString(),
            member.JoinedAt
        ));

        _logger.LogInformation(
            "Member {MemberId} joined session {SessionName} ({SessionId})",
            member.Id, session.Name, session.Id);

        // Broadcast session list update to all connected clients
        await BroadcastSessionsChanged();

        // Return session state including existing objects
        var members = session.Members.Values.Select(m => new MemberInfo(m.Id, m.Role.ToString(), m.JoinedAt));
        var objects = session.Objects.Values.Select(o => new ObjectInfo(
            o.Id, o.CreatorMemberId, o.OwnerMemberId, o.Scope.ToString(), o.Data, o.Version));

        return new JoinSessionResponse(
            session.Id,
            session.Name,
            member.Id,
            member.Role.ToString(),
            members,
            objects,
            session.AspectRatio,
            session.GameStarted
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
        if (!result.SessionDestroyed)
        {
            var session = _sessionService.GetSession(result.SessionId);
            if (session != null)
            {
                remainingMemberIds = session.Members.Keys.ToList();
            }
        }
        var departureResult = _objectService.HandleMemberDeparture(
            result.SessionId, result.MemberId, remainingMemberIds);

        await Groups.RemoveFromGroupAsync(Context.ConnectionId, result.SessionId.ToString());

        if (!result.SessionDestroyed)
        {
            // Notify remaining members with enriched departure info
            await Clients.Group(result.SessionId.ToString()).SendAsync("OnMemberLeft", new MemberLeftInfo(
                result.MemberId,
                result.PromotedMember?.Id,
                result.PromotedMember?.Role.ToString(),
                departureResult.DeletedObjectIds,
                departureResult.MigratedObjects
            ));

            if (result.PromotedMember != null)
            {
                _logger.LogInformation(
                    "Member {PromotedMemberId} promoted to Server in session {SessionName}. Migrated {MigratedCount} objects, deleted {DeletedCount} objects.",
                    result.PromotedMember.Id, result.SessionName,
                    departureResult.MigratedObjects.Count(),
                    departureResult.DeletedObjectIds.Count());
            }

            // Emit OnObjectTypeEmpty for any types that became empty after departure
            foreach (var objectType in departureResult.AffectedTypes)
            {
                if (_objectService.GetObjectCountByType(result.SessionId, objectType) == 0)
                {
                    await Clients.Group(result.SessionId.ToString()).SendAsync("OnObjectTypeEmpty", objectType);
                }
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
            result.Sessions.Select(s => new SessionListItem(s.Id, s.Name, s.MemberCount, s.MaxMembers, s.CreatedAt, s.GameStarted)),
            result.MaxSessions,
            result.CanCreateSession
        );
    }

    /// <summary>
    /// Starts the game in the current session. Only the server can call this.
    /// </summary>
    public async Task<bool> StartGame()
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("StartGame failed - member not found for connection {ConnectionId}", Context.ConnectionId);
            return false;
        }

        if (member.Role != MemberRole.Server)
        {
            _logger.LogWarning("StartGame failed - member {MemberId} is not the server", member.Id);
            return false;
        }

        var session = _sessionService.GetSession(member.SessionId);
        if (session == null)
        {
            _logger.LogWarning("StartGame failed - session not found for member {MemberId}", member.Id);
            return false;
        }

        if (session.GameStarted)
        {
            _logger.LogWarning("StartGame failed - game already started in session {SessionId}", session.Id);
            return false;
        }

        session.GameStarted = true;
        _logger.LogInformation("Game started in session {SessionName} ({SessionId}) by server {MemberId}",
            session.Name, session.Id, member.Id);

        // Notify all session members that the game has started
        await Clients.Group(session.Id.ToString()).SendAsync("OnGameStarted", session.Id);

        // Broadcast session list update to all connected clients
        await BroadcastSessionsChanged();

        return true;
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
    /// </summary>
    public async Task<ObjectInfo?> CreateObject(Dictionary<string, object?>? data, string scope = "Member", string? ownerMemberId = null)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("CreateObject failed - member not found for connection {ConnectionId}", Context.ConnectionId);
            return null;
        }

        var objectScope = scope.Equals("Session", StringComparison.OrdinalIgnoreCase) 
            ? ObjectScope.Session 
            : ObjectScope.Member;

        Guid? ownerGuid = null;
        if (ownerMemberId != null && Guid.TryParse(ownerMemberId, out var parsed))
        {
            ownerGuid = parsed;
        }

        var obj = _objectService.CreateObject(member.SessionId, member.Id, objectScope, data, ownerGuid);
        if (obj == null)
        {
            _logger.LogWarning("CreateObject failed - could not create object in session");
            return null;
        }

        var objectInfo = new ObjectInfo(obj.Id, obj.CreatorMemberId, obj.OwnerMemberId, obj.Scope.ToString(), obj.Data, obj.Version);

        // Notify all members including sender
        await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectCreated", objectInfo);

        // Check if this type was just restored (count went from 0 to 1)
        var objectType = data?.TryGetValue("type", out var t) == true ? t?.ToString() : null;
        if (objectType != null && _objectService.GetObjectCountByType(member.SessionId, objectType) == 1)
        {
            await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectTypeRestored", objectType);
        }

        _logger.LogDebug("Object {ObjectId} created in session by member {MemberId} (scope: {Scope})", obj.Id, member.Id, objectScope);

        return objectInfo;
    }

    /// <summary>
    /// Updates multiple objects atomically.
    /// Only allows updates to objects owned by the caller (Server role can update any object).
    /// </summary>
    public async Task<IEnumerable<ObjectInfo>> UpdateObjects(IEnumerable<ObjectUpdateRequest> updates)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("UpdateObjects failed - member not found for connection {ConnectionId}", Context.ConnectionId);
            return Enumerable.Empty<ObjectInfo>();
        }

        var isServer = member.Role == MemberRole.Server;

        // Filter to only objects owned by the caller (Server can update any object)
        var authorizedUpdates = new List<ObjectUpdate>();
        foreach (var u in updates)
        {
            var obj = _objectService.GetObject(member.SessionId, u.ObjectId);
            if (obj != null && (obj.OwnerMemberId == member.Id || isServer))
            {
                authorizedUpdates.Add(new ObjectUpdate(u.ObjectId, u.Data, u.ExpectedVersion));
            }
        }

        var updatedObjects = _objectService.UpdateObjects(member.SessionId, authorizedUpdates);

        var objectInfos = updatedObjects.Select(o => new ObjectInfo(
            o.Id, o.CreatorMemberId, o.OwnerMemberId, o.Scope.ToString(), o.Data, o.Version)).ToList();

        if (objectInfos.Count > 0)
        {
            if (_settings.TrimUpdateMetadata)
            {
                var updateInfos = updatedObjects.Select(o => new ObjectUpdateInfo(o.Id, o.Data, o.Version)).ToList();
                await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectsUpdated", updateInfos);
            }
            else
            {
                await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectsUpdated", objectInfos);
            }
        }

        return objectInfos;
    }

    /// <summary>
    /// Deletes an object from the session.
    /// Only allows deletion of objects owned by the caller (Server role can delete any object).
    /// </summary>
    public async Task<bool> DeleteObject(Guid objectId)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("DeleteObject failed - member not found for connection {ConnectionId}", Context.ConnectionId);
            return false;
        }

        // Verify ownership before deleting (Server can delete any object)
        var obj = _objectService.GetObject(member.SessionId, objectId);
        if (obj == null)
            return false;

        if (obj.OwnerMemberId != member.Id && member.Role != MemberRole.Server)
        {
            _logger.LogWarning("DeleteObject rejected - member {MemberId} does not own object {ObjectId}", member.Id, objectId);
            return false;
        }

        var deletedObj = _objectService.DeleteObject(member.SessionId, objectId);
        if (deletedObj != null)
        {
            await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectDeleted", objectId);
            _logger.LogDebug("Object {ObjectId} deleted from session {SessionId}", objectId, member.SessionId);

            // Check if this type is now empty
            var objectType = deletedObj.Data.TryGetValue("type", out var t) ? t?.ToString() : null;
            if (objectType != null && _objectService.GetObjectCountByType(member.SessionId, objectType) == 0)
            {
                await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectTypeEmpty", objectType);
            }
        }

        return deletedObj != null;
    }

    /// <summary>
    /// Atomically deletes an object and creates replacement objects in a single broadcast.
    /// Used for splitting objects where all members need to see the deletion and creation together.
    /// </summary>
    public async Task<List<ObjectInfo>?> ReplaceObject(Guid deleteObjectId, List<Dictionary<string, object?>> replacements, string scope = "Session", string? ownerMemberId = null)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("ReplaceObject failed - member not found");
            return null;
        }

        // Verify ownership of the object being replaced (Server can replace any object)
        var existingObj = _objectService.GetObject(member.SessionId, deleteObjectId);
        if (existingObj == null)
            return null;

        if (existingObj.OwnerMemberId != member.Id && member.Role != MemberRole.Server)
        {
            _logger.LogWarning("ReplaceObject rejected - member {MemberId} does not own object {ObjectId}", member.Id, deleteObjectId);
            return null;
        }

        var objectScope = scope.Equals("Session", StringComparison.OrdinalIgnoreCase)
            ? ObjectScope.Session
            : ObjectScope.Member;

        Guid? ownerGuid = null;
        if (ownerMemberId != null && Guid.TryParse(ownerMemberId, out var parsed))
        {
            ownerGuid = parsed;
        }

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

        var createdInfos = createdObjects.Select(o =>
            new ObjectInfo(o.Id, o.CreatorMemberId, o.OwnerMemberId, o.Scope.ToString(), o.Data, o.Version)).ToList();

        // Single atomic broadcast
        await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectReplaced",
            new ObjectReplacedEvent(deleteObjectId, createdInfos));

        _logger.LogDebug("Object {ObjectId} replaced with {Count} objects in session {SessionId}",
            deleteObjectId, createdObjects.Count, member.SessionId);

        // Check type empty/restored
        var deletedType = deletedObj.Data.TryGetValue("type", out var dt) ? dt?.ToString() : null;
        if (deletedType != null && _objectService.GetObjectCountByType(member.SessionId, deletedType) == 0)
        {
            await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectTypeEmpty", deletedType);
        }
        foreach (var created in createdObjects)
        {
            var createdType = created.Data.TryGetValue("type", out var ct) ? ct?.ToString() : null;
            if (createdType != null && _objectService.GetObjectCountByType(member.SessionId, createdType) == 1)
            {
                await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectTypeRestored", createdType);
            }
        }

        return createdInfos;
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
    /// Reports that a bullet hit an asteroid. Broadcasts to all session members
    /// so the asteroid owner can process the collision.
    /// </summary>
    public async Task ReportBulletHit(Guid asteroidObjectId, Guid bulletObjectId)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("ReportBulletHit failed - member not found");
            return;
        }

        // Verify caller owns the bullet and asteroid exists
        var bullet = _objectService.GetObject(member.SessionId, bulletObjectId);
        if (bullet == null || bullet.OwnerMemberId != member.Id)
        {
            _logger.LogWarning("ReportBulletHit rejected - member {MemberId} does not own bullet {BulletId}", member.Id, bulletObjectId);
            return;
        }

        var asteroid = _objectService.GetObject(member.SessionId, asteroidObjectId);
        if (asteroid == null)
        {
            _logger.LogWarning("ReportBulletHit rejected - asteroid {AsteroidId} not found", asteroidObjectId);
            return;
        }

        await Clients.Group(member.SessionId.ToString()).SendAsync("OnBulletHitReported",
            new BulletHitReport(asteroidObjectId, bulletObjectId, member.Id));
    }

    /// <summary>
    /// Confirms that a bullet hit was accepted by the asteroid owner.
    /// Broadcasts to all session members so the bullet owner can handle cleanup.
    /// Caller must not be the bullet owner (the asteroid owner confirms).
    /// </summary>
    public async Task ConfirmBulletHit(Guid bulletObjectId, Guid bulletOwnerMemberId, int points, string asteroidSize)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("ConfirmBulletHit failed - member not found");
            return;
        }

        // Caller should be the asteroid owner, not the bullet owner
        if (member.Id == bulletOwnerMemberId)
        {
            _logger.LogWarning("ConfirmBulletHit rejected - caller {MemberId} is the bullet owner", member.Id);
            return;
        }

        await Clients.Group(member.SessionId.ToString()).SendAsync("OnBulletHitConfirmed",
            new BulletHitConfirmation(bulletObjectId, bulletOwnerMemberId, points, asteroidSize));
    }

    /// <summary>
    /// Rejects a bullet hit because the asteroid was already destroyed.
    /// Broadcasts to all session members so the bullet owner can un-hide the bullet.
    /// Caller must not be the bullet owner (the asteroid owner rejects).
    /// </summary>
    public async Task RejectBulletHit(Guid bulletObjectId, Guid bulletOwnerMemberId)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("RejectBulletHit failed - member not found");
            return;
        }

        // Caller should be the asteroid owner, not the bullet owner
        if (member.Id == bulletOwnerMemberId)
        {
            _logger.LogWarning("RejectBulletHit rejected - caller {MemberId} is the bullet owner", member.Id);
            return;
        }

        await Clients.Group(member.SessionId.ToString()).SendAsync("OnBulletHitRejected",
            new BulletHitRejection(bulletObjectId, bulletOwnerMemberId));
    }

    /// <summary>
    /// Reports score points earned by a player. Broadcasts to all session members
    /// so the authority can update the shared score.
    /// </summary>
    public async Task ReportScore(int points)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("ReportScore failed - member not found");
            return;
        }

        await Clients.Group(member.SessionId.ToString()).SendAsync("OnScoreReported",
            new ScoreReport(member.Id, points));
    }

    /// <summary>
    /// Reports that the caller's ship was hit by an asteroid.
    /// Broadcasts to all session members so the GameState owner can decrement lives.
    /// </summary>
    public async Task ReportShipHit()
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("ReportShipHit failed - member not found");
            return;
        }

        await Clients.Group(member.SessionId.ToString()).SendAsync("OnShipHitReported",
            new ShipHitReport(member.Id));
    }
}

// Response DTOs
public record CreateSessionResponse(Guid SessionId, string SessionName, Guid MemberId, string Role, double AspectRatio);
public record JoinSessionResponse(
    Guid SessionId,
    string SessionName,
    Guid MemberId,
    string Role,
    IEnumerable<MemberInfo> Members,
    IEnumerable<ObjectInfo> Objects,
    double AspectRatio,
    bool GameStarted
);
public record MemberInfo(Guid Id, string Role, DateTime JoinedAt);
public record MemberLeftInfo(
    Guid MemberId,
    Guid? PromotedMemberId,
    string? PromotedRole,
    IEnumerable<Guid> DeletedObjectIds,
    IEnumerable<ObjectMigration> MigratedObjects
);
public record SessionListItem(Guid Id, string Name, int MemberCount, int MaxMembers, DateTime CreatedAt, bool GameStarted);
public record ActiveSessionsResponse(IEnumerable<SessionListItem> Sessions, int MaxSessions, bool CanCreateSession);
public record ObjectInfo(Guid Id, Guid CreatorMemberId, Guid OwnerMemberId, string Scope, Dictionary<string, object?> Data, long Version);
public record ObjectUpdateInfo(Guid Id, Dictionary<string, object?> Data, long Version);
public record ObjectUpdateRequest(Guid ObjectId, Dictionary<string, object?> Data, long? ExpectedVersion = null);
public record BulletHitReport(Guid AsteroidObjectId, Guid BulletObjectId, Guid ReporterMemberId);
public record BulletHitConfirmation(Guid BulletObjectId, Guid BulletOwnerMemberId, int Points, string AsteroidSize);
public record BulletHitRejection(Guid BulletObjectId, Guid BulletOwnerMemberId);
public record ObjectReplacedEvent(Guid DeletedObjectId, List<ObjectInfo> CreatedObjects);
public record ShipHitReport(Guid ReporterMemberId);
public record ScoreReport(Guid ReporterMemberId, int Points);
