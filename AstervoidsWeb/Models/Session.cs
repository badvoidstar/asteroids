using System.Collections.Concurrent;

namespace AstervoidsWeb.Models;

/// <summary>
/// Represents a game session that members can join.
///
/// Synchronization model
/// ─────────────────────
/// All per-session mutations (join, leave, object create/update/delete/replace, object
/// ownership migration, and <see cref="LifecycleState"/> transitions) MUST be performed
/// while holding <see cref="SyncRoot"/>.  Read-only lookups (e.g. querying
/// <see cref="Members"/> or <see cref="Objects"/> counts for logging) do not require the
/// lock because <see cref="ConcurrentDictionary{TKey,TValue}"/> is itself thread-safe for
/// individual reads; however, any compound check-then-act sequence requires the lock.
///
/// Global indexes (<c>_connectionToMember</c>, <c>_memberToSession</c>, and the
/// <c>_sessions</c> dictionary in <c>SessionService</c>) use their own <c>_sessionLock</c>
/// for cross-session operations such as session creation and join capacity checks.
/// When both locks are needed the acquisition order is always
/// <c>_sessionLock</c> → <c>SyncRoot</c> to avoid deadlocks.
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
    /// Per-session synchronization root.  All session-local mutations (member
    /// add/remove, promotion, object create/update/delete, ownership migration,
    /// lifecycle transitions, and <see cref="LastMemberLeftAt"/> updates) must be
    /// performed while holding this lock.
    /// </summary>
    internal readonly object SyncRoot = new();

    /// <summary>
    /// Current lifecycle state of this session.
    /// Must only be read or written while holding <see cref="SyncRoot"/>.
    /// </summary>
    public SessionLifecycleState LifecycleState { get; set; } = SessionLifecycleState.Active;

    /// <summary>
    /// Thread-safe collection of members in this session.
    /// Key is the member's GUID.
    /// Individual reads are thread-safe without <see cref="SyncRoot"/>; compound
    /// check-then-act operations require <see cref="SyncRoot"/>.
    /// </summary>
    public ConcurrentDictionary<Guid, Member> Members { get; } = new();

    /// <summary>
    /// Thread-safe collection of objects in this session.
    /// Key is the object's GUID.
    /// Individual reads are thread-safe without <see cref="SyncRoot"/>; all mutations
    /// (including <see cref="SessionObject.Data"/> replacement and version bumps) require
    /// <see cref="SyncRoot"/>.
    /// </summary>
    public ConcurrentDictionary<Guid, SessionObject> Objects { get; } = new();

    /// <summary>
    /// Timestamp when the session was created.
    /// </summary>
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;

    /// <summary>
    /// The locked aspect ratio (width/height) for this session.
    /// Set by the creator at session creation time and immutable thereafter.
    /// </summary>
    public double AspectRatio { get; init; } = 16.0 / 9.0;

    /// <summary>
    /// Timestamp when the last member left the session (null if members are present).
    /// Used by the cleanup service to determine when to destroy empty sessions.
    /// Must only be read or written while holding <see cref="SyncRoot"/>.
    /// </summary>
    public DateTime? LastMemberLeftAt { get; set; }

    /// <summary>
    /// Version number for optimistic concurrency control on session-level operations.
    /// Incremented on server promotion.  Must only be read or written while holding
    /// <see cref="SyncRoot"/>.
    /// </summary>
    public long Version { get; set; } = 1;
}
