using AstervoidsWeb.Models;
using MessagePack;

namespace AstervoidsWeb.Services;

/// <summary>
/// Service for managing synchronized objects within sessions.
///
/// Correctness contract
/// ────────────────────
/// All mutating operations (create, update, delete, replace) validate ownership and
/// session lifecycle state atomically under the session's <c>Session.SyncRoot</c> lock.
/// Hub-layer ownership pre-checks are NOT relied upon for correctness; they are only
/// kept for fast early-return / logging purposes.
/// </summary>
public interface IObjectService
{
    /// <summary>
    /// Creates a new object in a session.
    /// </summary>
    /// <param name="sessionId">The session to create the object in.</param>
    /// <param name="creatorMemberId">The member creating the object.</param>
    /// <param name="scope">The lifetime scope of the object (Member or Session).</param>
    /// <param name="data">Initial object data.</param>
    /// <param name="ownerMemberId">Optional override for the initial owner. Defaults to the creator.</param>
    /// <param name="clientValidAt">Owner-stamped server-time ms (NTP-aligned). Validated
    /// against <paramref name="serverReceiveTimeMs"/> by ±2 s sanity bound; out-of-bounds
    /// or null falls back to the receive time.</param>
    /// <param name="serverReceiveTimeMs">Server's hub-entry timestamp; defaults to <c>UtcNow</c>.</param>
    /// <returns>The created object, or null if session/member not found or session is not active.</returns>
    SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, ObjectScope scope, Dictionary<string, object?>? data = null, Guid? ownerMemberId = null, long? clientValidAt = null, long? serverReceiveTimeMs = null);

    /// <summary>
    /// Updates an existing object (no ownership enforcement — use <see cref="UpdateObjects"/> for authoritative updates).
    /// </summary>
    SessionObject? UpdateObject(Guid sessionId, Guid objectId, Dictionary<string, object?> data, long? clientValidAt = null, long? serverReceiveTimeMs = null);

    /// <summary>
    /// Batch updates multiple objects owned by the specified member.
    /// Ownership is validated atomically inside the session lock; hub-layer pre-filtering
    /// is not required for correctness.
    ///
    /// Each <see cref="ObjectUpdate.ValidAt"/> overrides <paramref name="callLevelClientValidAt"/>
    /// when present; null means "use the call-level fallback". Both are validated
    /// (±2 s vs <paramref name="serverReceiveTimeMs"/>; monotonic vs the object's
    /// previous ValidAt) before storage.
    /// </summary>
    IEnumerable<SessionObject> UpdateObjects(Guid sessionId, Guid ownerMemberId, IEnumerable<ObjectUpdate> updates, long? callLevelClientValidAt = null, long? serverReceiveTimeMs = null);

    /// <summary>
    /// Deletes an object from a session, enforcing ownership atomically.
    /// Returns the deleted object, or null if the object was not found or is not owned by
    /// <paramref name="ownerMemberId"/>.
    /// </summary>
    SessionObject? DeleteObject(Guid sessionId, Guid objectId, Guid ownerMemberId);

    /// <summary>
    /// Atomically deletes an existing object and creates one or more replacement objects
    /// in a single critical section.  Ownership of <paramref name="deleteObjectId"/> is
    /// enforced before the delete; the whole operation is either committed or not started.
    ///
    /// All replacement children share the same validated <paramref name="clientValidAt"/>
    /// (the collision moment in server-time space), so observers see them spawn at the
    /// position the bracket renderer was already showing the parent at.
    /// </summary>
    /// <param name="sessionId">The session.</param>
    /// <param name="deleteObjectId">Object to delete (must be owned by <paramref name="ownerMemberId"/>).</param>
    /// <param name="ownerMemberId">Member asserting ownership of the deleted object.</param>
    /// <param name="replacements">Specs for each replacement object to create.</param>
    /// <param name="clientValidAt">Owner-stamped collision time in server-clock ms.</param>
    /// <param name="serverReceiveTimeMs">Server's hub-entry timestamp; defaults to <c>UtcNow</c>.</param>
    /// <returns>The list of created objects, or null if the operation could not be performed
    /// (session not found/active, object not found, ownership mismatch).</returns>
    IReadOnlyList<SessionObject>? ReplaceObject(
        Guid sessionId,
        Guid deleteObjectId,
        Guid ownerMemberId,
        IReadOnlyList<ReplacementObjectSpec> replacements,
        long? clientValidAt = null,
        long? serverReceiveTimeMs = null);

    /// <summary>
    /// Gets all objects in a session.
    /// </summary>
    IEnumerable<SessionObject> GetSessionObjects(Guid sessionId);

    /// <summary>
    /// Gets a specific object.
    /// </summary>
    SessionObject? GetObject(Guid sessionId, Guid objectId);
}

/// <summary>
/// Specifies the properties of a single replacement object in a <c>ReplaceObject</c> call.
/// </summary>
public record ReplacementObjectSpec(
    ObjectScope Scope,
    Dictionary<string, object?> Data,
    Guid? OwnerOverride = null
);

/// <summary>
/// Represents a batch update for an object.
///
/// Per-object <paramref name="ValidAt"/> takes precedence over the call-level
/// <c>clientValidAt</c> on <c>SessionHub.UpdateObjects</c>; null means
/// "fall back to the call-level value". This lets a sender batch updates that
/// were sampled at slightly different ticks (rare but exact when the renderer
/// stamps each object at its own simulation moment).
/// </summary>
public record ObjectUpdate(
    Guid ObjectId,
    Dictionary<string, object?> Data,
    long? ValidAt = null
);

/// <summary>
/// Represents a single object migration (object reassigned to a new owner).
/// Includes the new version so clients can set it directly rather than
/// guessing with a local increment (which can drift if the client's
/// version was already stale before the migration).
///
/// <c>ValidAt</c> is the migrated object's last validated server-time sample
/// at the moment of migration. The new owner uses this as the seed
/// timestamp for its first-authored snapshot so observers see motion
/// continue smoothly across the handoff (no synthetic "now" anchor).
/// </summary>
[MessagePackObject]
public record ObjectMigration(
    [property: Key("objectId")] Guid ObjectId,
    [property: Key("newOwnerId")] Guid NewOwnerId,
    [property: Key("newVersion")] long NewVersion,
    [property: Key("validAt")] long ValidAt);

/// <summary>
/// Result of handling a member's departure from a session.
/// </summary>
public record MemberDepartureResult(
    IReadOnlyList<Guid> DeletedObjectIds,
    IReadOnlyList<ObjectMigration> MigratedObjects
);
