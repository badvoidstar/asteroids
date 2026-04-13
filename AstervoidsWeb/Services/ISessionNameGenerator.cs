namespace AstervoidsWeb.Services;

/// <summary>
/// Generates unique human-readable names for sessions.
/// Implementations receive the set of names currently in use and must return
/// a name that is not in that set.
/// </summary>
public interface ISessionNameGenerator
{
    /// <summary>
    /// Generate a unique session name that does not collide with any name in <paramref name="usedNames"/>.
    /// </summary>
    /// <param name="usedNames">Names currently in use by active sessions.</param>
    /// <returns>A unique session name.</returns>
    string GenerateUniqueName(IReadOnlySet<string> usedNames);
}
