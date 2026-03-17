using AstervoidsWeb.Models;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class ServerPromotionTests : TestBase
{

    [Fact]
    public void ServerLeaves_WithMultipleClients_ShouldPromoteOneClient()
    {
        // Arrange
        var (session, _) = CreateTestSession("server-conn");
        SessionService.JoinSession(session.Id, "client1-conn");
        SessionService.JoinSession(session.Id, "client2-conn");
        SessionService.JoinSession(session.Id, "client3-conn");

        // Act
        var result = SessionService.LeaveSession("server-conn");

        // Assert
        result.Should().NotBeNull();
        result!.PromotedMember.Should().NotBeNull();
        result.PromotedMember!.Role.Should().Be(MemberRole.Server);

        // Verify only one server exists
        var remainingSession = SessionService.GetSession(session.Id);
        var servers = remainingSession!.Members.Values.Where(m => m.Role == MemberRole.Server).ToList();
        servers.Should().HaveCount(1);
    }

    [Fact]
    public void ServerLeaves_MemberScopedObjectsDeleted_SessionScopedMigrated()
    {
        // Arrange
        var (session, server, client) = CreateTestSessionWithClient("server-conn", "client-conn");

        // Create objects - member-scoped by server, session-scoped by server, member-scoped by client
        var serverMemberObj = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Member);
        var serverSessionObj = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session);
        var clientObj = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Member);

        // Act
        var leaveResult = SessionService.LeaveSession("server-conn");
        var remainingIds = leaveResult!.PromotedMember != null 
            ? new List<Guid> { leaveResult.PromotedMember.Id } 
            : new List<Guid>();
        var departureResult = ObjectService.HandleMemberDeparture(session.Id, server.Id, remainingIds);

        // Assert
        departureResult.DeletedObjectIds.Should().Contain(serverMemberObj!.Id);
        departureResult.MigratedObjects.Select(m => m.ObjectId).Should().Contain(serverSessionObj!.Id);
        departureResult.DeletedObjectIds.Should().NotContain(clientObj!.Id);
        departureResult.MigratedObjects.Select(m => m.ObjectId).Should().NotContain(clientObj.Id);
    }

    [Fact]
    public void ServerLeaves_SessionVersionShouldIncrement()
    {
        // Arrange
        var (session, _) = CreateTestSession("server-conn");
        SessionService.JoinSession(session.Id, "client-conn");
        var initialVersion = session.Version;

        // Act
        SessionService.LeaveSession("server-conn");

        // Assert
        var updatedSession = SessionService.GetSession(session.Id);
        updatedSession!.Version.Should().Be(initialVersion + 1);
    }

    [Fact]
    public void ClientLeaves_ShouldNotAffectServerRole()
    {
        // Arrange
        var (session, _) = CreateTestSession("server-conn");
        SessionService.JoinSession(session.Id, "client-conn");

        // Act
        var result = SessionService.LeaveSession("client-conn");

        // Assert
        result.Should().NotBeNull();
        result!.PromotedMember.Should().BeNull();

        var serverMember = SessionService.GetMemberByConnectionId("server-conn");
        serverMember!.Role.Should().Be(MemberRole.Server);
    }

    [Fact]
    public void ServerLeaves_NoClients_ShouldKeepSessionForTimeout()
    {
        // Arrange
        var (session, _) = CreateTestSession("server-conn");

        // Act
        var result = SessionService.LeaveSession("server-conn");

        // Assert
        result.Should().NotBeNull();
        result!.SessionDestroyed.Should().BeFalse();
        result.PromotedMember.Should().BeNull();
        var remainingSession = SessionService.GetSession(session.Id);
        remainingSession.Should().NotBeNull();
        remainingSession!.Members.Should().BeEmpty();
        remainingSession.LastMemberLeftAt.Should().NotBeNull();
    }

    [Fact]
    public void ConcurrentJoinsAndLeaves_ShouldMaintainSessionIntegrity()
    {
        // Arrange
        var (session, _) = CreateTestSession("server-conn");
        var sessionId = session.Id;

        // Simulate rapid joins (only 3 since max is 4)
        var joinTasks = Enumerable.Range(0, 3)
            .Select(i => Task.Run(() => SessionService.JoinSession(sessionId, $"client-{i}")))
            .ToArray();

        Task.WaitAll(joinTasks);

        // All joins should succeed
        var currentSession = SessionService.GetSession(sessionId);
        currentSession!.Members.Count.Should().Be(4); // 1 server + 3 clients

        // Simulate rapid leaves (clients only)
        var leaveTasks = Enumerable.Range(0, 3)
            .Select(i => Task.Run(() => SessionService.LeaveSession($"client-{i}")))
            .ToArray();

        Task.WaitAll(leaveTasks);

        // Session should still exist with just the server
        currentSession = SessionService.GetSession(sessionId);
        currentSession!.Members.Count.Should().Be(1);
        currentSession.Members.Values.First().Role.Should().Be(MemberRole.Server);
    }

    [Fact]
    public void RapidServerChanges_ShouldAlwaysHaveOneServer()
    {
        // Arrange
        var (session, _) = CreateTestSession("server-conn");
        var sessionId = session.Id;

        // Add clients (max 3 since max members is 4)
        for (int i = 0; i < 3; i++)
        {
            SessionService.JoinSession(sessionId, $"client-{i}");
        }

        // Rapidly leave as server multiple times
        for (int i = 0; i < 3; i++)
        {
            var serverMember = SessionService.GetSession(sessionId)!.Members.Values
                .First(m => m.Role == MemberRole.Server);
            
            SessionService.LeaveSession(serverMember.ConnectionId);

            var currentSession = SessionService.GetSession(sessionId);
            if (currentSession != null && currentSession.Members.Count > 0)
            {
                var serverCount = currentSession.Members.Values.Count(m => m.Role == MemberRole.Server);
                serverCount.Should().Be(1, $"iteration {i}: should always have exactly one server");
            }
        }
    }
}
