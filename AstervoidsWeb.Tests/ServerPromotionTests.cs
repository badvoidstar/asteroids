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
        var session = _sessionService.CreateSession("server-conn", 1.5).Session!;
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
    public void ServerLeaves_MemberScopedObjectsDeleted_SessionScopedMigrated()
    {
        // Arrange
        var result = _sessionService.CreateSession("server-conn", 1.5);
        var session = result.Session!;
        var server = result.Creator!;
        var joinResult = _sessionService.JoinSession(session.Id, "client-conn");
        Assert.True(joinResult.Success);
        var client = joinResult.Member!;

        // Create objects - member-scoped by server, session-scoped by server, member-scoped by client
        var serverMemberObj = _objectService.CreateObject(session.Id, server.Id, ObjectScope.Member);
        var serverSessionObj = _objectService.CreateObject(session.Id, server.Id, ObjectScope.Session);
        var clientObj = _objectService.CreateObject(session.Id, client.Id, ObjectScope.Member);

        // Act
        var leaveResult = _sessionService.LeaveSession("server-conn");
        var departureResult = _objectService.HandleMemberDeparture(session.Id, server.Id, leaveResult!.PromotedMember?.Id);

        // Assert
        departureResult.DeletedObjectIds.Should().Contain(serverMemberObj!.Id);
        departureResult.MigratedObjectIds.Should().Contain(serverSessionObj!.Id);
        departureResult.DeletedObjectIds.Should().NotContain(clientObj!.Id);
        departureResult.MigratedObjectIds.Should().NotContain(clientObj.Id);
    }

    [Fact]
    public void ServerLeaves_SessionVersionShouldIncrement()
    {
        // Arrange
        var session = _sessionService.CreateSession("server-conn", 1.5).Session!;
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
        var session = _sessionService.CreateSession("server-conn", 1.5).Session!;
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
        var session = _sessionService.CreateSession("server-conn", 1.5).Session!;

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
        var session = _sessionService.CreateSession("server-conn", 1.5).Session!;
        var sessionId = session.Id;

        // Simulate rapid joins (only 3 since max is 4)
        var joinTasks = Enumerable.Range(0, 3)
            .Select(i => Task.Run(() => _sessionService.JoinSession(sessionId, $"client-{i}")))
            .ToArray();

        Task.WaitAll(joinTasks);

        // All joins should succeed
        var currentSession = _sessionService.GetSession(sessionId);
        currentSession!.Members.Count.Should().Be(4); // 1 server + 3 clients

        // Simulate rapid leaves (clients only)
        var leaveTasks = Enumerable.Range(0, 3)
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
        var session = _sessionService.CreateSession("server-conn", 1.5).Session!;
        var sessionId = session.Id;

        // Add clients (max 3 since max members is 4)
        for (int i = 0; i < 3; i++)
        {
            _sessionService.JoinSession(sessionId, $"client-{i}");
        }

        // Rapidly leave as server multiple times
        for (int i = 0; i < 3; i++)
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
