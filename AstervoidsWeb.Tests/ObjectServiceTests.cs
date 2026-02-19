using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class ObjectServiceTests
{
    private readonly SessionService _sessionService;
    private readonly ObjectService _objectService;

    public ObjectServiceTests()
    {
        _sessionService = new SessionService();
        _objectService = new ObjectService(_sessionService);
    }

    [Fact]
    public void CreateObject_ShouldCreateObjectWithCorrectAffiliation()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;

        // Act
        var obj = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
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
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");
        Assert.True(joinResult.Success);
        var client = joinResult.Member!;

        // Act
        var obj = _objectService.CreateObject(session.Id, client.Id, ObjectScope.Member, new Dictionary<string, object?>
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
        var obj = _objectService.CreateObject(Guid.NewGuid(), Guid.NewGuid(), ObjectScope.Member);

        // Assert
        obj.Should().BeNull();
    }

    [Fact]
    public void UpdateObject_ShouldMergeData()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;
        var obj = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["x"] = 100.0,
            ["y"] = 200.0
        });

        // Act
        var updated = _objectService.UpdateObject(session.Id, obj!.Id, new Dictionary<string, object?>
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
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;
        var obj = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["x"] = 100.0
        });

        // Act
        var updated = _objectService.UpdateObject(session.Id, obj!.Id, new Dictionary<string, object?>
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
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;
        var obj = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["x"] = 100.0
        });

        // Act
        var updated = _objectService.UpdateObject(session.Id, obj!.Id, new Dictionary<string, object?>
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
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;
        var obj1 = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?> { ["x"] = 0 });
        var obj2 = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?> { ["x"] = 0 });

        var updates = new List<ObjectUpdate>
        {
            new(obj1!.Id, new Dictionary<string, object?> { ["x"] = 100 }),
            new(obj2!.Id, new Dictionary<string, object?> { ["x"] = 200 })
        };

        // Act
        var results = _objectService.UpdateObjects(session.Id, updates).ToList();

        // Assert
        results.Should().HaveCount(2);
        results[0].Data["x"].Should().Be(100);
        results[1].Data["x"].Should().Be(200);
    }

    [Fact]
    public void DeleteObject_ShouldRemoveObject()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;
        var obj = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member);

        // Act
        var deleted = _objectService.DeleteObject(session.Id, obj!.Id);

        // Assert
        deleted.Should().NotBeNull();
        _objectService.GetObject(session.Id, obj.Id).Should().BeNull();
    }

    [Fact]
    public void DeleteObject_NonExistent_ShouldReturnNull()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;

        // Act
        var deleted = _objectService.DeleteObject(session.Id, Guid.NewGuid());

        // Assert
        deleted.Should().BeNull();
    }

    [Fact]
    public void GetSessionObjects_ShouldReturnAllObjects()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;
        _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member);
        _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member);
        _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member);

        // Act
        var objects = _objectService.GetSessionObjects(session.Id).ToList();

        // Assert
        objects.Should().HaveCount(3);
    }

    [Fact]
    public void DeleteObject_AlreadyDeleted_ShouldReturnFalseAndNotCorruptSession()
    {
        // Arrange - simulates two bullets hitting the same asteroid
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;
        var asteroid = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.5,
            ["y"] = 0.5
        });
        var otherObj = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Session);

        // Act - first delete succeeds, second is a no-op
        var firstDelete = _objectService.DeleteObject(session.Id, asteroid!.Id);
        var secondDelete = _objectService.DeleteObject(session.Id, asteroid.Id);

        // Assert - double-delete is safe, other objects unaffected
        firstDelete.Should().NotBeNull();
        secondDelete.Should().BeNull();
        _objectService.GetObject(session.Id, asteroid.Id).Should().BeNull();
        _objectService.GetObject(session.Id, otherObj!.Id).Should().NotBeNull();
        _objectService.GetSessionObjects(session.Id).Should().HaveCount(1);
    }

    [Fact]
    public void UpdateObject_AfterDeletion_ShouldReturnNull()
    {
        // Arrange - simulates an in-flight update arriving after deletion
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;
        var obj = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["x"] = 100.0
        });
        _objectService.DeleteObject(session.Id, obj!.Id);

        // Act - update on deleted object
        var updated = _objectService.UpdateObject(session.Id, obj.Id, new Dictionary<string, object?>
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
        var createResult = _sessionService.CreateSession("connection-1", 1.5);
        var session = createResult.Session!;
        var server = createResult.Creator!;
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");
        var client = joinResult.Member!;

        // Server owns the asteroid
        var asteroid = _objectService.CreateObject(session.Id, server.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.5,
            ["y"] = 0.5,
            ["radius"] = 0.08
        });

        // Each player owns a bullet
        var bullet1 = _objectService.CreateObject(session.Id, server.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });
        var bullet2 = _objectService.CreateObject(session.Id, client.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });

        // Act - first bullet hit: asteroid owner deletes asteroid, creates children
        var asteroidDeleted = _objectService.DeleteObject(session.Id, asteroid!.Id);
        var child1 = _objectService.CreateObject(session.Id, server.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.48,
            ["y"] = 0.5,
            ["radius"] = 0.05
        });
        var child2 = _objectService.CreateObject(session.Id, server.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.52,
            ["y"] = 0.5,
            ["radius"] = 0.05
        });
        var bullet1Deleted = _objectService.DeleteObject(session.Id, bullet1!.Id);

        // Second bullet hit arrives — asteroid already gone
        var secondAsteroidDelete = _objectService.DeleteObject(session.Id, asteroid.Id);
        var asteroidLookup = _objectService.GetObject(session.Id, asteroid.Id);

        // Assert
        asteroidDeleted.Should().NotBeNull();
        child1.Should().NotBeNull();
        child2.Should().NotBeNull();
        bullet1Deleted.Should().NotBeNull();
        secondAsteroidDelete.Should().BeNull("asteroid was already destroyed by first bullet");
        asteroidLookup.Should().BeNull("asteroid should not reappear");

        // Session should contain: child1, child2, bullet2 (bullet1 was deleted)
        var remaining = _objectService.GetSessionObjects(session.Id).ToList();
        remaining.Should().HaveCount(3);
        remaining.Should().Contain(o => o.Id == child1!.Id);
        remaining.Should().Contain(o => o.Id == child2!.Id);
        remaining.Should().Contain(o => o.Id == bullet2!.Id);
    }

    [Fact]
    public void GetObjectCountByType_ShouldCountMatchingObjects()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;

        _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.1
        });
        _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.2
        });
        _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });

        // Act & Assert
        _objectService.GetObjectCountByType(session.Id, "asteroid").Should().Be(2);
        _objectService.GetObjectCountByType(session.Id, "bullet").Should().Be(1);
        _objectService.GetObjectCountByType(session.Id, "ship").Should().Be(0);
    }

    [Fact]
    public void GetObjectCountByType_AfterLastDelete_ShouldReturnZero()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;

        var asteroid = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.5
        });

        // Act
        _objectService.DeleteObject(session.Id, asteroid!.Id);

        // Assert
        _objectService.GetObjectCountByType(session.Id, "asteroid").Should().Be(0);
    }

    [Fact]
    public void GetObjectCountByType_AfterNonLastDelete_ShouldReturnRemaining()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;

        var a1 = _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.1
        });
        _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.2
        });

        // Act
        _objectService.DeleteObject(session.Id, a1!.Id);

        // Assert
        _objectService.GetObjectCountByType(session.Id, "asteroid").Should().Be(1);
    }

    [Fact]
    public void GetObjectCountByType_FirstCreate_ShouldReturnOne()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var creator = result.Creator!;

        // Act
        _objectService.CreateObject(session.Id, creator.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid"
        });

        // Assert
        _objectService.GetObjectCountByType(session.Id, "asteroid").Should().Be(1);
    }

    [Fact]
    public void HandleMemberDeparture_AffectedTypes_ShouldIncludeDeletedTypes()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var server = result.Creator!;
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");
        var client = joinResult.Member!;

        // Client creates member-scoped objects (ship + bullet)
        _objectService.CreateObject(session.Id, client.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "ship"
        });
        _objectService.CreateObject(session.Id, client.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });
        // Server also has a bullet
        _objectService.CreateObject(session.Id, server.Id, ObjectScope.Member, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });

        // Act — client leaves, their member-scoped objects are deleted
        var departure = _objectService.HandleMemberDeparture(session.Id, client.Id, server.Id);

        // Assert — ship type becomes empty (only client had one), bullet does not (server still has one)
        departure.AffectedTypes.Should().Contain("ship");
        departure.AffectedTypes.Should().Contain("bullet");
        _objectService.GetObjectCountByType(session.Id, "ship").Should().Be(0);
        _objectService.GetObjectCountByType(session.Id, "bullet").Should().Be(1);
    }

    [Fact]
    public void HandleMemberDeparture_ClientLeaves_SessionScopedObjectsMigrated()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1", 1.5);
        var session = result.Session!;
        var server = result.Creator!;
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");
        var client = joinResult.Member!;

        // Client owns session-scoped asteroids (from distributed ownership)
        var asteroid = _objectService.CreateObject(session.Id, client.Id, ObjectScope.Session, new Dictionary<string, object?>
        {
            ["type"] = "asteroid", ["x"] = 0.5
        });

        // Act — client leaves, session-scoped objects should migrate to server
        var departure = _objectService.HandleMemberDeparture(session.Id, client.Id, server.Id);

        // Assert
        departure.MigratedObjectIds.Should().Contain(asteroid!.Id);
        var migratedObj = _objectService.GetObject(session.Id, asteroid.Id);
        migratedObj.Should().NotBeNull();
        migratedObj!.OwnerMemberId.Should().Be(server.Id);
        _objectService.GetObjectCountByType(session.Id, "asteroid").Should().Be(1);
    }
}
