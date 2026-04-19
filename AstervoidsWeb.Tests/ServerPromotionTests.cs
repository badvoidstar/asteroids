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

    // ── Orphaned object adoption on rejoin ──────────────────────────────────

    [Fact]
    public void RejoinEmptySession_OrphanedSessionScopedObjectsAdoptedByNewMember()
    {
        // Arrange — solo player creates session with session-scoped objects
        var (session, server) = CreateTestSession("server-conn");
        var gs = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "GameState", ["wave"] = 3 });
        var asteroid = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Server disconnects — session becomes empty, objects orphaned
        SessionService.LeaveSession("server-conn");
        session.Members.Should().BeEmpty();
        session.Objects.Should().HaveCount(2,
            "both session-scoped objects remain (member-scoped would be deleted)");

        // Act — same player reconnects with a new connectionId
        var rejoinResult = SessionService.JoinSession(session.Id, "server-conn-2");

        // Assert — new member adopted orphaned objects
        rejoinResult.Success.Should().BeTrue();
        rejoinResult.Member!.Role.Should().Be(MemberRole.Server);
        var newMemberId = rejoinResult.Member.Id;

        var storedGs = ObjectService.GetObject(session.Id, gs!.Id);
        storedGs.Should().NotBeNull();
        storedGs!.OwnerMemberId.Should().Be(newMemberId,
            "GameState should be adopted by the rejoining member");

        var storedAsteroid = ObjectService.GetObject(session.Id, asteroid!.Id);
        storedAsteroid.Should().NotBeNull();
        storedAsteroid!.OwnerMemberId.Should().Be(newMemberId,
            "asteroid should be adopted by the rejoining member");
    }

    [Fact]
    public void RejoinEmptySession_AdoptedObjectsHaveIncrementedVersion()
    {
        // Arrange
        var (session, server) = CreateTestSession("server-conn");
        var obj = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "GameState" });
        var versionBeforeLeave = obj!.Version;

        SessionService.LeaveSession("server-conn");

        // Act
        SessionService.JoinSession(session.Id, "server-conn-2");

        // Assert — version incremented so clients see it as updated
        var stored = ObjectService.GetObject(session.Id, obj.Id);
        stored!.Version.Should().Be(versionBeforeLeave + 1,
            "adopted objects must have their version incremented");
    }

    [Fact]
    public void RejoinEmptySession_MemberScopedObjectsNotAdopted()
    {
        // Arrange — create both member-scoped and session-scoped objects
        var (session, server) = CreateTestSession("server-conn");
        var memberObj = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "ship" });
        var sessionObj = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "GameState" });

        // Server leaves — member-scoped objects deleted, session-scoped orphaned
        SessionService.LeaveSession("server-conn");

        // Member-scoped object should be deleted
        ObjectService.GetObject(session.Id, memberObj!.Id).Should().BeNull();

        // Act — rejoin
        var rejoinResult = SessionService.JoinSession(session.Id, "server-conn-2");

        // Assert — only session-scoped object was adopted
        var storedSession = ObjectService.GetObject(session.Id, sessionObj!.Id);
        storedSession!.OwnerMemberId.Should().Be(rejoinResult.Member!.Id);
    }

    [Fact]
    public void RejoinNonEmptySession_DoesNotAdoptObjects()
    {
        // Arrange — two players, one leaves while the other stays
        var (session, server, client) = CreateTestSessionWithClient("server-conn", "client-conn");
        var obj = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Server leaves — object migrated to client
        SessionService.LeaveSession("server-conn");
        var stored = ObjectService.GetObject(session.Id, obj!.Id);
        stored!.OwnerMemberId.Should().Be(client.Id, "object migrated to remaining client");

        // Act — new player joins (non-empty session, becomes Client)
        var joinResult = SessionService.JoinSession(session.Id, "new-conn");

        // Assert — joining a non-empty session does NOT adopt objects
        joinResult.Member!.Role.Should().Be(MemberRole.Client);
        stored = ObjectService.GetObject(session.Id, obj.Id);
        stored!.OwnerMemberId.Should().Be(client.Id,
            "object should still be owned by the existing client, not the new joiner");
    }

    [Fact]
    public void RejoinEmptySession_NewMemberCanUpdateAdoptedObjects()
    {
        // Arrange
        var (session, server) = CreateTestSession("server-conn");
        var obj = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "GameState", ["wave"] = 1 });

        SessionService.LeaveSession("server-conn");

        // Act — rejoin and try to update the adopted object
        var rejoinResult = SessionService.JoinSession(session.Id, "server-conn-2");
        var newMemberId = rejoinResult.Member!.Id;

        var updated = ObjectService.UpdateObjects(session.Id, newMemberId,
            [new ObjectUpdate(obj!.Id, new Dictionary<string, object?> { ["wave"] = 5 })]).ToList();

        // Assert — update succeeds (ownership is correct)
        updated.Should().HaveCount(1);
        var storedObj = ObjectService.GetObject(session.Id, obj.Id);
        storedObj!.Data["wave"].Should().Be(5);
    }

    // ── Stale member eviction during rejoin ─────────────────────────────────

    [Fact]
    public void JoinWithEvict_StaleMemberEvicted_NewMemberBecomesServer()
    {
        // Arrange — solo player creates session
        var (session, server) = CreateTestSession("server-conn");
        var oldMemberId = server.Id;
        ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "GameState", ["wave"] = 3 });
        ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Act — reconnect with new connectionId, evicting old member
        var rejoinResult = SessionService.JoinSession(session.Id, "new-conn", oldMemberId);

        // Assert — new member becomes Server (session was effectively empty after eviction)
        rejoinResult.Success.Should().BeTrue();
        rejoinResult.Member!.Role.Should().Be(MemberRole.Server);
        session.Members.Should().HaveCount(1);
        session.Members.Should().NotContainKey(oldMemberId);
    }

    [Fact]
    public void JoinWithEvict_OrphanedObjectsAdopted()
    {
        // Arrange — solo player with session-scoped objects
        var (session, server) = CreateTestSession("server-conn");
        var gs = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "GameState" });
        var asteroid = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Act — rejoin with eviction
        var rejoinResult = SessionService.JoinSession(session.Id, "new-conn", server.Id);
        var newMemberId = rejoinResult.Member!.Id;

        // Assert — session-scoped objects adopted by new member
        var storedGs = ObjectService.GetObject(session.Id, gs!.Id);
        storedGs!.OwnerMemberId.Should().Be(newMemberId);
        var storedAsteroid = ObjectService.GetObject(session.Id, asteroid!.Id);
        storedAsteroid!.OwnerMemberId.Should().Be(newMemberId);
    }

    [Fact]
    public void JoinWithEvict_MemberScopedObjectsDeleted()
    {
        // Arrange — solo player with member-scoped objects (ship, bullets)
        var (session, server) = CreateTestSession("server-conn");
        var ship = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "ship" });
        var bullet = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "bullet" });
        var asteroid = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Act — rejoin with eviction
        var rejoinResult = SessionService.JoinSession(session.Id, "new-conn", server.Id);

        // Assert — member-scoped objects deleted, session-scoped adopted
        ObjectService.GetObject(session.Id, ship!.Id).Should().BeNull();
        ObjectService.GetObject(session.Id, bullet!.Id).Should().BeNull();
        ObjectService.GetObject(session.Id, asteroid!.Id).Should().NotBeNull();
        ObjectService.GetObject(session.Id, asteroid!.Id)!.OwnerMemberId
            .Should().Be(rejoinResult.Member!.Id);
    }

    [Fact]
    public void JoinWithEvict_DoesNotEvictDifferentMember()
    {
        // Arrange — two players in session
        var (session, server, client) = CreateTestSessionWithClient("server-conn", "client-conn");
        var bogusId = Guid.NewGuid(); // Non-existent member ID

        // Act — new player joins with a bogus evict ID
        var joinResult = SessionService.JoinSession(session.Id, "new-conn", bogusId);

        // Assert — both original members still present, new member added
        joinResult.Success.Should().BeTrue();
        session.Members.Should().HaveCount(3);
        session.Members.Should().ContainKey(server.Id);
        session.Members.Should().ContainKey(client.Id);
    }

    [Fact]
    public void JoinWithEvict_DoesNotEvictSameConnection()
    {
        // Arrange — solo player
        var (session, server) = CreateTestSession("server-conn");

        // Act — same connection invokes JoinSession again with self as evict target.
        // This pattern occurs naturally during response-loss recovery: the client
        // doesn't yet know the previous join succeeded, retries with its own old
        // memberId as the evict candidate. The server must NOT self-evict.
        var joinResult = SessionService.JoinSession(session.Id, "server-conn", server.Id);

        // Assert — succeeds idempotently with the existing membership; no eviction.
        joinResult.Success.Should().BeTrue("re-join from the same connection is idempotent (response-loss recovery)");
        joinResult.AlreadyMember.Should().BeTrue();
        joinResult.Eviction.Should().BeNull("idempotent path returns before eviction logic");
        joinResult.Member!.Id.Should().Be(server.Id, "the existing member is returned, not a new one");
        session.Members.Should().HaveCount(1);
        session.Members.Should().ContainKey(server.Id);
    }

    [Fact]
    public void JoinWithEvict_MultiplayerSession_EvictsOnlyTargetMember()
    {
        // Arrange — server + client, server creates objects
        var (session, server, client) = CreateTestSessionWithClient("server-conn", "client-conn");
        var serverAsteroid = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });
        var clientAsteroid = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Act — new connection joins, evicting server
        var rejoinResult = SessionService.JoinSession(session.Id, "new-conn", server.Id);

        // Assert — server evicted, client stays, new member joins
        rejoinResult.Success.Should().BeTrue();
        session.Members.Should().HaveCount(2);
        session.Members.Should().NotContainKey(server.Id);
        session.Members.Should().ContainKey(client.Id);
        session.Members.Should().ContainKey(rejoinResult.Member!.Id);

        // Server's asteroid is migrated to the remaining client (not orphaned).
        var storedServerAsteroid = ObjectService.GetObject(session.Id, serverAsteroid!.Id);
        storedServerAsteroid!.OwnerMemberId.Should().Be(client.Id);

        // Client's asteroid is untouched.
        var storedClientAsteroid = ObjectService.GetObject(session.Id, clientAsteroid!.Id);
        storedClientAsteroid!.OwnerMemberId.Should().Be(client.Id);
    }

    [Fact]
    public void JoinWithEvict_NewMemberCanUpdateAdoptedObjects()
    {
        // Arrange — solo player with GameState
        var (session, server) = CreateTestSession("server-conn");
        var gs = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "GameState", ["wave"] = 1 });

        // Act — rejoin with eviction, then update the adopted object
        var rejoinResult = SessionService.JoinSession(session.Id, "new-conn", server.Id);
        var newMemberId = rejoinResult.Member!.Id;
        var updated = ObjectService.UpdateObjects(session.Id, newMemberId,
            [new ObjectUpdate(gs!.Id, new Dictionary<string, object?> { ["wave"] = 5 })]).ToList();

        // Assert — update succeeds
        updated.Should().HaveCount(1);
        ObjectService.GetObject(session.Id, gs.Id)!.Data["wave"].Should().Be(5);
    }

    // ── Eviction info returned in JoinSessionResult ─────────────────────────

    [Fact]
    public void JoinWithEvict_ReturnsEvictionInfo_WithDeletedAndMigratedObjects()
    {
        // Arrange — server + client; server owns ship (member-scoped) and asteroid (session-scoped)
        var (session, server, client) = CreateTestSessionWithClient("server-conn", "client-conn");
        var ship = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "ship" });
        var asteroid = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Act — reconnect, evicting server
        var rejoinResult = SessionService.JoinSession(session.Id, "new-conn", server.Id);

        // Assert — eviction info present with correct deleted/migrated objects
        rejoinResult.Eviction.Should().NotBeNull();
        rejoinResult.Eviction!.EvictedMemberId.Should().Be(server.Id);
        rejoinResult.Eviction.EvictedConnectionId.Should().Be("server-conn");
        rejoinResult.Eviction.DeletedObjectIds.Should().Contain(ship!.Id);
        rejoinResult.Eviction.MigratedObjects.Should().ContainSingle(m => m.ObjectId == asteroid!.Id);
        rejoinResult.Eviction.MigratedObjects[0].NewOwnerId.Should().Be(client.Id);
    }

    [Fact]
    public void JoinWithEvict_MultiplayerSession_MemberScopedObjectsDeletedAndReported()
    {
        // Arrange — server + client; client owns ship and bullet (member-scoped)
        var (session, server, client) = CreateTestSessionWithClient("server-conn", "client-conn");
        var clientShip = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "ship" });
        var clientBullet = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "bullet" });

        // Act — client reconnects with new connection, evicting old client
        var rejoinResult = SessionService.JoinSession(session.Id, "new-client-conn", client.Id);

        // Assert — member-scoped objects deleted and reported in eviction info
        rejoinResult.Eviction.Should().NotBeNull();
        rejoinResult.Eviction!.DeletedObjectIds.Should().Contain(clientShip!.Id);
        rejoinResult.Eviction!.DeletedObjectIds.Should().Contain(clientBullet!.Id);
        ObjectService.GetObject(session.Id, clientShip.Id).Should().BeNull();
        ObjectService.GetObject(session.Id, clientBullet.Id).Should().BeNull();
    }

    [Fact]
    public void JoinWithEvict_MultiplayerSession_SessionScopedObjectsMigratedToRemainingMember()
    {
        // Arrange — server + client; client owns asteroids (session-scoped)
        var (session, server, client) = CreateTestSessionWithClient("server-conn", "client-conn");
        var asteroid1 = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });
        var asteroid2 = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Act — client reconnects with new connection, evicting old client
        var rejoinResult = SessionService.JoinSession(session.Id, "new-client-conn", client.Id);

        // Assert — session-scoped objects migrated to the remaining server member
        rejoinResult.Eviction.Should().NotBeNull();
        rejoinResult.Eviction!.MigratedObjects.Should().HaveCount(2);
        ObjectService.GetObject(session.Id, asteroid1!.Id)!.OwnerMemberId.Should().Be(server.Id);
        ObjectService.GetObject(session.Id, asteroid2!.Id)!.OwnerMemberId.Should().Be(server.Id);
    }

    [Fact]
    public void JoinWithEvict_EvictionPromotesServerWhenServerEvicted()
    {
        // Arrange — server + client
        var (session, server, client) = CreateTestSessionWithClient("server-conn", "client-conn");

        // Act — server reconnects (evicted), client should be promoted
        var rejoinResult = SessionService.JoinSession(session.Id, "new-server-conn", server.Id);

        // Assert — client promoted to Server
        rejoinResult.Eviction.Should().NotBeNull();
        rejoinResult.Eviction!.PromotedMember.Should().NotBeNull();
        rejoinResult.Eviction!.PromotedMember!.Id.Should().Be(client.Id);
        rejoinResult.Eviction!.PromotedMember!.Role.Should().Be(MemberRole.Server);
        client.Role.Should().Be(MemberRole.Server);
    }

    [Fact]
    public void JoinWithEvict_NoEvictionInfo_WhenNoEvictionNeeded()
    {
        // Arrange — solo player creates session
        var (session, server) = CreateTestSession("server-conn");

        // Act — new player joins without eviction
        var joinResult = SessionService.JoinSession(session.Id, "new-conn");

        // Assert — no eviction info
        joinResult.Success.Should().BeTrue();
        joinResult.Eviction.Should().BeNull();
    }

    [Fact]
    public void JoinWithEvict_SoloSession_EvictionInfoReturned_ObjectsAdoptedAfter()
    {
        // Arrange — solo player with ship (member-scoped) and asteroid (session-scoped)
        var (session, server) = CreateTestSession("server-conn");
        var ship = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "ship" });
        var asteroid = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Act — reconnect (evict old member, join as new — session becomes empty then filled)
        var rejoinResult = SessionService.JoinSession(session.Id, "new-conn", server.Id);
        var newMember = rejoinResult.Member!;

        // Assert — eviction info present
        rejoinResult.Eviction.Should().NotBeNull();
        rejoinResult.Eviction!.DeletedObjectIds.Should().Contain(ship!.Id);
        // Session-scoped objects left in place during eviction (no remaining members)
        // then adopted by AdoptOrphanedObjects when new member joins empty session
        ObjectService.GetObject(session.Id, asteroid!.Id)!.OwnerMemberId.Should().Be(newMember.Id);
    }
}
