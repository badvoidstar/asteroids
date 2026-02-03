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
    /// <param name="data">Initial object data.</param>
    /// <returns>The created object, or null if session/member not found.</returns>
    SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, Dictionary<string, object?>? data = null);

    /// <summary>
    /// Updates an existing object.
    /// </summary>
    /// <param name="sessionId">The session containing the object.</param>
    /// <param name="objectId">The object to update.</param>
    /// <param name="data">New data to merge into the object.</param>
    /// <param name="expectedVersion">Expected version for optimistic concurrency (optional).</param>
    /// <returns>The updated object, or null if not found or version mismatch.</returns>
    SessionObject? UpdateObject(Guid sessionId, Guid objectId, Dictionary<string, object?> data, long? expectedVersion = null);

    /// <summary>
    /// Batch updates multiple objects atomically.
    /// </summary>
    /// <param name="sessionId">The session containing the objects.</param>
    /// <param name="updates">List of updates to apply.</param>
    /// <returns>List of successfully updated objects.</returns>
    IEnumerable<SessionObject> UpdateObjects(Guid sessionId, IEnumerable<ObjectUpdate> updates);

    /// <summary>
    /// Deletes an object from a session.
    /// </summary>
    /// <param name="sessionId">The session containing the object.</param>
    /// <param name="objectId">The object to delete.</param>
    /// <returns>True if deleted, false if not found.</returns>
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
    /// Updates object affiliations when server role changes.
    /// </summary>
    /// <param name="sessionId">The session.</param>
    /// <param name="oldServerId">The previous server member ID.</param>
    /// <param name="newServerId">The new server member ID.</param>
    void TransferServerAffiliation(Guid sessionId, Guid oldServerId, Guid newServerId);
}

/// <summary>
/// Represents a batch update for an object.
/// </summary>
public record ObjectUpdate(
    Guid ObjectId,
    Dictionary<string, object?> Data,
    long? ExpectedVersion = null
);
