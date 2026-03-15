using System.Collections.Concurrent;
using AstervoidsWeb.Configuration;
using AstervoidsWeb.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Services;

/// <summary>
/// In-memory implementation of session management.
/// </summary>
public class SessionService : ISessionService
{
    private readonly ConcurrentDictionary<Guid, Session> _sessions = new();
    private readonly ConcurrentDictionary<string, Guid> _connectionToMember = new();
    private readonly ConcurrentDictionary<Guid, Guid> _memberToSession = new();
    private readonly Random _random = new();
    private readonly object _sessionLock = new();
    private readonly ILogger<SessionService>? _logger;
    private readonly int _maxSessions;
    private readonly int _maxMembersPerSession;

    public int MaxSessions => _maxSessions;
    public int MaxMembersPerSession => _maxMembersPerSession;

    private static readonly string[] FruitNames = 
    [
        "Apple", "Banana", "Cherry", "Date", "Elderberry",
        "Fig", "Grape", "Honeydew", "Kiwi", "Lemon",
        "Mango", "Nectarine", "Orange", "Papaya", "Quince",
        "Raspberry", "Strawberry", "Tangerine", "Watermelon", "Blueberry",
        "Coconut", "Dragonfruit", "Guava", "Jackfruit", "Lychee",
        "Mulberry", "Olive", "Peach", "Pear", "Plum",
        "Pomegranate", "Apricot", "Avocado", "Blackberry", "Cantaloupe",
        "Clementine", "Cranberry", "Currant", "Durian", "Grapefruit",
        "Lime", "Mandarin", "Passion", "Persimmon", "Pineapple",
        "Plantain", "Starfruit", "Tamarind", "Yuzu", "Kumquat"
    ];

    public SessionService() 
    {
        _maxSessions = 6;
        _maxMembersPerSession = 4;
    }

    public SessionService(IOptions<SessionSettings> settings, ILogger<SessionService> logger)
    {
        _maxSessions = settings.Value.MaxSessions;
        _maxMembersPerSession = settings.Value.MaxMembersPerSession;
        _logger = logger;
    }

    public CreateSessionResult CreateSession(string creatorConnectionId, double aspectRatio)
    {
        lock (_sessionLock)
        {
            // Check if connection is already in a session
            if (_connectionToMember.ContainsKey(creatorConnectionId))
            {
                _logger?.LogWarning("CreateSession failed: connection {ConnectionId} is already in a session", creatorConnectionId);
                return new CreateSessionResult(false, null, null, "Already in a session. Leave current session before creating a new one.");
            }

            // Check if we've reached the maximum number of sessions
            var activeCount = _sessions.Count(s => !s.Value.Members.IsEmpty);
            if (activeCount >= _maxSessions)
            {
                _logger?.LogWarning("CreateSession failed: maximum sessions ({MaxSessions}) reached", _maxSessions);
                return new CreateSessionResult(false, null, null, $"Maximum number of sessions ({_maxSessions}) has been reached");
            }

            // Validate aspect ratio (reasonable bounds: 0.25 to 4.0)
            var clampedAspectRatio = Math.Clamp(aspectRatio, 0.25, 4.0);

            var session = new Session
            {
                Name = GenerateUniqueFruitName(),
                AspectRatio = clampedAspectRatio
            };

            _sessions.TryAdd(session.Id, session);
            var creator = RegisterMember(creatorConnectionId, session, MemberRole.Server);

            _logger?.LogInformation("Session created: {SessionName} ({SessionId}) by {MemberId}", 
                session.Name, session.Id, creator.Id);

            return new CreateSessionResult(true, session, creator, null);
        }
    }

    public JoinSessionResult JoinSession(Guid sessionId, string connectionId)
    {
        lock (_sessionLock)
        {
            // Check if connection is already in a session
            if (_connectionToMember.ContainsKey(connectionId))
            {
                _logger?.LogWarning("JoinSession failed: connection {ConnectionId} is already in a session", connectionId);
                return new JoinSessionResult(false, null, null, "Already in a session. Leave current session before joining another.");
            }

            if (!_sessions.TryGetValue(sessionId, out var session))
            {
                _logger?.LogWarning("JoinSession failed: session {SessionId} not found", sessionId);
                return new JoinSessionResult(false, null, null, "Session not found");
            }

            // Check if session is full
            if (session.Members.Count >= _maxMembersPerSession)
            {
                _logger?.LogWarning("JoinSession failed: session {SessionId} is full ({MaxMembers} members)", sessionId, _maxMembersPerSession);
                return new JoinSessionResult(false, null, null, $"Session is full (maximum {_maxMembersPerSession} members)");
            }

            // Assign Server role if session has no members (rejoining an empty session)
            var role = session.Members.IsEmpty ? MemberRole.Server : MemberRole.Client;
            var member = RegisterMember(connectionId, session, role);

            // Clear empty-session tracking since we now have a member
            if (session.LastMemberLeftAt.HasValue)
                session.LastMemberLeftAt = null;

            _logger?.LogInformation("Member {MemberId} joined session {SessionName} as {Role}", 
                member.Id, session.Name, role);

            return new JoinSessionResult(true, session, member, null);
        }
    }

    public LeaveSessionResult? LeaveSession(string connectionId)
    {
        if (!_connectionToMember.TryRemove(connectionId, out var memberId))
        {
            _logger?.LogWarning("LeaveSession failed: connection {ConnectionId} not found", connectionId);
            return null;
        }

        if (!_memberToSession.TryRemove(memberId, out var sessionId))
            return null;

        if (!_sessions.TryGetValue(sessionId, out var session))
            return null;

        if (!session.Members.TryRemove(memberId, out var member))
            return null;

        Member? promotedMember = null;

        // If the leaving member was the server, promote a client
        if (member.Role == MemberRole.Server && session.Members.Count > 0)
        {
            lock (session.PromotionLock)
            {
                // Double-check there's still no server
                var hasServer = session.Members.Values.Any(m => m.Role == MemberRole.Server);
                if (!hasServer)
                {
                    // Select random client to promote
                    var clients = session.Members.Values.ToList();
                    if (clients.Count > 0)
                    {
                        var selectedIndex = _random.Next(clients.Count);
                        promotedMember = clients[selectedIndex];
                        promotedMember.Role = MemberRole.Server;

                        _logger?.LogInformation("Member {MemberId} promoted to Server in session {SessionName}", 
                            promotedMember.Id, session.Name);

                        session.Version++;
                    }
                }
            }
        }

        // If no members left, mark session for cleanup instead of destroying immediately.
        // The cleanup service will destroy it after the configured empty timeout.
        var sessionDestroyed = false;
        if (session.Members.IsEmpty)
        {
            session.LastMemberLeftAt = DateTime.UtcNow;
        }

        return new LeaveSessionResult(
            sessionId,
            session.Name,
            memberId,
            sessionDestroyed,
            promotedMember
        );
    }

    public ActiveSessionsResult GetActiveSessions()
    {
        var sessions = _sessions.Values
            .Where(s => !s.Members.IsEmpty)
            .Select(s => new SessionInfo(s.Id, s.Name, s.Members.Count, _maxMembersPerSession, s.CreatedAt))
            .OrderByDescending(s => s.CreatedAt)
            .ToList();

        return new ActiveSessionsResult(
            sessions,
            _maxSessions,
            sessions.Count < _maxSessions
        );
    }

    public Session? GetSession(Guid sessionId)
    {
        return _sessions.TryGetValue(sessionId, out var session) ? session : null;
    }

    public Member? GetMemberByConnectionId(string connectionId)
    {
        var resolved = ResolveConnectionToSession(connectionId);
        if (resolved == null) return null;
        var (memberId, session) = resolved.Value;
        return session.Members.TryGetValue(memberId, out var member) ? member : null;
    }

    public Session? GetSessionByConnectionId(string connectionId)
        => ResolveConnectionToSession(connectionId)?.session;

    public (Member Member, Session Session)? GetMemberAndSessionByConnectionId(string connectionId)
    {
        var resolved = ResolveConnectionToSession(connectionId);
        if (resolved == null) return null;
        var (memberId, session) = resolved.Value;
        return session.Members.TryGetValue(memberId, out var member) ? (member, session) : null;
    }

    public IEnumerable<Session> GetAllSessions()
    {
        return _sessions.Values.ToList();
    }

    public ForceDestroySessionResult? ForceDestroySession(Guid sessionId)
    {
        if (!_sessions.TryRemove(sessionId, out var session))
            return null;

        var connectionIds = new List<string>();
        foreach (var member in session.Members.Values)
        {
            _memberToSession.TryRemove(member.Id, out _);
            _connectionToMember.TryRemove(member.ConnectionId, out _);
            connectionIds.Add(member.ConnectionId);
        }

        _logger?.LogInformation("Session {SessionName} ({SessionId}) force-destroyed. Removed {MemberCount} members.",
            session.Name, session.Id, connectionIds.Count);

        return new ForceDestroySessionResult(connectionIds, session.Name);
    }

    /// <summary>
    /// Resolves a connection ID to its member ID and session.
    /// Shared lookup chain used by GetMemberByConnectionId, GetSessionByConnectionId,
    /// and GetMemberAndSessionByConnectionId.
    /// </summary>
    private (Guid memberId, Session session)? ResolveConnectionToSession(string connectionId)
    {
        if (!_connectionToMember.TryGetValue(connectionId, out var memberId))
            return null;

        if (!_memberToSession.TryGetValue(memberId, out var sessionId))
            return null;

        return _sessions.TryGetValue(sessionId, out var session) ? (memberId, session) : null;
    }

    /// <summary>
    /// Creates a member, adds it to the session, and registers it in the lookup dictionaries.
    /// </summary>
    private Member RegisterMember(string connectionId, Session session, MemberRole role)
    {
        var member = new Member
        {
            ConnectionId = connectionId,
            Role = role,
            SessionId = session.Id
        };

        session.Members.TryAdd(member.Id, member);
        _connectionToMember.TryAdd(connectionId, member.Id);
        _memberToSession.TryAdd(member.Id, session.Id);

        return member;
    }

    private string GenerateUniqueFruitName()
    {
        // Called within _sessionLock, no additional lock needed
        var usedNames = _sessions.Values.Select(s => s.Name).ToHashSet();
        var availableNames = FruitNames.Where(n => !usedNames.Contains(n)).ToList();

        if (availableNames.Count == 0)
        {
            // All fruit names used, append a number
            var counter = 2;
            while (true)
            {
                var candidateName = $"{FruitNames[_random.Next(FruitNames.Length)]}{counter}";
                if (!usedNames.Contains(candidateName))
                    return candidateName;
                counter++;
            }
        }

        return availableNames[_random.Next(availableNames.Count)];
    }
}
