namespace AsteroidsWeb.Models;

/// <summary>
/// Represents a synchronized object within a session.
/// Objects are affiliated with the role of their creator.
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
    /// The member who created this object.
    /// </summary>
    public Guid CreatorMemberId { get; init; }

    /// <summary>
    /// The role affiliation of this object.
    /// This tracks the creator's role and updates when server role transfers.
    /// </summary>
    public MemberRole AffiliatedRole { get; set; }

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
