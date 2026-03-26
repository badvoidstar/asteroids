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
    public void UpdateObject_WithExpectedVersion_ShouldSucceed()
    {
        // Arrange
        var (session, creator) = CreateTestSession();
        var obj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["x"] = 100.0
        });

        // Act
        var updated = ObjectService.UpdateObject(session.Id, obj!.Id, new Dictionary<string, object?>
        {
            ["x"] = 150.0
        }, expectedVersion: 1);

        // Assert
        updated.Should().NotBeNull();
    }

    [Fact]
    public void UpdateObject_WithWrongVersion_ShouldFail()
    {
        // Arrange
        var (session, creator) = CreateTestSession();
        var obj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["x"] = 100.0
        });

        // Act
        var updated = ObjectService.UpdateObject(session.Id, obj!.Id, new Dictionary<string, object?>
        {
            ["x"] = 150.0
        }, expectedVersion: 999);

        // Assert
        updated.Should().BeNull();
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
        var results = ObjectService.UpdateObjects(session.Id, updates).ToList();

        // Assert
        results.Should().HaveCount(2);
        results[0].Data["x"].Should().Be(100);
        results[1].Data["x"].Should().Be(200);
    }

    [Fact]
    public void DeleteObject_ShouldRemoveObject()
    {
        // Arrange
        var (session, creator) = CreateTestSession();
        var obj = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member);

        // Act
        var deleted = ObjectService.DeleteObject(session.Id, obj!.Id);

        // Assert
        deleted.Should().NotBeNull();
        ObjectService.GetObject(session.Id, obj.Id).Should().BeNull();
    }

    [Fact]
    public void DeleteObject_NonExistent_ShouldReturnNull()
    {
        // Arrange
        var session = SessionService.CreateSession("connection-1", 1.5).Session!;

        // Act
        var deleted = ObjectService.DeleteObject(session.Id, Guid.NewGuid());

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
        var firstDelete = ObjectService.DeleteObject(session.Id, asteroid!.Id);
        var secondDelete = ObjectService.DeleteObject(session.Id, asteroid.Id);

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
        ObjectService.DeleteObject(session.Id, obj!.Id);

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
        var asteroidDeleted = ObjectService.DeleteObject(session.Id, asteroid!.Id);
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
        var bullet1Deleted = ObjectService.DeleteObject(session.Id, bullet1!.Id);

        // Second bullet hit arrives — asteroid already gone
        var secondAsteroidDelete = ObjectService.DeleteObject(session.Id, asteroid.Id);
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
    public void HandleMemberDeparture_ClientLeaves_SessionScopedObjectsMigrated()
    {
        // Arrange
        var (session, server, client) = CreateTestSessionWithClient();

        // Client owns session-scoped asteroids (from distributed ownership)
        var asteroid = ObjectService.CreateObject(session.Id, client.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.5
        });

        // Act — client leaves, session-scoped objects should migrate to server
        var departure = ObjectService.HandleMemberDeparture(session.Id, client.Id, new List<Guid> { server.Id });

        // Assert
        departure.MigratedObjects.Should().Contain(m => m.ObjectId == asteroid!.Id);
        var migratedObj = ObjectService.GetObject(session.Id, asteroid.Id);
        migratedObj.Should().NotBeNull();
        migratedObj!.OwnerMemberId.Should().Be(server.Id);
        ObjectService.GetSessionObjects(session.Id).Count(o => o.Data.TryGetValue("type", out var t) && t?.ToString() == "asteroid").Should().Be(1);
    }

    [Fact]
    public void HandleMemberDeparture_MigratedObjects_ShouldIncludeNewVersion()
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

        // Act — client leaves
        var departure = ObjectService.HandleMemberDeparture(session.Id, client.Id, new List<Guid> { server.Id });

        // Assert — migration should include the version AFTER the migration increment
        var migration = departure.MigratedObjects.First(m => m.ObjectId == asteroid.Id);
        var serverObj = ObjectService.GetObject(session.Id, asteroid.Id);
        migration.NewVersion.Should().Be(serverObj!.Version);
        migration.NewVersion.Should().Be(4); // v1 (create) + v2 (update1) + v3 (update2) + v4 (migration)
    }

    [Fact]
    public void HandleMemberDeparture_MigratedObject_ShouldRefreshUpdatedAt()
    {
        // Arrange
        var (session, server, client) = CreateTestSessionWithClient();
        var asteroid = _objectService.CreateObject(session.Id, client.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid"
        });
        asteroid!.UpdatedAt = DateTime.UtcNow.AddMinutes(-1);
        var originalUpdatedAt = asteroid.UpdatedAt;

        // Act
        _objectService.HandleMemberDeparture(session.Id, client.Id, new List<Guid> { server.Id });

        // Assert
        var migratedObject = _objectService.GetObject(session.Id, asteroid.Id);
        migratedObject.Should().NotBeNull();
        migratedObject!.UpdatedAt.Should().BeAfter(originalUpdatedAt);
    }

    [Fact]
    public void HandleMemberDeparture_MultipleObjectsMigrated_EachHasCorrectVersion()
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

        // Act
        var departure = ObjectService.HandleMemberDeparture(session.Id, client.Id, new List<Guid> { server.Id });

        // Assert — each migration carries the post-increment version
        var m1 = departure.MigratedObjects.First(m => m.ObjectId == obj1.Id);
        var m2 = departure.MigratedObjects.First(m => m.ObjectId == obj2.Id);
        m1.NewVersion.Should().Be(4); // 1 (create) + 2 updates + 1 migration = 4
        m2.NewVersion.Should().Be(2); // 1 (create) + 1 migration = 2
    }

    [Fact]
    public void UpdateObjects_WithVersionMismatch_ShouldPartiallySucceed()
    {
        // Arrange — simulates version drift where one object's version has advanced
        var (session, creator) = CreateTestSession();
        var obj1 = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?> { ["x"] = 0 });
        var obj2 = ObjectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?> { ["x"] = 0 });

        // Advance obj2's version by updating it directly
        ObjectService.UpdateObject(session.Id, obj2!.Id, new Dictionary<string, object?> { ["x"] = 50 });
        // obj2 is now at version 2

        var updates = new List<ObjectUpdate>
        {
            new(obj1!.Id, new Dictionary<string, object?> { ["x"] = 100 }, ExpectedVersion: 1), // correct version
            new(obj2.Id, new Dictionary<string, object?> { ["x"] = 200 }, ExpectedVersion: 1)   // stale version (should be 2)
        };

        // Act
        var results = ObjectService.UpdateObjects(session.Id, updates).ToList();

        // Assert — only obj1 should be updated; obj2 rejected due to version mismatch
        results.Should().HaveCount(1);
        results[0].Id.Should().Be(obj1.Id);
        results[0].Data["x"].Should().Be(100);

        // obj2 should remain unchanged
        var obj2State = ObjectService.GetObject(session.Id, obj2.Id);
        obj2State!.Data["x"].Should().Be(50);
        obj2State.Version.Should().Be(2);
    }
}
