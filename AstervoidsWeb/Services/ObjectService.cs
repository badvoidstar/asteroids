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

    public SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, ObjectScope scope, Dictionary<string, object?>? data = null)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return null;

        if (!session.Members.TryGetValue(creatorMemberId, out _))
            return null;

        var obj = new SessionObject
        {
            SessionId = sessionId,
            CreatorMemberId = creatorMemberId,
            OwnerMemberId = creatorMemberId,
            Scope = scope,
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

    public SessionObject? DeleteObject(Guid sessionId, Guid objectId)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return null;

        return session.Objects.TryRemove(objectId, out var obj) ? obj : null;
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

    public int GetObjectCountByType(Guid sessionId, string type)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return 0;

        return session.Objects.Values.Count(obj =>
            obj.Data.TryGetValue("type", out var t) && string.Equals(t?.ToString(), type, StringComparison.Ordinal));
    }

    public MemberDepartureResult HandleMemberDeparture(Guid sessionId, Guid departingMemberId, Guid? newOwnerId)
    {
        var session = _sessionService.GetSession(sessionId);
        if (session == null)
            return new MemberDepartureResult([], [], []);

        var deletedIds = new List<Guid>();
        var migratedIds = new List<Guid>();
        var affectedTypes = new HashSet<string>();

        foreach (var obj in session.Objects.Values.ToList())
        {
            if (obj.OwnerMemberId != departingMemberId)
                continue;

            var objectType = obj.Data.TryGetValue("type", out var t) ? t?.ToString() : null;

            if (obj.Scope == ObjectScope.Member)
            {
                // Member-scoped: delete
                if (session.Objects.TryRemove(obj.Id, out _))
                {
                    deletedIds.Add(obj.Id);
                    if (objectType != null) affectedTypes.Add(objectType);
                }
            }
            else if (obj.Scope == ObjectScope.Session && newOwnerId.HasValue)
            {
                // Session-scoped: migrate ownership
                obj.OwnerMemberId = newOwnerId.Value;
                obj.Version++;
                obj.UpdatedAt = DateTime.UtcNow;
                migratedIds.Add(obj.Id);
            }
        }

        return new MemberDepartureResult(deletedIds, migratedIds, affectedTypes);
    }
}
