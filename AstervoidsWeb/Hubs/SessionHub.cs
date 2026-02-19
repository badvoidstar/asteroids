using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using Microsoft.AspNetCore.SignalR;

namespace AstervoidsWeb.Hubs;

/// <summary>
/// SignalR hub for real-time session management and object synchronization.
/// </summary>
public class SessionHub : Hub
{
    private readonly ISessionService _sessionService;
    private readonly IObjectService _objectService;
    private readonly ILogger<SessionHub> _logger;

    // Group name for all connected clients to receive session list updates
    private const string AllClientsGroup = "AllClients";

    public SessionHub(
        ISessionService sessionService,
        IObjectService objectService,
        ILogger<SessionHub> logger)
    {
        _sessionService = sessionService;
        _objectService = objectService;
        _logger = logger;
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
    public async Task<ObjectInfo?> CreateObject(Dictionary<string, object?>? data, string scope = "Member")
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

        var obj = _objectService.CreateObject(member.SessionId, member.Id, objectScope, data);
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
    /// </summary>
    public async Task<IEnumerable<ObjectInfo>> UpdateObjects(IEnumerable<ObjectUpdateRequest> updates)
    {
        var session = _sessionService.GetSessionByConnectionId(Context.ConnectionId);
        if (session == null)
        {
            _logger.LogWarning("UpdateObjects failed - session not found for connection {ConnectionId}", Context.ConnectionId);
            return Enumerable.Empty<ObjectInfo>();
        }

        var objectUpdates = updates.Select(u => new ObjectUpdate(u.ObjectId, u.Data, u.ExpectedVersion));
        var updatedObjects = _objectService.UpdateObjects(session.Id, objectUpdates);

        var objectInfos = updatedObjects.Select(o => new ObjectInfo(
            o.Id, o.CreatorMemberId, o.OwnerMemberId, o.Scope.ToString(), o.Data, o.Version)).ToList();

        if (objectInfos.Count > 0)
        {
            // Notify all members including sender
            await Clients.Group(session.Id.ToString()).SendAsync("OnObjectsUpdated", objectInfos);
        }

        return objectInfos;
    }

    /// <summary>
    /// Deletes an object from the session.
    /// </summary>
    public async Task<bool> DeleteObject(Guid objectId)
    {
        var session = _sessionService.GetSessionByConnectionId(Context.ConnectionId);
        if (session == null)
        {
            _logger.LogWarning("DeleteObject failed - session not found for connection {ConnectionId}", Context.ConnectionId);
            return false;
        }

        var deletedObj = _objectService.DeleteObject(session.Id, objectId);
        if (deletedObj != null)
        {
            await Clients.Group(session.Id.ToString()).SendAsync("OnObjectDeleted", objectId);
            _logger.LogDebug("Object {ObjectId} deleted from session {SessionId}", objectId, session.Id);

            // Check if this type is now empty
            var objectType = deletedObj.Data.TryGetValue("type", out var t) ? t?.ToString() : null;
            if (objectType != null && _objectService.GetObjectCountByType(session.Id, objectType) == 0)
            {
                await Clients.Group(session.Id.ToString()).SendAsync("OnObjectTypeEmpty", objectType);
            }
        }

        return deletedObj != null;
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

        await Clients.Group(member.SessionId.ToString()).SendAsync("OnBulletHitReported",
            new BulletHitReport(asteroidObjectId, bulletObjectId, member.Id));
    }

    /// <summary>
    /// Confirms that a bullet hit was accepted by the asteroid owner.
    /// Broadcasts to all session members so the bullet owner can handle cleanup.
    /// </summary>
    public async Task ConfirmBulletHit(Guid bulletObjectId, Guid bulletOwnerMemberId, int points, string asteroidSize, double asteroidX, double asteroidY, double asteroidVelocityX, double asteroidVelocityY, double asteroidRadius)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("ConfirmBulletHit failed - member not found");
            return;
        }

        await Clients.Group(member.SessionId.ToString()).SendAsync("OnBulletHitConfirmed",
            new BulletHitConfirmation(bulletObjectId, bulletOwnerMemberId, points, asteroidSize, asteroidX, asteroidY, asteroidVelocityX, asteroidVelocityY, asteroidRadius));
    }

    /// <summary>
    /// Rejects a bullet hit because the asteroid was already destroyed.
    /// Broadcasts to all session members so the bullet owner can un-hide the bullet.
    /// </summary>
    public async Task RejectBulletHit(Guid bulletObjectId, Guid bulletOwnerMemberId)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("RejectBulletHit failed - member not found");
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
public record ObjectUpdateRequest(Guid ObjectId, Dictionary<string, object?> Data, long? ExpectedVersion = null);
public record BulletHitReport(Guid AsteroidObjectId, Guid BulletObjectId, Guid ReporterMemberId);
public record BulletHitConfirmation(Guid BulletObjectId, Guid BulletOwnerMemberId, int Points, string AsteroidSize, double AsteroidX, double AsteroidY, double AsteroidVelocityX, double AsteroidVelocityY, double AsteroidRadius);
public record BulletHitRejection(Guid BulletObjectId, Guid BulletOwnerMemberId);
public record ShipHitReport(Guid ReporterMemberId);
public record ScoreReport(Guid ReporterMemberId, int Points);
