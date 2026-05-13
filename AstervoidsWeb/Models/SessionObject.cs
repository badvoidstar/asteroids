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
    /// Updated via whole-dictionary replacement (copy-on-write) under the session's
    /// <see cref="Session.SyncRoot"/> lock so that snapshot reads outside the lock
    /// always observe a stable, complete dictionary.
    /// </summary>
    public Dictionary<string, object?> Data { get; set; } = new();

    /// <summary>
    /// Version number for optimistic concurrency control.
    /// Incremented on each update.
    /// </summary>
    public long Version { get; set; } = 1;

    /// <summary>
    /// Owner-stamped simulation sample time in server-clock milliseconds (NTP-aligned).
    /// This is the unified interpolation timeline anchor: receivers convert this to
    /// their local perf.now domain via <c>validAtToPerfNow</c> so bracket-search
    /// continues on a monotonic clock even though the source is wall-clock.
    ///
    /// Set on every mutation by <see cref="ObjectService"/> after the validation
    /// pipeline (±2 s sanity bound vs. server's hub-entry timestamp + monotonic
    /// cap at the previous ValidAt). Defaults to the creation time so reconciliation
    /// snapshots never observe a missing/zero value.
    /// </summary>
    public long ValidAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>
    /// Timestamp when the object was created.
    /// </summary>
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;

    /// <summary>
    /// Timestamp of the last update.
    /// </summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
