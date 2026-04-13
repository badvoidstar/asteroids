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
        var createResult = _sessionService.CreateSession("connection-1");
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
        var createResult = _sessionService.CreateSession("connection-1");
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

    /// <summary>
    /// Verifies that the snapshot is captured before AddToGroupAsync so that objects created
    /// concurrently during the group-add window are not included in the join response.
    /// Without the fix, a concurrent object creation between AddToGroupAsync and ToSessionSnapshot
    /// would appear in both the snapshot (join response) and as a live event, causing the joining
    /// client to apply the same object twice.
    /// </summary>
    [Fact]
    public async Task JoinSession_SnapshotCapturedBeforeGroupAdd_ConcurrentObjectExcludedFromSnapshot()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;

        var preJoinObject = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });

        Guid? concurrentObjectId = null;

        // When AddToGroupAsync fires, simulate another client creating an object.
        // With correct ordering (snapshot before add), this object must NOT appear in the
        // join response because the snapshot was already materialized.
        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, CancellationToken>((_, _, _) =>
            {
                var concurrent = _objectService.CreateObject(
                    session.Id, creator.Id, Models.ObjectScope.Session,
                    new Dictionary<string, object?> { ["type"] = "concurrent-asteroid" });
                concurrentObjectId = concurrent?.Id;
            })
            .Returns(Task.CompletedTask);

        var hub = CreateHub("connection-2", groups);

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert
        response.Should().NotBeNull();
        response!.Members.Should().HaveCount(2);
        concurrentObjectId.Should().NotBeNull("concurrent object should have been created during AddToGroupAsync");

        // Pre-join object must be in the snapshot
        response.Objects.Should().Contain(o => o.Id == preJoinObject!.Id,
            "objects that existed before the join must appear in the snapshot");

        // Concurrent object must NOT be in the snapshot — it was created after the snapshot
        // was captured. The joining client will receive it via a live OnObjectCreated event.
        response.Objects.Should().NotContain(o => o.Id == concurrentObjectId,
            "objects created after the snapshot was captured must not appear in the join response");
    }

    [Fact]
    public async Task JoinSession_SnapshotIncludesJoiningMember()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var hub = CreateHub("connection-2");

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert — the joiner's own member record must appear in the snapshot because
        // SessionService.JoinSession() adds them to session.Members before returning,
        // so the snapshot taken immediately after always reflects the full post-join membership.
        response.Should().NotBeNull();
        response!.Members.Should().HaveCount(2, "snapshot must include both the creator and the joiner");
        response.Members.Should().Contain(m => m.Role == "Client",
            "the joining member should appear as Client in the snapshot");
    }

    private SessionHub CreateHub(string connectionId, Mock<IGroupManager>? groupsMock = null)
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

        var groups = groupsMock ?? new Mock<IGroupManager>();
        if (groupsMock == null)
        {
            groups
                .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .Returns(Task.CompletedTask);
        }
        groups
            .Setup(g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        hub.Groups = groups.Object;

        return hub;
    }
}
