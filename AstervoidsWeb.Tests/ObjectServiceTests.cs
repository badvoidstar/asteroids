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
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;
        var creator = result.Creator!;

        // Act
        var obj = _objectService.CreateObject(session.Id, creator.Id, new Dictionary<string, object?>
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
        obj.AffiliatedRole.Should().Be(MemberRole.Server);
        obj.Data["type"].Should().Be("asteroid");
        obj.Version.Should().Be(1);
    }

    [Fact]
    public void CreateObject_ClientCreatesObject_ShouldHaveClientAffiliation()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");
        Assert.True(joinResult.Success);
        var client = joinResult.Member!;

        // Act
        var obj = _objectService.CreateObject(session.Id, client.Id, new Dictionary<string, object?>
        {
            ["type"] = "bullet"
        });

        // Assert
        obj.Should().NotBeNull();
        obj!.AffiliatedRole.Should().Be(MemberRole.Client);
    }

    [Fact]
    public void CreateObject_InvalidSession_ShouldReturnNull()
    {
        // Act
        var obj = _objectService.CreateObject(Guid.NewGuid(), Guid.NewGuid());

        // Assert
        obj.Should().BeNull();
    }

    [Fact]
    public void UpdateObject_ShouldMergeData()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;
        var creator = result.Creator!;
        var obj = _objectService.CreateObject(session.Id, creator.Id, new Dictionary<string, object?>
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
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;
        var creator = result.Creator!;
        var obj = _objectService.CreateObject(session.Id, creator.Id, new Dictionary<string, object?>
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
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;
        var creator = result.Creator!;
        var obj = _objectService.CreateObject(session.Id, creator.Id, new Dictionary<string, object?>
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
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;
        var creator = result.Creator!;
        var obj1 = _objectService.CreateObject(session.Id, creator.Id, new Dictionary<string, object?> { ["x"] = 0 });
        var obj2 = _objectService.CreateObject(session.Id, creator.Id, new Dictionary<string, object?> { ["x"] = 0 });

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
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;
        var creator = result.Creator!;
        var obj = _objectService.CreateObject(session.Id, creator.Id);

        // Act
        var deleted = _objectService.DeleteObject(session.Id, obj!.Id);

        // Assert
        deleted.Should().BeTrue();
        _objectService.GetObject(session.Id, obj.Id).Should().BeNull();
    }

    [Fact]
    public void DeleteObject_NonExistent_ShouldReturnFalse()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;

        // Act
        var deleted = _objectService.DeleteObject(session.Id, Guid.NewGuid());

        // Assert
        deleted.Should().BeFalse();
    }

    [Fact]
    public void GetSessionObjects_ShouldReturnAllObjects()
    {
        // Arrange
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;
        var creator = result.Creator!;
        _objectService.CreateObject(session.Id, creator.Id);
        _objectService.CreateObject(session.Id, creator.Id);
        _objectService.CreateObject(session.Id, creator.Id);

        // Act
        var objects = _objectService.GetSessionObjects(session.Id).ToList();

        // Assert
        objects.Should().HaveCount(3);
    }
}
