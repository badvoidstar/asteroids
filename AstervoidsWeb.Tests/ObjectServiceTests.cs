using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class ObjectServiceTests : TestBase
{

    [Fact]
    public void CreateObject_ShouldCreateObjectWithCorrectAffiliation()
    {
        // Arrange
        var (session, creator) = CreateTestSession();

        // Act
        var obj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 100.0,
            ["y"] = 200.0
        });

        // Assert
        obj.Should().NotBeNull();
        obj!.Id.Should().NotBe(Guid.Empty);
        obj.SessionId.Should().Be(session.Id);
        obj.CreatorMemberId.Should().Be(creator.Id);
        obj.OwnerMemberId.Should().Be(creator.Id);
        obj.Scope.Should().Be(ObjectScope.Session);
        obj.Data["type"].Should().Be("asteroid");
        obj.Version.Should().Be(1);
    }

    [Fact]
    public void CreateObject_ClientCreatesObject_ShouldHaveClientAffiliation()
    {
        // Arrange
        var (session, _, client) = CreateTestSessionWithClient();

        // Act
        var obj = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });

        // Assert
        obj.Should().NotBeNull();
        obj!.OwnerMemberId.Should().Be(client.Id);
        obj.Scope.Should().Be(ObjectScope.Member);
    }

    [Fact]
    public void CreateObject_InvalidSession_ShouldReturnNull()
    {
        // Act
        var obj = ObjectService.CreateObject(Guid.NewGuid(), Guid.NewGuid(), ObjectScope.Member);

        // Assert
        obj.Should().BeNull();
    }

    [Fact]
    public void CreateObject_WithOwnerMemberId_ShouldSetDifferentOwner()
    {
        // Arrange
        var (session, creator, otherMember) = CreateTestSessionWithClient();

        // Act
        var obj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" }, ownerMemberId: otherMember.Id);

        // Assert
        obj.Should().NotBeNull();
        obj!.CreatorMemberId.Should().Be(creator.Id);
        obj.OwnerMemberId.Should().Be(otherMember.Id);
    }

    [Fact]
    public void CreateObject_WithInvalidOwnerMemberId_ShouldReturnNull()
    {
        // Arrange
        var (session, creator) = CreateTestSession();

        // Act
        var obj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Session,
            ownerMemberId: Guid.NewGuid());

        // Assert
        obj.Should().BeNull();
    }

    [Fact]
    public void UpdateObject_ShouldMergeData()
    {
        // Arrange
        var (session, creator) = CreateTestSession();
        var obj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["x"] = 100.0,
            ["y"] = 200.0
        });

        // Act
        var updated = ObjectService.UpdateObject(session.Id, obj!.Id, new Dictionary<string, object?>
        {
            ["x"] = 150.0,
            ["z"] = 50.0
        });

        // Assert
        updated.Should().NotBeNull();
        updated!.Data["x"].Should().Be(150.0);
        updated.Data["y"].Should().Be(200.0);
        updated.Data["z"].Should().Be(50.0);
        updated.Version.Should().Be(2);
    }

    [Fact]
    public void UpdateObjects_ShouldBatchUpdate()
    {
        // Arrange
        var (session, creator) = CreateTestSession();
        var obj1 = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?> { ["x"] = 0 });
        var obj2 = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?> { ["x"] = 0 });

        var updates = new List<ObjectUpdate>
        {
            new(obj1!.Id, new Dictionary<string, object?> { ["x"] = 100 }),
            new(obj2!.Id, new Dictionary<string, object?> { ["x"] = 200 })
        };

        // Act
        var results = ObjectService.UpdateObjects(session.Id, creator.Id, updates).ToList();
    }

    [Fact]
    public void DeleteObject_ShouldRemoveObject()
    {
        // Arrange
        var (session, creator) = CreateTestSession();
        var obj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member);

        // Act
        var deleted = ObjectService.DeleteObject(session.Id, obj!.Id, creator.Id);

        // Assert
        deleted.Should().NotBeNull();
        ObjectService.GetObject(session.Id, obj.Id).Should().BeNull();
    }

    [Fact]
    public void DeleteObject_NonExistent_ShouldReturnNull()
    {
        // Arrange
        var session = SessionService.CreateSession("connection-1").Session!;
        var creator = SessionService.GetMemberByConnectionId("connection-1")!;

        // Act
        var deleted = ObjectService.DeleteObject(session.Id, Guid.NewGuid(), creator.Id);

        // Assert
        deleted.Should().BeNull();
    }

    [Fact]
    public void GetSessionObjects_ShouldReturnAllObjects()
    {
        // Arrange
        var (session, creator) = CreateTestSession();
        ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member);
        ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member);
        ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member);

        // Act
        var objects = ObjectService.GetSessionObjects(session.Id).ToList();

        // Assert
        objects.Should().HaveCount(3);
    }

    [Fact]
    public void DeleteObject_AlreadyDeleted_ShouldReturnFalseAndNotCorruptSession()
    {
        // Arrange - simulates two bullets hitting the same asteroid
        var (session, creator) = CreateTestSession();
        var asteroid = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.5,
            ["y"] = 0.5
        });
        var otherObj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Session);

        // Act - first delete succeeds, second is a no-op
        var firstDelete = ObjectService.DeleteObject(session.Id, asteroid!.Id, creator.Id);
        var secondDelete = ObjectService.DeleteObject(session.Id, asteroid.Id, creator.Id);

        // Assert - double-delete is safe, other objects unaffected
        firstDelete.Should().NotBeNull();
        secondDelete.Should().BeNull();
        ObjectService.GetObject(session.Id, asteroid.Id).Should().BeNull();
        ObjectService.GetObject(session.Id, otherObj!.Id).Should().NotBeNull();
        ObjectService.GetSessionObjects(session.Id).Should().HaveCount(1);
    }

    [Fact]
    public void UpdateObject_AfterDeletion_ShouldReturnNull()
    {
        // Arrange - simulates an in-flight update arriving after deletion
        var (session, creator) = CreateTestSession();
        var obj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["x"] = 100.0
        });
        ObjectService.DeleteObject(session.Id, obj!.Id, creator.Id);

        // Act - update on deleted object
        var updated = ObjectService.UpdateObject(session.Id, obj.Id, new Dictionary<string, object?>
        {
            ["x"] = 200.0
        });

        // Assert - gracefully returns null, no exception
        updated.Should().BeNull();
    }

    [Fact]
    public void ConcurrentCollision_TwoBulletsHitSameAsteroid_SecondDeleteIsSafe()
    {
        // Arrange - two players each fire a bullet at the same asteroid
        var (session, server, client) = CreateTestSessionWithClient();

        // Server owns the asteroid
        var asteroid = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.5,
            ["y"] = 0.5,
            ["radius"] = 0.08
        });

        // Each player owns a bullet
        var bullet1 = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });
        var bullet2 = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });

        // Act - first bullet hit: asteroid owner deletes asteroid, creates children
        var asteroidDeleted = ObjectService.DeleteObject(session.Id, asteroid!.Id, server.Id);
        var child1 = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.48,
            ["y"] = 0.5,
            ["radius"] = 0.05
        });
        var child2 = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.52,
            ["y"] = 0.5,
            ["radius"] = 0.05
        });
        var bullet1Deleted = ObjectService.DeleteObject(session.Id, bullet1!.Id, server.Id);

        // Second bullet hit arrives — asteroid already gone
        var secondAsteroidDelete = ObjectService.DeleteObject(session.Id, asteroid.Id, server.Id);
        var asteroidLookup = ObjectService.GetObject(session.Id, asteroid.Id);

        // Assert
        asteroidDeleted.Should().NotBeNull();
        child1.Should().NotBeNull();
        child2.Should().NotBeNull();
        bullet1Deleted.Should().NotBeNull();
        secondAsteroidDelete.Should().BeNull("asteroid was already destroyed by first bullet");
        asteroidLookup.Should().BeNull("asteroid should not reappear");

        // Session should contain: child1, child2, bullet2 (bullet1 was deleted)
        var remaining = ObjectService.GetSessionObjects(session.Id).ToList();
        remaining.Should().HaveCount(3);
        remaining.Should().Contain(o => o.Id == child1!.Id);
        remaining.Should().Contain(o => o.Id == child2!.Id);
        remaining.Should().Contain(o => o.Id == bullet2!.Id);
    }

    [Fact]
    public void GetObjectCountByType_ShouldCountMatchingObjects()
    {
        // Arrange
        var (session, creator) = CreateTestSession();

        ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.1
        });
        ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.2
        });
        ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });

        // Act & Assert — verify objects exist via GetSessionObjects
        var objects = ObjectService.GetSessionObjects(session.Id).ToList();
        objects.Count(o => o.Data.TryGetValue("type", out var t) && t?.ToString() == "asteroid").Should().Be(2);
        objects.Count(o => o.Data.TryGetValue("type", out var t) && t?.ToString() == "bullet").Should().Be(1);
    }

    [Fact]
    public void MemberDeparture_ClientLeaves_SessionScopedObjectsMigrated()
    {
        // Arrange
        var (session, server, client) = CreateTestSessionWithClient();

        // Client owns session-scoped asteroids (from distributed ownership)
        var asteroid = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.5
        });

        // Act — client leaves; departure (including object migration) happens atomically in LeaveSession
        var departure = SessionService.LeaveSession("connection-2");

        // Assert
        departure!.MigratedObjects.Should().Contain(m => m.ObjectId == asteroid!.Id);
        var migratedObj = ObjectService.GetObject(session.Id, asteroid!.Id);
        migratedObj.Should().NotBeNull();
        migratedObj!.OwnerMemberId.Should().Be(server.Id);
        ObjectService.GetSessionObjects(session.Id).Count(o => o.Data.TryGetValue("type", out var t) && t?.ToString() == "asteroid").Should().Be(1);
    }

    [Fact]
    public void MemberDeparture_MigratedObjects_ShouldIncludeNewVersion()
    {
        // Arrange
        var (session, server, client) = CreateTestSessionWithClient();

        var asteroid = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.5
        });

        // Update the object a few times to advance the version
        ObjectService.UpdateObject(session.Id, asteroid!.Id, new Dictionary<string, object?> { ["x"] = 0.6 });
        ObjectService.UpdateObject(session.Id, asteroid.Id, new Dictionary<string, object?> { ["x"] = 0.7 });

        // Act — client leaves; migration version is included in the unified result
        var departure = SessionService.LeaveSession("connection-2");

        // Assert — migration should include the version AFTER the migration increment
        var migration = departure!.MigratedObjects.First(m => m.ObjectId == asteroid.Id);
        var serverObj = ObjectService.GetObject(session.Id, asteroid.Id);
        migration.NewVersion.Should().Be(serverObj!.Version);
        migration.NewVersion.Should().Be(4); // v1 (create) + v2 (update1) + v3 (update2) + v4 (migration)
    }

    [Fact]
    public void MemberDeparture_MigratedObject_ShouldRefreshUpdatedAt()
    {
        // Arrange
        var (session, server, client) = CreateTestSessionWithClient();
        var asteroid = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid"
        });
        asteroid!.UpdatedAt = DateTime.UtcNow.AddMinutes(-1);
        var originalUpdatedAt = asteroid.UpdatedAt;

        // Act
        SessionService.LeaveSession("connection-2");

        // Assert
        var migratedObject = ObjectService.GetObject(session.Id, asteroid.Id);
        migratedObject.Should().NotBeNull();
        migratedObject!.UpdatedAt.Should().BeAfter(originalUpdatedAt);
    }

    [Fact]
    public void MemberDeparture_MultipleObjectsMigrated_EachHasCorrectVersion()
    {
        // Arrange
        var (session, server, client) = CreateTestSessionWithClient();

        var obj1 = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid"
        });
        // Update obj1 twice → version 3
        ObjectService.UpdateObject(session.Id, obj1!.Id, new Dictionary<string, object?> { ["x"] = 1 });
        ObjectService.UpdateObject(session.Id, obj1.Id, new Dictionary<string, object?> { ["x"] = 2 });

        var obj2 = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid"
        });
        // obj2 stays at version 1 (no updates)

        // Act — client leaves; unified departure result contains migration info
        var departure = SessionService.LeaveSession("connection-2");

        // Assert — each migration carries the post-increment version
        var m1 = departure!.MigratedObjects.First(m => m.ObjectId == obj1.Id);
        var m2 = departure.MigratedObjects.First(m => m.ObjectId == obj2!.Id);
        m1.NewVersion.Should().Be(4); // 1 (create) + 2 updates + 1 migration = 4
        m2.NewVersion.Should().Be(2); // 1 (create) + 1 migration = 2
    }

    // ── ValidAt validation/storage tests ─────────────────────────────────────────
    //
    // These cover the unified server-time interpolation axis from the service layer.
    // ObjectService.ValidateValidAt applies a ±2s sanity bound vs the server's
    // hub-entry receive time, then a monotonic cap vs the object's previous ValidAt.
    // The validated value is stored on SessionObject.ValidAt and observable via
    // ObjectInfo.ValidAt / ObjectUpdateInfo.ValidAt on the wire.

    [Fact]
    public void CreateObject_ShouldStoreClientValidAt_WhenWithinSanityBounds()
    {
        var (session, creator) = CreateTestSession();
        var receive = 1_000_000_000_000L;
        var clientStamp = receive - 250; // 250 ms before receive — well within ±2s.

        var obj = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" },
            clientValidAt: clientStamp,
            serverReceiveTimeMs: receive);

        obj.Should().NotBeNull();
        obj!.ValidAt.Should().Be(clientStamp,
            "in-bounds clientValidAt should be stored verbatim as the unified-axis anchor");
    }

    [Fact]
    public void CreateObject_ShouldFallBackToServerReceiveTime_WhenClientStampOutOfBounds()
    {
        var (session, creator) = CreateTestSession();
        var receive = 1_000_000_000_000L;
        var clientStamp = receive - 10_000; // 10s in the past — far outside the 2s window.

        var obj = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" },
            clientValidAt: clientStamp,
            serverReceiveTimeMs: receive);

        obj.Should().NotBeNull();
        obj!.ValidAt.Should().Be(receive,
            "out-of-bounds clientValidAt must fall back to the server's hub-entry receive time");
    }

    [Fact]
    public void UpdateObject_ShouldEnforceMonotonicCap_AgainstPreviousValidAt()
    {
        var (session, creator) = CreateTestSession();
        var receiveCreate = 1_000_000_000_000L;
        var obj = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["x"] = 1.0 },
            clientValidAt: receiveCreate,
            serverReceiveTimeMs: receiveCreate)!;

        // Update with a clientValidAt that is BEFORE the current ValidAt.
        // Validation should keep ValidAt monotonic — clamp to the previous value.
        var receiveUpdate = receiveCreate + 500;
        var staleClientStamp = receiveCreate - 200; // older than obj.ValidAt
        var updated = ObjectService.UpdateObject(
            session.Id, obj.Id,
            new Dictionary<string, object?> { ["x"] = 2.0 },
            clientValidAt: staleClientStamp,
            serverReceiveTimeMs: receiveUpdate);

        updated.Should().NotBeNull();
        updated!.ValidAt.Should().Be(receiveCreate,
            "monotonic cap must prevent ValidAt from going backwards");
    }

    [Fact]
    public void ReplaceObject_ShouldStampAllChildrenWithValidatedValidAt()
    {
        var (session, creator) = CreateTestSession();
        var receiveCreate = 1_000_000_000_000L;
        var parent = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" },
            clientValidAt: receiveCreate,
            serverReceiveTimeMs: receiveCreate)!;

        var receiveReplace = receiveCreate + 500;
        var collisionStamp = receiveCreate + 250; // newer than parent, in-bounds vs receive.
        var children = ObjectService.ReplaceObject(
            session.Id, parent.Id, creator.Id,
            new List<ReplacementObjectSpec>
            {
                new(ObjectScope.Session, new Dictionary<string, object?> { ["type"] = "asteroid", ["fragment"] = 1 }),
                new(ObjectScope.Session, new Dictionary<string, object?> { ["type"] = "asteroid", ["fragment"] = 2 })
            },
            clientValidAt: collisionStamp,
            serverReceiveTimeMs: receiveReplace);

        children.Should().NotBeNull();
        children!.Should().HaveCount(2);
        children.Should().AllSatisfy(c =>
            c.ValidAt.Should().Be(collisionStamp,
                "all replacement children must share the parent's collision moment as their unified-axis anchor"));
    }

    [Fact]
    public void UpdateObjects_AllObjectsShareCallLevelValidAt()
    {
        // Per-object ValidAt was removed in favor of a single per-batch validAt.
        // All objects in a single UpdateObjects call must receive the same
        // validated call-level stamp.
        var (session, creator) = CreateTestSession();
        var receiveCreate = 1_000_000_000_000L;
        var obj1 = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["x"] = 1.0 },
            clientValidAt: receiveCreate,
            serverReceiveTimeMs: receiveCreate)!;
        var obj2 = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["x"] = 2.0 },
            clientValidAt: receiveCreate,
            serverReceiveTimeMs: receiveCreate)!;

        var receiveUpdate = receiveCreate + 1000;
        var callLevelStamp = receiveCreate + 500;

        var updated = ObjectService.UpdateObjects(
            session.Id, creator.Id,
            new List<ObjectUpdate>
            {
                new(obj1.Id, new Dictionary<string, object?> { ["x"] = 10.0 }),
                new(obj2.Id, new Dictionary<string, object?> { ["x"] = 20.0 })
            },
            callLevelClientValidAt: callLevelStamp,
            serverReceiveTimeMs: receiveUpdate).ToList();

        updated.Should().HaveCount(2);
        updated.First(o => o.Id == obj1.Id).ValidAt.Should().Be(callLevelStamp,
            "all objects in a batch must share the call-level validAt");
        updated.First(o => o.Id == obj2.Id).ValidAt.Should().Be(callLevelStamp,
            "all objects in a batch must share the call-level validAt");
    }

}
