using AstervoidsWeb.Configuration;
using AstervoidsWeb.Models;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Services;

/// <summary>
/// In-memory implementation of object management.
///
/// Correctness guarantees
/// ──────────────────────
/// • All object mutations (create, update, delete, replace) execute under the session's
///   <c>Session.SyncRoot</c> lock, making version checks, ownership checks, and data
///   writes atomic.
/// • <c>SessionObject.Data</c> is replaced with a new dictionary on every mutation
///   (copy-on-write) so that snapshot reads outside the lock observe a stable copy.
/// • Batch update (<see cref="UpdateObjects"/>) skips objects not owned by the caller.
///   Each individual object mutation is still fully atomic.
/// • Member departure and object ownership migration are handled atomically inside
///   <see cref="SessionService.LeaveSession"/>, not here.
/// </summary>
public class ObjectService : IObjectService
{
    private readonly ISessionService _sessionService;

    public ObjectService(ISessionService sessionService)
    {
        _sessionService = sessionService;
    }

    public ObjectService(ISessionService sessionService, IOptions<SessionSettings> settings)
    {
        _sessionService = sessionService;
        // DistributeOrphanedObjects is now used by SessionService directly; no field needed here.
    }

    /// <summary>
    /// Validates that a session exists. Returns the session if valid, or null if not found.
    /// </summary>
    private Session? GetValidSession(Guid sessionId)
        => _sessionService.GetSession(sessionId);

    public SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, ObjectScope scope, Dictionary<string, object?>? data = null, Guid? ownerMemberId = null)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return null;

            if (!session.Members.TryGetValue(creatorMemberId, out _))
                return null;

            var effectiveOwner = ownerMemberId ?? creatorMemberId;
            if (effectiveOwner != creatorMemberId && !session.Members.TryGetValue(effectiveOwner, out _))
                return null;

            var obj = new SessionObject
            {
                SessionId = sessionId,
                CreatorMemberId = creatorMemberId,
                OwnerMemberId = effectiveOwner,
                Scope = scope,
                // Clone the caller-supplied data to prevent the caller mutating it after the fact
                Data = data != null ? new Dictionary<string, object?>(data) : new Dictionary<string, object?>()
            };

            session.Objects.TryAdd(obj.Id, obj);
            return obj;
        }
    }

    /// <summary>
    /// Updates a single object without ownership enforcement.
    /// Used internally and by tests.  The hub uses <see cref="UpdateObjects"/> which
    /// enforces ownership inside the lock.
    /// </summary>
    public SessionObject? UpdateObject(Guid sessionId, Guid objectId, Dictionary<string, object?> data)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (!session.Objects.TryGetValue(objectId, out var obj))
                return null;

            ApplyUpdate(obj, data);
            return obj;
        }
    }

    /// <summary>
    /// Batch-updates multiple objects owned by <paramref name="ownerMemberId"/>.
    ///
    /// Objects not owned by the caller are silently skipped.  Successfully updated
    /// objects are returned.
    /// </summary>
    public IEnumerable<SessionObject> UpdateObjects(Guid sessionId, Guid ownerMemberId, IEnumerable<ObjectUpdate> updates)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return Enumerable.Empty<SessionObject>();

        var results = new List<SessionObject>();

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return results;

            foreach (var update in updates)
            {
                if (!session.Objects.TryGetValue(update.ObjectId, out var obj))
                    continue;

                // Ownership check inside the lock — not TOCTOU-prone
                if (obj.OwnerMemberId != ownerMemberId)
                    continue;

                ApplyUpdate(obj, update.Data);
                results.Add(obj);
            }
        }

        return results;
    }

    /// <summary>
    /// Deletes an object, enforcing that <paramref name="ownerMemberId"/> is the current
    /// owner.  The ownership check and deletion are atomic under <c>session.SyncRoot</c>.
    /// </summary>
    public SessionObject? DeleteObject(Guid sessionId, Guid objectId, Guid ownerMemberId)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (!session.Objects.TryGetValue(objectId, out var obj))
                return null;

            if (obj.OwnerMemberId != ownerMemberId)
                return null;

            return session.Objects.TryRemove(objectId, out _) ? obj : null;
        }
    }

    /// <inheritdoc/>
    public IReadOnlyList<SessionObject>? ReplaceObject(
        Guid sessionId,
        Guid deleteObjectId,
        Guid ownerMemberId,
        IReadOnlyList<ReplacementObjectSpec> replacements)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return null;

            // Verify ownership of the object being replaced — atomic with the delete below
            if (!session.Objects.TryGetValue(deleteObjectId, out var objToDelete))
                return null;
            if (objToDelete.OwnerMemberId != ownerMemberId)
                return null;

            // Determine effective owner for replacements (must be a current member)
            var created = new List<SessionObject>(replacements.Count);
            foreach (var spec in replacements)
            {
                var effectiveOwner = spec.OwnerOverride.HasValue
                    && session.Members.ContainsKey(spec.OwnerOverride.Value)
                    ? spec.OwnerOverride.Value
                    : ownerMemberId;

                var obj = new SessionObject
                {
                    SessionId = sessionId,
                    CreatorMemberId = ownerMemberId,
                    OwnerMemberId = effectiveOwner,
                    Scope = spec.Scope,
                    // Clone data so spec mutations after the call don't corrupt the stored object
                    Data = new Dictionary<string, object?>(spec.Data)
                };
                session.Objects.TryAdd(obj.Id, obj);
                created.Add(obj);
            }

            // Delete the original — we already verified ownership above
            session.Objects.TryRemove(deleteObjectId, out _);

            return created;
        }
    }

    public IEnumerable<SessionObject> GetSessionObjects(Guid sessionId)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return Enumerable.Empty<SessionObject>();

        return session.Objects.Values.ToList();
    }

    public SessionObject? GetObject(Guid sessionId, Guid objectId)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        return session.Objects.TryGetValue(objectId, out var obj) ? obj : null;
    }

    // ── Private helpers ────────────────────────────────────────────────────────────

    /// <summary>
    /// Applies a data merge (copy-on-write) + version bump to a single object.
    /// Must be called while holding <c>session.SyncRoot</c>.
    /// </summary>
    private static void ApplyUpdate(SessionObject obj, Dictionary<string, object?> data)
    {
        // Copy-on-write: create a new dictionary so readers outside the lock observe
        // a stable snapshot rather than a partially-written dictionary.
        var newData = new Dictionary<string, object?>(obj.Data);
        foreach (var kvp in data)
            newData[kvp.Key] = kvp.Value;

        obj.Data = newData;
        obj.Version++;
        obj.UpdatedAt = DateTime.UtcNow;
    }
}
