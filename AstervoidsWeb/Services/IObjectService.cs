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
    SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, ObjectScope scope, Dictionary<string, object?>? data = null);

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
    bool DeleteObject(Guid sessionId, Guid objectId);

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
    /// Transfers session-scoped objects to a new owner (if provided).
    /// </summary>
    /// <param name="sessionId">The session.</param>
    /// <param name="departingMemberId">The member who is leaving.</param>
    /// <param name="newOwnerId">The member to receive session-scoped objects (null if no migration needed).</param>
    /// <returns>Result containing deleted and migrated object IDs.</returns>
    MemberDepartureResult HandleMemberDeparture(Guid sessionId, Guid departingMemberId, Guid? newOwnerId);
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
/// Result of handling a member's departure from a session.
/// </summary>
public record MemberDepartureResult(
    IEnumerable<Guid> DeletedObjectIds,
    IEnumerable<Guid> MigratedObjectIds
);
