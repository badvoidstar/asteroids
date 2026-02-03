using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class ServerPromotionTests
{
    private readonly SessionService _sessionService;
    private readonly ObjectService _objectService;

    public ServerPromotionTests()
    {
        _sessionService = new SessionService();
        _objectService = new ObjectService(_sessionService);
    }

    [Fact]
    public void ServerLeaves_WithMultipleClients_ShouldPromoteOneClient()
    {
        // Arrange
        var (session, server) = _sessionService.CreateSession("server-conn");
        _sessionService.JoinSession(session.Id, "client1-conn");
        _sessionService.JoinSession(session.Id, "client2-conn");
        _sessionService.JoinSession(session.Id, "client3-conn");

        // Act
        var result = _sessionService.LeaveSession("server-conn");

        // Assert
        result.Should().NotBeNull();
        result!.PromotedMember.Should().NotBeNull();
        result.PromotedMember!.Role.Should().Be(MemberRole.Server);

        // Verify only one server exists
        var remainingSession = _sessionService.GetSession(session.Id);
        var servers = remainingSession!.Members.Values.Where(m => m.Role == MemberRole.Server).ToList();
        servers.Should().HaveCount(1);
    }

    [Fact]
    public void ServerLeaves_ShouldReturnAffectedObjectIds()
    {
        // Arrange
        var (session, server) = _sessionService.CreateSession("server-conn");
        var (_, client) = _sessionService.JoinSession(session.Id, "client-conn")!.Value;

        // Create objects - some by server, some by client
        var serverObj1 = _objectService.CreateObject(session.Id, server.Id);
        var serverObj2 = _objectService.CreateObject(session.Id, server.Id);
        var clientObj = _objectService.CreateObject(session.Id, client.Id);

        // Act
        var result = _sessionService.LeaveSession("server-conn");

        // Assert
        result.Should().NotBeNull();
        result!.AffectedObjectIds.Should().HaveCount(2);
        result.AffectedObjectIds.Should().Contain(serverObj1!.Id);
        result.AffectedObjectIds.Should().Contain(serverObj2!.Id);
        result.AffectedObjectIds.Should().NotContain(clientObj!.Id);
    }

    [Fact]
    public void ServerLeaves_SessionVersionShouldIncrement()
    {
        // Arrange
        var (session, _) = _sessionService.CreateSession("server-conn");
        _sessionService.JoinSession(session.Id, "client-conn");
        var initialVersion = session.Version;

        // Act
        _sessionService.LeaveSession("server-conn");

        // Assert
        var updatedSession = _sessionService.GetSession(session.Id);
        updatedSession!.Version.Should().Be(initialVersion + 1);
    }

    [Fact]
    public void ClientLeaves_ShouldNotAffectServerRole()
    {
        // Arrange
        var (session, server) = _sessionService.CreateSession("server-conn");
        _sessionService.JoinSession(session.Id, "client-conn");

        // Act
        var result = _sessionService.LeaveSession("client-conn");

        // Assert
        result.Should().NotBeNull();
        result!.PromotedMember.Should().BeNull();

        var serverMember = _sessionService.GetMemberByConnectionId("server-conn");
        serverMember!.Role.Should().Be(MemberRole.Server);
    }

    [Fact]
    public void ServerLeaves_NoClients_ShouldDestroySession()
    {
        // Arrange
        var (session, _) = _sessionService.CreateSession("server-conn");

        // Act
        var result = _sessionService.LeaveSession("server-conn");

        // Assert
        result.Should().NotBeNull();
        result!.SessionDestroyed.Should().BeTrue();
        result.PromotedMember.Should().BeNull();
        _sessionService.GetSession(session.Id).Should().BeNull();
    }

    [Fact]
    public void ConcurrentJoinsAndLeaves_ShouldMaintainSessionIntegrity()
    {
        // Arrange
        var (session, _) = _sessionService.CreateSession("server-conn");
        var sessionId = session.Id;

        // Simulate rapid joins
        var joinTasks = Enumerable.Range(0, 10)
            .Select(i => Task.Run(() => _sessionService.JoinSession(sessionId, $"client-{i}")))
            .ToArray();

        Task.WaitAll(joinTasks);

        // All joins should succeed
        var currentSession = _sessionService.GetSession(sessionId);
        currentSession!.Members.Count.Should().Be(11); // 1 server + 10 clients

        // Simulate rapid leaves (clients only)
        var leaveTasks = Enumerable.Range(0, 10)
            .Select(i => Task.Run(() => _sessionService.LeaveSession($"client-{i}")))
            .ToArray();

        Task.WaitAll(leaveTasks);

        // Session should still exist with just the server
        currentSession = _sessionService.GetSession(sessionId);
        currentSession!.Members.Count.Should().Be(1);
        currentSession.Members.Values.First().Role.Should().Be(MemberRole.Server);
    }

    [Fact]
    public void RapidServerChanges_ShouldAlwaysHaveOneServer()
    {
        // Arrange
        var (session, _) = _sessionService.CreateSession("server-conn");
        var sessionId = session.Id;

        // Add clients
        for (int i = 0; i < 5; i++)
        {
            _sessionService.JoinSession(sessionId, $"client-{i}");
        }

        // Rapidly leave as server multiple times
        for (int i = 0; i < 5; i++)
        {
            var serverMember = _sessionService.GetSession(sessionId)!.Members.Values
                .First(m => m.Role == MemberRole.Server);
            
            _sessionService.LeaveSession(serverMember.ConnectionId);

            var currentSession = _sessionService.GetSession(sessionId);
            if (currentSession != null && currentSession.Members.Count > 0)
            {
                var serverCount = currentSession.Members.Values.Count(m => m.Role == MemberRole.Server);
                serverCount.Should().Be(1, $"iteration {i}: should always have exactly one server");
            }
        }
    }
}
