using AstervoidsWeb.Models;

namespace AstervoidsWeb.Services;

/// <summary>
/// Service for managing synchronized objects within sessions.
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
    /// <returns>The created object, or null if session/member not found.</returns>
    SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, ObjectScope scope, Dictionary<string, object?>? data = null, Guid? ownerMemberId = null);

    /// <summary>
    /// Updates an existing object.
    /// </summary>
    SessionObject? UpdateObject(Guid sessionId, Guid objectId, Dictionary<string, object?> data, long? expectedVersion = null);

    /// <summary>
    /// Batch updates multiple objects atomically.
    /// </summary>
    IEnumerable<SessionObject> UpdateObjects(Guid sessionId, IEnumerable<ObjectUpdate> updates);

    /// <summary>
    /// Deletes an object from a session.
    /// </summary>
    /// <returns>The deleted object, or null if not found.</returns>
    SessionObject? DeleteObject(Guid sessionId, Guid objectId);

    /// <summary>
    /// Gets all objects in a session.
    /// </summary>
    IEnumerable<SessionObject> GetSessionObjects(Guid sessionId);

    /// <summary>
    /// Gets a specific object.
    /// </summary>
    SessionObject? GetObject(Guid sessionId, Guid objectId);

    /// <summary>
    /// Handles cleanup when a member departs a session.
    /// Deletes member-scoped objects owned by the departing member.
    /// Transfers session-scoped objects to remaining members (distributed round-robin or to a single member based on configuration).
    /// </summary>
    /// <param name="sessionId">The session.</param>
    /// <param name="departingMemberId">The member who is leaving.</param>
    /// <param name="remainingMemberIds">The remaining members eligible to receive session-scoped objects.</param>
    /// <returns>Result containing deleted and migrated object info.</returns>
    MemberDepartureResult HandleMemberDeparture(Guid sessionId, Guid departingMemberId, IList<Guid> remainingMemberIds);
}

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
public record ObjectMigration(Guid ObjectId, Guid NewOwnerId, long NewVersion);

/// <summary>
/// Result of handling a member's departure from a session.
/// </summary>
public record MemberDepartureResult(
    IEnumerable<Guid> DeletedObjectIds,
    IEnumerable<ObjectMigration> MigratedObjects
);
