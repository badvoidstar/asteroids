namespace AstervoidsWeb.Models;

/// <summary>
/// Defines the lifetime scope of a synchronized object within a session.
/// </summary>
public enum ObjectScope
{
    /// <summary>
    /// Object lifetime is tied to its owning member.
    /// When the owner leaves, the object is deleted.
    /// Examples: ships, bullets.
    /// </summary>
    Member,

    /// <summary>
    /// Object lifetime is tied to the session.
    /// When the owner leaves, ownership migrates to another member.
    /// Examples: astervoids, game state.
    /// </summary>
    Session
}
