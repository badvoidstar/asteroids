using AstervoidsWeb.Configuration;
using AstervoidsWeb.Models;
using Microsoft.Extensions.Options;
using System.Diagnostics.CodeAnalysis;

namespace AstervoidsWeb.Services;

/// <summary>
/// In-memory implementation of object management.
/// </summary>
public class ObjectService : IObjectService
{
    private readonly ISessionService _sessionService;
    private readonly bool _distributeOrphanedObjects;

    public ObjectService(ISessionService sessionService)
    {
        _sessionService = sessionService;
        _distributeOrphanedObjects = true;
    }

    public ObjectService(ISessionService sessionService, IOptions<SessionSettings> settings)
    {
        _sessionService = sessionService;
        _distributeOrphanedObjects = settings.Value.DistributeOrphanedObjects;
    }

    public SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, ObjectScope scope, Dictionary<string, object?>? data = null, Guid? ownerMemberId = null)
    {
        if (!TryGetSession(sessionId, out var session))
            return null;

        var effectiveOwner = ownerMemberId ?? creatorMemberId;
        if (!AllMembersExist(session, creatorMemberId, effectiveOwner))
            return null;

        var obj = new SessionObject
        {
            SessionId = sessionId,
            CreatorMemberId = creatorMemberId,
            OwnerMemberId = effectiveOwner,
            Scope = scope,
            Data = data ?? new Dictionary<string, object?>()
        };

        session.Objects.TryAdd(obj.Id, obj);
        return obj;
    }

    public SessionObject? UpdateObject(Guid sessionId, Guid objectId, Dictionary<string, object?> data, long? expectedVersion = null)
    {
        if (!TryGetSession(sessionId, out var session))
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
        if (!TryGetSession(sessionId, out var session))
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
        if (!TryGetSession(sessionId, out var session))
            return null;

        return session.Objects.TryRemove(objectId, out var obj) ? obj : null;
    }

    public IEnumerable<SessionObject> GetSessionObjects(Guid sessionId)
    {
        if (!TryGetSession(sessionId, out var session))
            return Enumerable.Empty<SessionObject>();

        return session.Objects.Values.ToList();
    }

    public SessionObject? GetObject(Guid sessionId, Guid objectId)
    {
        if (!TryGetSession(sessionId, out var session))
            return null;

        return session.Objects.TryGetValue(objectId, out var obj) ? obj : null;
    }

    /// <summary>
    /// Handles object cleanup when a member departs. This is the ONLY path through which
    /// object ownership changes. Member-scoped objects are deleted; session-scoped objects
    /// are redistributed via round-robin to remaining members.
    /// Frontend local-first patterns (deleteObject) and response-first patterns (createObject)
    /// are safe because they cannot race with this: a member actively creating/deleting
    /// objects is not departing. If voluntary ownership transfer is ever added, those
    /// patterns would need to account for concurrent ownership changes.
    /// </summary>
    public MemberDepartureResult HandleMemberDeparture(Guid sessionId, Guid departingMemberId, IList<Guid> remainingMemberIds)
    {
        if (!TryGetSession(sessionId, out var session))
            return new MemberDepartureResult([], []);

        var deletedIds = new List<Guid>();
        var migratedObjects = new List<ObjectMigration>();
        var roundRobinIndex = 0;

        foreach (var obj in session.Objects.Values.ToList())
        {
            if (obj.OwnerMemberId != departingMemberId)
                continue;

            if (obj.Scope == ObjectScope.Member)
            {
                // Member-scoped: delete
                if (session.Objects.TryRemove(obj.Id, out _))
                {
                    deletedIds.Add(obj.Id);
                }
            }
            else if (obj.Scope == ObjectScope.Session && remainingMemberIds.Count > 0)
            {
                // Session-scoped: distribute across remaining members
                Guid newOwnerId;
                if (_distributeOrphanedObjects && remainingMemberIds.Count > 1)
                {
                    newOwnerId = remainingMemberIds[roundRobinIndex % remainingMemberIds.Count];
                    roundRobinIndex++;
                }
                else
                {
                    newOwnerId = remainingMemberIds[0];
                }

                obj.OwnerMemberId = newOwnerId;
                obj.Version++;
                obj.UpdatedAt = DateTime.UtcNow;
                migratedObjects.Add(new ObjectMigration(obj.Id, newOwnerId, obj.Version));
            }
        }

        return new MemberDepartureResult(deletedIds, migratedObjects);
    }

    private bool TryGetSession(Guid sessionId, [NotNullWhen(true)] out Session? session)
    {
        session = _sessionService.GetSession(sessionId);
        return session != null;
    }

    private static bool AllMembersExist(Session session, params Guid[] memberIds) =>
        memberIds.All(session.Members.ContainsKey);
}
