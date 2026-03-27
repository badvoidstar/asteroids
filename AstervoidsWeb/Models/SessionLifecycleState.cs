namespace AstervoidsWeb.Models;

/// <summary>
/// Lifecycle state of a session used to gate mutating operations.
/// All transitions are made under <see cref="Session.SyncRoot"/>.
/// </summary>
public enum SessionLifecycleState
{
    /// <summary>Session is active and accepting mutating operations.</summary>
    Active,

    /// <summary>
    /// Session is being destroyed. Mutating operations (join, object create/update/delete,
    /// member departure) that encounter this state must abort cleanly.
    /// </summary>
    Destroying,

    /// <summary>Session has been fully destroyed and all indexes cleaned up.</summary>
    Destroyed
}
