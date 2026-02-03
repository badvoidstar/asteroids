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
    /// Creates a new session and joins as the server.
    /// </summary>
    public async Task<CreateSessionResponse> CreateSession()
    {
        var (session, creator) = _sessionService.CreateSession(Context.ConnectionId);

        await Groups.AddToGroupAsync(Context.ConnectionId, session.Id.ToString());

        _logger.LogInformation(
            "Session {SessionName} ({SessionId}) created by member {MemberId}",
            session.Name, session.Id, creator.Id);

        return new CreateSessionResponse(
            session.Id,
            session.Name,
            creator.Id,
            creator.Role.ToString()
        );
    }

    /// <summary>
    /// Joins an existing session as a client.
    /// </summary>
    public async Task<JoinSessionResponse?> JoinSession(Guid sessionId)
    {
        var result = _sessionService.JoinSession(sessionId, Context.ConnectionId);
        if (result == null)
        {
            _logger.LogWarning("Failed to join session {SessionId} - not found", sessionId);
            return null;
        }

        var (session, member) = result.Value;

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

        // Return session state including existing objects
        var members = session.Members.Values.Select(m => new MemberInfo(m.Id, m.Role.ToString(), m.JoinedAt));
        var objects = session.Objects.Values.Select(o => new ObjectInfo(
            o.Id, o.CreatorMemberId, o.AffiliatedRole.ToString(), o.Data, o.Version));

        return new JoinSessionResponse(
            session.Id,
            session.Name,
            member.Id,
            member.Role.ToString(),
            members,
            objects
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

        await Groups.RemoveFromGroupAsync(Context.ConnectionId, result.SessionId.ToString());

        if (!result.SessionDestroyed)
        {
            // Notify remaining members
            await Clients.Group(result.SessionId.ToString()).SendAsync("OnMemberLeft", new MemberLeftInfo(
                result.MemberId,
                result.PromotedMember?.Id,
                result.PromotedMember?.Role.ToString(),
                result.AffectedObjectIds
            ));

            if (result.PromotedMember != null)
            {
                _logger.LogInformation(
                    "Member {PromotedMemberId} promoted to Server in session {SessionName}",
                    result.PromotedMember.Id, result.SessionName);
            }
        }
        else
        {
            _logger.LogInformation("Session {SessionName} ({SessionId}) destroyed - no members remaining",
                result.SessionName, result.SessionId);
        }

        _logger.LogInformation("Member {MemberId} left session {SessionName}", result.MemberId, result.SessionName);
    }

    /// <summary>
    /// Gets all active sessions.
    /// </summary>
    public IEnumerable<SessionListItem> GetActiveSessions()
    {
        return _sessionService.GetActiveSessions()
            .Select(s => new SessionListItem(s.Id, s.Name, s.MemberCount, s.CreatedAt));
    }

    /// <summary>
    /// Creates a new synchronized object in the session.
    /// </summary>
    public async Task<ObjectInfo?> CreateObject(Dictionary<string, object?>? data)
    {
        var member = _sessionService.GetMemberByConnectionId(Context.ConnectionId);
        if (member == null)
        {
            _logger.LogWarning("CreateObject failed - member not found for connection {ConnectionId}", Context.ConnectionId);
            return null;
        }

        var obj = _objectService.CreateObject(member.SessionId, member.Id, data);
        if (obj == null)
        {
            _logger.LogWarning("CreateObject failed - could not create object in session");
            return null;
        }

        var objectInfo = new ObjectInfo(obj.Id, obj.CreatorMemberId, obj.AffiliatedRole.ToString(), obj.Data, obj.Version);

        // Notify all members including sender
        await Clients.Group(member.SessionId.ToString()).SendAsync("OnObjectCreated", objectInfo);

        _logger.LogDebug("Object {ObjectId} created in session by member {MemberId}", obj.Id, member.Id);

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
            o.Id, o.CreatorMemberId, o.AffiliatedRole.ToString(), o.Data, o.Version)).ToList();

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

        var deleted = _objectService.DeleteObject(session.Id, objectId);
        if (deleted)
        {
            await Clients.Group(session.Id.ToString()).SendAsync("OnObjectDeleted", objectId);
            _logger.LogDebug("Object {ObjectId} deleted from session {SessionId}", objectId, session.Id);
        }

        return deleted;
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

        // Clean up session membership
        await LeaveSession();

        await base.OnDisconnectedAsync(exception);
    }
}

// Response DTOs
public record CreateSessionResponse(Guid SessionId, string SessionName, Guid MemberId, string Role);
public record JoinSessionResponse(
    Guid SessionId,
    string SessionName,
    Guid MemberId,
    string Role,
    IEnumerable<MemberInfo> Members,
    IEnumerable<ObjectInfo> Objects
);
public record MemberInfo(Guid Id, string Role, DateTime JoinedAt);
public record MemberLeftInfo(Guid MemberId, Guid? PromotedMemberId, string? PromotedRole, IEnumerable<Guid> AffectedObjectIds);
public record SessionListItem(Guid Id, string Name, int MemberCount, DateTime CreatedAt);
public record ObjectInfo(Guid Id, Guid CreatorMemberId, string AffiliatedRole, Dictionary<string, object?> Data, long Version);
public record ObjectUpdateRequest(Guid ObjectId, Dictionary<string, object?> Data, long? ExpectedVersion = null);
