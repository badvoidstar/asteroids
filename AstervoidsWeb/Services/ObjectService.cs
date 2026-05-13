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
    /// Sanity bound for owner-stamped <c>clientValidAt</c> values. Mirrors
    /// <c>SessionHub.ValidAtSanityBoundMs</c>; kept private here so the service
    /// can be unit-tested without referencing the hub layer.
    /// </summary>
    private const long ValidAtSanityBoundMs = 2000;

    /// <summary>
    /// Validates an owner-stamped <paramref name="clientValidAt"/> against the server's
    /// <paramref name="serverReceiveTimeMs"/> and (optionally) the object's prior
    /// <paramref name="previousValidAt"/>:
    ///   * Out-of-bounds (|client - server| > ±2 s) or null → fall back to <paramref name="serverReceiveTimeMs"/>.
    ///   * Result is then capped at <paramref name="previousValidAt"/> (if provided)
    ///     so a single object's ValidAt is monotonically non-decreasing.
    /// This is the single source of truth for the validAt timeline; both create and
    /// update paths must call it before storage.
    /// </summary>
    private static long ValidateValidAt(long? clientValidAt, long serverReceiveTimeMs, long? previousValidAt = null)
    {
        var result = clientValidAt.HasValue
            && Math.Abs(clientValidAt.Value - serverReceiveTimeMs) <= ValidAtSanityBoundMs
            ? clientValidAt.Value
            : serverReceiveTimeMs;

        if (previousValidAt.HasValue && result < previousValidAt.Value)
            result = previousValidAt.Value;

        return result;
    }

    /// <summary>
    /// Validates that a session exists. Returns the session if valid, or null if not found.
    /// </summary>
    private Session? GetValidSession(Guid sessionId)
        => _sessionService.GetSession(sessionId);

    public SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, ObjectScope scope, Dictionary<string, object?>? data = null, Guid? ownerMemberId = null, long? clientValidAt = null, long? serverReceiveTimeMs = null)
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

            var receive = serverReceiveTimeMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var validAt = ValidateValidAt(clientValidAt, receive);
            var obj = NewSessionObject(sessionId, creatorMemberId, effectiveOwner, scope, data, validAt);
            session.Objects.TryAdd(obj.Id, obj);
            return obj;
        }
    }

    /// <summary>
    /// Updates a single object without ownership enforcement.
    /// Used internally and by tests.  The hub uses <see cref="UpdateObjects"/> which
    /// enforces ownership inside the lock.
    /// </summary>
    public SessionObject? UpdateObject(Guid sessionId, Guid objectId, Dictionary<string, object?> data, long? clientValidAt = null, long? serverReceiveTimeMs = null)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (!session.Objects.TryGetValue(objectId, out var obj))
                return null;

            var receive = serverReceiveTimeMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var validAt = ValidateValidAt(clientValidAt, receive, obj.ValidAt);
            ApplyUpdate(obj, data, validAt);
            return obj;
        }
    }

    /// <summary>
    /// Batch-updates multiple objects owned by <paramref name="ownerMemberId"/>.
    ///
    /// Objects not owned by the caller are silently skipped.  Successfully updated
    /// objects are returned. Each update's <see cref="ObjectUpdate.ValidAt"/>
    /// (if present) takes precedence over <paramref name="callLevelClientValidAt"/>;
    /// both go through the same ±2 s-vs-server / monotonic-vs-previous validator.
    /// </summary>
    public IEnumerable<SessionObject> UpdateObjects(Guid sessionId, Guid ownerMemberId, IEnumerable<ObjectUpdate> updates, long? callLevelClientValidAt = null, long? serverReceiveTimeMs = null)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return Enumerable.Empty<SessionObject>();

        var results = new List<SessionObject>();
        var receive = serverReceiveTimeMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

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

                var requestedValidAt = update.ValidAt ?? callLevelClientValidAt;
                var validAt = ValidateValidAt(requestedValidAt, receive, obj.ValidAt);
                ApplyUpdate(obj, update.Data, validAt);
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
        IReadOnlyList<ReplacementObjectSpec> replacements,
        long? clientValidAt = null,
        long? serverReceiveTimeMs = null)
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

            // All replacement children share the SAME validated collision-time stamp so
            // observers see them spawn at exactly the parent's bracket-rendered position
            // at that moment. Monotonic cap is taken against the deleted parent's
            // ValidAt, not against the (not-yet-existing) children's previous values.
            var receive = serverReceiveTimeMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var validAt = ValidateValidAt(clientValidAt, receive, objToDelete.ValidAt);

            // Determine effective owner for replacements (must be a current member)
            var created = new List<SessionObject>(replacements.Count);
            foreach (var spec in replacements)
            {
                var effectiveOwner = spec.OwnerOverride.HasValue
                    && session.Members.ContainsKey(spec.OwnerOverride.Value)
                    ? spec.OwnerOverride.Value
                    : ownerMemberId;

                var obj = NewSessionObject(sessionId, ownerMemberId, effectiveOwner, spec.Scope, spec.Data, validAt);
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
    /// Applies a data merge (copy-on-write) + version bump to a single object,
    /// stamping the object's ValidAt with the validated server-time sample.
    /// Must be called while holding <c>session.SyncRoot</c>.
    /// </summary>
    private static void ApplyUpdate(SessionObject obj, Dictionary<string, object?> data, long validAt)
    {
        // Copy-on-write: create a new dictionary so readers outside the lock observe
        // a stable snapshot rather than a partially-written dictionary.
        var newData = new Dictionary<string, object?>(obj.Data);
        foreach (var kvp in data)
            newData[kvp.Key] = kvp.Value;

        obj.Data = newData;
        obj.Version++;
        obj.UpdatedAt = DateTime.UtcNow;
        obj.ValidAt = validAt;
    }

    /// <summary>
    /// Constructs a fresh <see cref="SessionObject"/>, defensively cloning <paramref name="data"/>
    /// so caller mutations after the call cannot corrupt the stored object. Caller is responsible
    /// for inserting it into <c>session.Objects</c>.
    /// </summary>
    private static SessionObject NewSessionObject(
        Guid sessionId,
        Guid creatorMemberId,
        Guid ownerMemberId,
        ObjectScope scope,
        Dictionary<string, object?>? data,
        long validAt)
        => new()
        {
            SessionId = sessionId,
            CreatorMemberId = creatorMemberId,
            OwnerMemberId = ownerMemberId,
            Scope = scope,
            Data = data != null ? new Dictionary<string, object?>(data) : new Dictionary<string, object?>(),
            ValidAt = validAt
        };
}
