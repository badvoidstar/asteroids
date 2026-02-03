using System.Collections.Concurrent;

namespace AstervoidsWeb.Models;

/// <summary>
/// Represents a game session that members can join.
/// </summary>
public class Session
{
    /// <summary>
    /// Globally unique identifier for this session.
    /// </summary>
    public Guid Id { get; init; } = Guid.NewGuid();

    /// <summary>
    /// Human-readable name for the session (a fruit name).
    /// </summary>
    public required string Name { get; init; }

    /// <summary>
    /// Thread-safe collection of members in this session.
    /// Key is the member's GUID.
    /// </summary>
    public ConcurrentDictionary<Guid, Member> Members { get; } = new();

    /// <summary>
    /// Thread-safe collection of objects in this session.
    /// Key is the object's GUID.
    /// </summary>
    public ConcurrentDictionary<Guid, SessionObject> Objects { get; } = new();

    /// <summary>
    /// Timestamp when the session was created.
    /// </summary>
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;

    /// <summary>
    /// Version number for optimistic concurrency control on session-level operations.
    /// Used primarily for server role promotion.
    /// </summary>
    public long Version { get; set; } = 1;

    /// <summary>
    /// Lock object for coordinating server promotion.
    /// </summary>
    internal readonly object PromotionLock = new();
}
