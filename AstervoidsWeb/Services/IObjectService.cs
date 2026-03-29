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
    /// <returns>The created object, or null if session/member not found or session is not active.</returns>
    SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, ObjectScope scope, Dictionary<string, object?>? data = null, Guid? ownerMemberId = null);

    /// <summary>
    /// Updates an existing object (no ownership enforcement — use <see cref="UpdateObjects"/> for authoritative updates).
    /// </summary>
    SessionObject? UpdateObject(Guid sessionId, Guid objectId, Dictionary<string, object?> data, long? expectedVersion = null);

    /// <summary>
    /// Batch updates multiple objects owned by the specified member.
    /// Ownership is validated atomically inside the session lock; hub-layer pre-filtering
    /// is not required for correctness.
    /// </summary>
    IEnumerable<SessionObject> UpdateObjects(Guid sessionId, Guid ownerMemberId, IEnumerable<ObjectUpdate> updates);

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
    /// </summary>
    /// <param name="sessionId">The session.</param>
    /// <param name="deleteObjectId">Object to delete (must be owned by <paramref name="ownerMemberId"/>).</param>
    /// <param name="ownerMemberId">Member asserting ownership of the deleted object.</param>
    /// <param name="replacements">Specs for each replacement object to create.</param>
    /// <returns>The list of created objects, or null if the operation could not be performed
    /// (session not found/active, object not found, ownership mismatch).</returns>
    IReadOnlyList<SessionObject>? ReplaceObject(
        Guid sessionId,
        Guid deleteObjectId,
        Guid ownerMemberId,
        IReadOnlyList<ReplacementObjectSpec> replacements);

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
/// </summary>
public record ObjectUpdate(
    Guid ObjectId,
    Dictionary<string, object?> Data,
    long? ExpectedVersion = null
);

/// <summary>
/// Represents a single object migration (object reassigned to a new owner).
/// Includes the new version so clients can set it directly rather than
/// guessing with a local increment (which can drift if the client's
/// version was already stale before the migration).
/// </summary>
[MessagePackObject]
public record ObjectMigration(
    [property: Key("objectId")] Guid ObjectId,
    [property: Key("newOwnerId")] Guid NewOwnerId,
    [property: Key("newVersion")] long NewVersion);

/// <summary>
/// Result of handling a member's departure from a session.
/// </summary>
public record MemberDepartureResult(
    IReadOnlyList<Guid> DeletedObjectIds,
    IReadOnlyList<ObjectMigration> MigratedObjects
);
