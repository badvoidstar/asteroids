namespace AstervoidsWeb.Models;

/// <summary>
/// Represents a synchronized object within a session.
/// Each object has an owner (who simulates it) and a scope (lifetime policy).
/// </summary>
public class SessionObject
{
    /// <summary>
    /// Globally unique identifier for this object.
    /// </summary>
    public Guid Id { get; init; } = Guid.NewGuid();

    /// <summary>
    /// The session this object belongs to.
    /// </summary>
    public Guid SessionId { get; init; }

    /// <summary>
    /// The member who originally created this object (immutable).
    /// </summary>
    public Guid CreatorMemberId { get; init; }

    /// <summary>
    /// The member who currently owns this object (mutable).
    /// The owner is responsible for simulation and state updates.
    /// Initially set to the creator; may change via ownership migration.
    /// </summary>
    public Guid OwnerMemberId { get; set; }

    /// <summary>
    /// The lifetime scope of this object.
    /// Member-scoped objects are deleted when their owner leaves.
    /// Session-scoped objects have their ownership migrated when their owner leaves.
    /// </summary>
    public ObjectScope Scope { get; init; }

    /// <summary>
    /// Arbitrary data associated with this object.
    /// </summary>
    public Dictionary<string, object?> Data { get; set; } = new();

    /// <summary>
    /// Version number for optimistic concurrency control.
    /// Incremented on each update.
    /// </summary>
    public long Version { get; set; } = 1;

    /// <summary>
    /// Timestamp when the object was created.
    /// </summary>
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;

    /// <summary>
    /// Timestamp of the last update.
    /// </summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
