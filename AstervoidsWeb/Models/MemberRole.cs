namespace AstervoidsWeb.Models;

/// <summary>
/// Defines the role of a member within a session.
/// </summary>
public enum MemberRole
{
    /// <summary>
    /// The authoritative member responsible for session state.
    /// Only one member can have this role per session.
    /// </summary>
    Server,

    /// <summary>
    /// A participant member that syncs with the server.
    /// Multiple members can have this role per session.
    /// </summary>
    Client
}
