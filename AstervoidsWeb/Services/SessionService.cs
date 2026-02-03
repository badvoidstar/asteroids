using System.Collections.Concurrent;
using AstervoidsWeb.Models;
using Microsoft.Extensions.Logging;

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
    private readonly object _nameLock = new();
    private readonly ILogger<SessionService>? _logger;

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

    public SessionService() { }

    public SessionService(ILogger<SessionService> logger)
    {
        _logger = logger;
    }

    public (Session Session, Member Creator) CreateSession(string creatorConnectionId)
    {
        var session = new Session
        {
            Name = GenerateUniqueFruitName()
        };

        var creator = new Member
        {
            ConnectionId = creatorConnectionId,
            Role = MemberRole.Server,
            SessionId = session.Id
        };

        session.Members.TryAdd(creator.Id, creator);
        _sessions.TryAdd(session.Id, session);
        _connectionToMember.TryAdd(creatorConnectionId, creator.Id);
        _memberToSession.TryAdd(creator.Id, session.Id);

        _logger?.LogInformation("Session created: {SessionName} ({SessionId}) by {MemberId}", 
            session.Name, session.Id, creator.Id);

        return (session, creator);
    }

    public (Session Session, Member Member)? JoinSession(Guid sessionId, string connectionId)
    {
        if (!_sessions.TryGetValue(sessionId, out var session))
        {
            _logger?.LogWarning("JoinSession failed: session {SessionId} not found", sessionId);
            return null;
        }

        var member = new Member
        {
            ConnectionId = connectionId,
            Role = MemberRole.Client,
            SessionId = session.Id
        };

        session.Members.TryAdd(member.Id, member);
        _connectionToMember.TryAdd(connectionId, member.Id);
        _memberToSession.TryAdd(member.Id, session.Id);

        _logger?.LogInformation("Member {MemberId} joined session {SessionName} as Client", 
            member.Id, session.Name);

        return (session, member);
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
        var affectedObjectIds = new List<Guid>();

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

                        // Update object affiliations
                        foreach (var obj in session.Objects.Values)
                        {
                            if (obj.AffiliatedRole == MemberRole.Server)
                            {
                                affectedObjectIds.Add(obj.Id);
                            }
                        }

                        session.Version++;
                    }
                }
            }
        }

        // If no members left, destroy the session
        var sessionDestroyed = session.Members.IsEmpty;
        if (sessionDestroyed)
        {
            _sessions.TryRemove(sessionId, out _);
        }

        return new LeaveSessionResult(
            sessionId,
            session.Name,
            memberId,
            sessionDestroyed,
            promotedMember,
            affectedObjectIds
        );
    }

    public IEnumerable<SessionInfo> GetActiveSessions()
    {
        return _sessions.Values
            .Where(s => !s.Members.IsEmpty)
            .Select(s => new SessionInfo(s.Id, s.Name, s.Members.Count, s.CreatedAt))
            .OrderByDescending(s => s.CreatedAt);
    }

    public Session? GetSession(Guid sessionId)
    {
        return _sessions.TryGetValue(sessionId, out var session) ? session : null;
    }

    public Member? GetMemberByConnectionId(string connectionId)
    {
        if (!_connectionToMember.TryGetValue(connectionId, out var memberId))
            return null;

        if (!_memberToSession.TryGetValue(memberId, out var sessionId))
            return null;

        if (!_sessions.TryGetValue(sessionId, out var session))
            return null;

        return session.Members.TryGetValue(memberId, out var member) ? member : null;
    }

    public Session? GetSessionByConnectionId(string connectionId)
    {
        if (!_connectionToMember.TryGetValue(connectionId, out var memberId))
            return null;

        if (!_memberToSession.TryGetValue(memberId, out var sessionId))
            return null;

        return _sessions.TryGetValue(sessionId, out var session) ? session : null;
    }

    private string GenerateUniqueFruitName()
    {
        lock (_nameLock)
        {
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
}
