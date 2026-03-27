using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
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

        // Act — departure info (deleted/migrated objects) is now part of the unified LeaveSession result
        var leaveResult = SessionService.LeaveSession("server-conn");

        // Assert
        leaveResult!.DeletedObjectIds.Should().Contain(serverMemberObj!.Id);
        leaveResult.MigratedObjects.Select(m => m.ObjectId).Should().Contain(serverSessionObj!.Id);
        leaveResult.DeletedObjectIds.Should().NotContain(clientObj!.Id);
        leaveResult.MigratedObjects.Select(m => m.ObjectId).Should().NotContain(clientObj.Id);
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
    public async Task ConcurrentJoinsAndLeaves_ShouldMaintainSessionIntegrity()
    {
        // Arrange
        var (session, _) = CreateTestSession("server-conn");
        var sessionId = session.Id;

        // Simulate rapid joins (only 3 since max is 4)
        var joinTasks = Enumerable.Range(0, 3)
            .Select(i => Task.Run(() => SessionService.JoinSession(sessionId, $"client-{i}")))
            .ToArray();

        await Task.WhenAll(joinTasks);

        // All joins should succeed
        var currentSession = SessionService.GetSession(sessionId);
        currentSession!.Members.Count.Should().Be(4); // 1 server + 3 clients

        // Simulate rapid leaves (clients only)
        var leaveTasks = Enumerable.Range(0, 3)
            .Select(i => Task.Run(() => SessionService.LeaveSession($"client-{i}")))
            .ToArray();

        await Task.WhenAll(leaveTasks);

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

    // ── New tests covering departure/promotion/migration sequencing ──────────

    [Fact]
    public void LeaveSession_RemainingMemberIds_ExcludesDepartedMember()
    {
        // Arrange
        var (session, server, client) = CreateTestSessionWithClient("server-conn", "client-conn");

        // Act — server leaves
        var result = SessionService.LeaveSession("server-conn");

        // Assert
        result.Should().NotBeNull();
        result!.RemainingMemberIds.Should().NotContain(server.Id,
            "the departing member must never appear in the remaining list");
        result.RemainingMemberIds.Should().Contain(client.Id,
            "the surviving client must be in the remaining list");
    }

    [Fact]
    public void LeaveSession_RemainingMemberIds_IncludesPromotedMember()
    {
        // Arrange — server + 3 clients
        var (session, server, _) = CreateTestSessionWithClient("server-conn", "client1-conn");
        var client2 = SessionService.JoinSession(session.Id, "client2-conn").Member!;
        var client3 = SessionService.JoinSession(session.Id, "client3-conn").Member!;

        // Act — server leaves; one client is promoted
        var result = SessionService.LeaveSession("server-conn");

        // Assert
        result.Should().NotBeNull();
        result!.PromotedMember.Should().NotBeNull();
        result.RemainingMemberIds.Should().Contain(result.PromotedMember!.Id,
            "the promoted member must appear in the remaining list");
        result.RemainingMemberIds.Should().NotContain(server.Id,
            "the departed server must not appear");
        result.RemainingMemberIds.Should().HaveCount(3,
            "all three surviving clients should be in the list");
    }

    [Fact]
    public void LeaveSession_LastMemberLeaves_RemainingMemberIdsIsEmpty()
    {
        // Arrange
        var (_, server) = CreateTestSession("server-conn");

        // Act — only member leaves
        var result = SessionService.LeaveSession("server-conn");

        // Assert
        result.Should().NotBeNull();
        result!.RemainingMemberIds.Should().BeEmpty(
            "no members remain after the last member leaves");
    }

    [Fact]
    public void ServerLeaves_WithThreeClients_SessionScopedObjectsDistributedToAllRemaining()
    {
        // Arrange — server + 3 clients, distribution enabled (default)
        var (session, server, client1) = CreateTestSessionWithClient("server-conn", "client1-conn");
        var client2 = SessionService.JoinSession(session.Id, "client2-conn").Member!;
        var client3 = SessionService.JoinSession(session.Id, "client3-conn").Member!;

        // Server owns 6 session-scoped objects
        for (int i = 0; i < 6; i++)
        {
            ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
                new Dictionary<string, object?> { ["type"] = "asteroid", ["i"] = i });
        }

        // Act — server leaves; use the atomically captured remaining IDs from the result
        var leaveResult = SessionService.LeaveSession("server-conn");
        leaveResult.Should().NotBeNull();

        // Assert — all 6 objects migrated, none deleted (departure result is now inline in LeaveSession)
        leaveResult!.DeletedObjectIds.Should().BeEmpty();
        leaveResult.MigratedObjects.Should().HaveCount(6);

        // Every migrated object must be owned by one of the three remaining clients
        var remainingIdSet = new HashSet<Guid>(leaveResult.RemainingMemberIds);
        foreach (var migration in leaveResult.MigratedObjects)
        {
            remainingIdSet.Should().Contain(migration.NewOwnerId,
                "migrated objects must only go to valid remaining members");
            migration.NewOwnerId.Should().NotBe(server.Id,
                "migrated objects must never be assigned back to the departing member");
        }
    }

    [Fact]
    public void ServerLeaves_WithThreeClients_MigratedObjectVersionsIncremented()
    {
        // Arrange
        var (session, server, _) = CreateTestSessionWithClient("server-conn", "client1-conn");
        SessionService.JoinSession(session.Id, "client2-conn");
        SessionService.JoinSession(session.Id, "client3-conn");

        var obj = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });
        ObjectService.UpdateObject(session.Id, obj!.Id, new Dictionary<string, object?> { ["x"] = 1.0 });
        // version is now 2

        // Act — departure result (including migration info) is now unified in LeaveSession
        var leaveResult = SessionService.LeaveSession("server-conn");

        // Assert — version incremented exactly once during migration (2 → 3)
        var migration = leaveResult!.MigratedObjects.First(m => m.ObjectId == obj.Id);
        migration.NewVersion.Should().Be(3,
            "migration must increment the version exactly once");
        var storedObj = ObjectService.GetObject(session.Id, obj.Id);
        storedObj!.Version.Should().Be(migration.NewVersion);
    }

    [Fact]
    public void ServerLeaves_PromotionAndMigrationAligned_PromotedMemberCanReceiveObjects()
    {
        // Arrange — server + 2 clients
        var (session, server, client1) = CreateTestSessionWithClient("server-conn", "client1-conn");
        var client2 = SessionService.JoinSession(session.Id, "client2-conn").Member!;

        // Server owns 4 session-scoped objects
        var objects = Enumerable.Range(0, 4)
            .Select(i => ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
                new Dictionary<string, object?> { ["type"] = "asteroid" })!)
            .ToList();

        // Act — use exactly the snapshot captured atomically in LeaveSession
        var leaveResult = SessionService.LeaveSession("server-conn");
        leaveResult.Should().NotBeNull();

        // Assert — promoted member is in the remaining list so it can receive objects
        leaveResult!.PromotedMember.Should().NotBeNull();
        leaveResult.RemainingMemberIds.Should().Contain(leaveResult.PromotedMember!.Id);

        // At least one migrated object should have gone to the promoted member
        var promotedMemberGotObject = leaveResult.MigratedObjects
            .Any(m => m.NewOwnerId == leaveResult.PromotedMember.Id);
        promotedMemberGotObject.Should().BeTrue(
            "the promoted server must be eligible to receive migrated objects");

        // No object should reference the departed server
        leaveResult.MigratedObjects
            .Should().NotContain(m => m.NewOwnerId == server.Id,
                "departed member must not be assigned any migrated objects");
    }
}
