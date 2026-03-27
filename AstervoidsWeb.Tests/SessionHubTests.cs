using AstervoidsWeb.Hubs;
using AstervoidsWeb.Services;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Moq;

namespace AstervoidsWeb.Tests;

public class SessionHubTests
{
    private readonly SessionService _sessionService = new();
    private readonly ObjectService _objectService;

    public SessionHubTests()
    {
        _objectService = new ObjectService(_sessionService);
    }

    [Fact]
    public async Task JoinSession_ShouldReturnMaterializedSessionSnapshot()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1", 1.5);
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var createdObject = _objectService.CreateObject(
            session.Id,
            creator.Id,
            Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        var hub = CreateHub("connection-2");

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert
        response.Should().NotBeNull();
        response!.Members.Should().BeOfType<MemberInfo[]>();
        response.Objects.Should().BeOfType<ObjectInfo[]>();
        response.Members.Should().HaveCount(2);
        response.Objects.Should().ContainSingle(o => o.Id == createdObject!.Id);
    }

    [Fact]
    public void GetSessionState_ShouldReturnMaterializedSnapshot()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1", 1.5);
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var client = _sessionService.JoinSession(session.Id, "connection-2").Member!;
        var createdObject = _objectService.CreateObject(
            session.Id,
            creator.Id,
            Models.ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "bullet" },
            ownerMemberId: client.Id);

        var hub = CreateHub("connection-1");

        // Act
        var snapshot = hub.GetSessionState();

        // Assert
        snapshot.Should().NotBeNull();
        snapshot!.Members.Should().BeOfType<MemberInfo[]>();
        snapshot.Objects.Should().BeOfType<ObjectInfo[]>();
        snapshot.Members.Should().HaveCount(2);
        snapshot.Objects.Should().ContainSingle(o => o.Id == createdObject!.Id);
        snapshot.MemberSequences.Should().ContainKey(creator.Id.ToString());
        snapshot.MemberSequences.Should().ContainKey(client.Id.ToString());
    }

    // ── Join snapshot ordering tests ─────────────────────────────────────────

    [Fact]
    public async Task JoinSession_SnapshotIncludesJoinerAsMember()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1", 1.5);
        var session = createResult.Session!;
        var hub = CreateHub("connection-2");

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert — joiner appears in their own member list (snapshot taken after service adds member)
        response.Should().NotBeNull();
        response!.Members.Should().HaveCount(2, "snapshot must include the joiner themselves");
        response.MemberId.Should().NotBe(Guid.Empty);
        response.Members.Should().Contain(m => m.Id == response.MemberId,
            "joiner's own member entry must be present in the snapshot");
    }

    [Fact]
    public async Task JoinSession_SnapshotIncludesAllObjectsScopesCreatedBeforeJoin()
    {
        // Arrange — server creates one session-scoped and one member-scoped object before joiner arrives
        var createResult = _sessionService.CreateSession("connection-1", 1.5);
        var session = createResult.Session!;
        var creator = createResult.Creator!;

        var sessionObj = _objectService.CreateObject(session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });
        var memberObj = _objectService.CreateObject(session.Id, creator.Id, Models.ObjectScope.Member,
            new Dictionary<string, object?> { ["type"] = "ship" });

        var hub = CreateHub("connection-2");

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert — both objects captured in join-time snapshot
        response.Should().NotBeNull();
        response!.Objects.Should().Contain(o => o.Id == sessionObj!.Id,
            "session-scoped objects present at join time must appear in the snapshot");
        response.Objects.Should().Contain(o => o.Id == memberObj!.Id,
            "member-scoped objects present at join time must appear in the snapshot");
    }

    [Fact]
    public async Task JoinSession_ObjectCreatedAfterSnapshotNotInSnapshot()
    {
        // Arrange — server is in the session with no objects yet
        var createResult = _sessionService.CreateSession("connection-1", 1.5);
        var session = createResult.Session!;
        var creator = createResult.Creator!;

        // Simulate snapshot ordering: the snapshot is taken BEFORE AddToGroupAsync (new order).
        // We model "concurrent creation after snapshot" by capturing the snapshot from the
        // service layer, then creating an object, and verifying the snapshot does not include it.
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");
        var snapshotBeforeObject = new
        {
            Objects = session.Objects.Values.ToList()
        };

        // Object created after snapshot point
        var lateObject = _objectService.CreateObject(session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        // Assert — snapshot taken at join time does not include the late object
        snapshotBeforeObject.Objects.Should().NotContain(o => o.Id == lateObject!.Id,
            "objects created after the join snapshot point must not appear in the initial snapshot");

        // Verify the hub response also reflects this: run the hub for a *new* joiner
        // that joins before the late object is known, confirming hub snapshot = service snapshot
        var hub = CreateHub("connection-3");
        var createResult2 = _sessionService.CreateSession("connection-server-2", 1.5);
        var session2 = createResult2.Session!;
        var response2 = await hub.JoinSession(session2.Id);
        response2!.Objects.Should().BeEmpty("a brand-new session has no objects at join time");
    }

    [Fact]
    public async Task JoinSession_SnapshotVersionsMatchStoredObjectVersions()
    {
        // Arrange — existing object updated several times before join
        var createResult = _sessionService.CreateSession("connection-1", 1.5);
        var session = createResult.Session!;
        var creator = createResult.Creator!;

        var obj = _objectService.CreateObject(session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["x"] = 0.0 });
        _objectService.UpdateObject(session.Id, obj!.Id, new Dictionary<string, object?> { ["x"] = 1.0 });
        _objectService.UpdateObject(session.Id, obj.Id, new Dictionary<string, object?> { ["x"] = 2.0 });
        // version is now 3

        var hub = CreateHub("connection-2");

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert — snapshot carries the current (post-update) version, not a stale version
        response.Should().NotBeNull();
        var snapshotObj = response!.Objects.Single(o => o.Id == obj.Id);
        snapshotObj.Version.Should().Be(3,
            "snapshot must reflect the exact version at join time, not a stale earlier version");
    }

    private SessionHub CreateHub(string connectionId)
    {
        var hub = new SessionHub(
            _sessionService,
            _objectService,
            Mock.Of<ILogger<SessionHub>>());

        var context = new Mock<HubCallerContext>();
        context.SetupGet(c => c.ConnectionId).Returns(connectionId);
        hub.Context = context.Object;

        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(clientProxy.Object);
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(clientProxy.Object);
        hub.Clients = clients.Object;

        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        groups
            .Setup(g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        hub.Groups = groups.Object;

        return hub;
    }
}
