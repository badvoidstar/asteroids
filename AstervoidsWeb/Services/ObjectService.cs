using AstervoidsWeb.Models;

namespace AstervoidsWeb.Services;

/// <summary>
/// In-memory implementation of object management.
/// </summary>
public class ObjectService : IObjectService
{
    private readonly ISessionService _sessionService;

    public ObjectService(ISessionService sessionService)
    {
        _sessionService = sessionService;
    }

    public SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, Dictionary<string, object?>? data = null)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return null;

        if (!session.Members.TryGetValue(creatorMemberId, out var creator))
            return null;

        var obj = new SessionObject
        {
            SessionId = sessionId,
            CreatorMemberId = creatorMemberId,
            AffiliatedRole = creator.Role,
            Data = data ?? new Dictionary<string, object?>()
        };

        session.Objects.TryAdd(obj.Id, obj);
        return obj;
    }

    public SessionObject? UpdateObject(Guid sessionId, Guid objectId, Dictionary<string, object?> data, long? expectedVersion = null)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return null;

        if (!session.Objects.TryGetValue(objectId, out var obj))
            return null;

        // Optimistic concurrency check
        if (expectedVersion.HasValue && obj.Version != expectedVersion.Value)
            return null;

        // Merge data
        foreach (var kvp in data)
        {
            obj.Data[kvp.Key] = kvp.Value;
        }

        obj.Version++;
        obj.UpdatedAt = DateTime.UtcNow;

        return obj;
    }

    public IEnumerable<SessionObject> UpdateObjects(Guid sessionId, IEnumerable<ObjectUpdate> updates)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return Enumerable.Empty<SessionObject>();

        var results = new List<SessionObject>();

        // Process all updates - this is atomic from the caller's perspective
        // since we process them all before returning
        foreach (var update in updates)
        {
            if (!session.Objects.TryGetValue(update.ObjectId, out var obj))
                continue;

            // Optimistic concurrency check
            if (update.ExpectedVersion.HasValue && obj.Version != update.ExpectedVersion.Value)
                continue;

            // Merge data
            foreach (var kvp in update.Data)
            {
                obj.Data[kvp.Key] = kvp.Value;
            }

            obj.Version++;
            obj.UpdatedAt = DateTime.UtcNow;
            results.Add(obj);
        }

        return results;
    }

    public bool DeleteObject(Guid sessionId, Guid objectId)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return false;

        return session.Objects.TryRemove(objectId, out _);
    }

    public IEnumerable<SessionObject> GetSessionObjects(Guid sessionId)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return Enumerable.Empty<SessionObject>();

        return session.Objects.Values.ToList();
    }

    public SessionObject? GetObject(Guid sessionId, Guid objectId)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return null;

        return session.Objects.TryGetValue(objectId, out var obj) ? obj : null;
    }

    public void TransferServerAffiliation(Guid sessionId, Guid oldServerId, Guid newServerId)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return;

        // Update all objects that were affiliated with the server role
        // The affiliation stays as Server role, but now points to the new server member
        // Note: AffiliatedRole remains Server, we don't change the role itself
        // The objects created by the old server remain "server objects"
        foreach (var obj in session.Objects.Values)
        {
            if (obj.CreatorMemberId == oldServerId && obj.AffiliatedRole == MemberRole.Server)
            {
                obj.UpdatedAt = DateTime.UtcNow;
                obj.Version++;
            }
        }
    }
}
