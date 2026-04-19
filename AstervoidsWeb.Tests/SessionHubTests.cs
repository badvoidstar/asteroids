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
    /// Verifies that the snapshot is captured AFTER AddToGroupAsync so that any
    /// concurrent broadcast during the group-add window is delivered to the joiner
    /// (in-group) and the snapshot reflects the now-current state.
    ///
    /// The reverse order would leave a window where a broadcast is sent to the group
    /// before the new connection is in it — the joiner would never receive it, and
    /// the snapshot would carry an older view of the affected object. Sticky update
    /// content (e.g. pendingHit flags that don't repeat in subsequent updates) would
    /// be lost permanently. The client deduplicates by version in handleSessionJoined
    /// and handleRemoteObjectsUpdated, so any double-delivery is harmless.
    /// </summary>
    [Fact]
    public async Task JoinSession_AddsToGroupBeforeSnapshot_ConcurrentObjectIncludedInSnapshot()
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
        // With correct ordering (AddToGroup first, then snapshot), this object MUST
        // appear in the join response because the snapshot is captured after the add.
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

        // Concurrent object MUST be in the snapshot — snapshot is taken after AddToGroup,
        // so the joiner sees the up-to-date state. Any duplicate live broadcast is
        // deduplicated client-side via version comparison.
        response.Objects.Should().Contain(o => o.Id == concurrentObjectId,
            "snapshot taken after AddToGroupAsync must reflect concurrent state changes");
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
            Mock.Of<ILogger<SessionHub>>(),
            new ServerMetricsService());

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

    /// <summary>
    /// Verifies the eviction broadcast in JoinSession runs BEFORE AddToGroupAsync
    /// for the new connection. This ordering ensures the joiner does not receive
    /// an OnMemberLeft event for a member they never saw join. The order is:
    /// 1. EvictMemberInternal removes stale member
    /// 2. RemoveFromGroupAsync drops stale connection
    /// 3. SendAsync OnMemberLeft to group (joiner not yet in group)
    /// 4. AddToGroupAsync adds new joiner
    /// 5. ToSessionSnapshot captures state
    /// </summary>
    [Fact]
    public async Task JoinSession_WithEviction_BroadcastsEvictionBeforeAddingJoinerToGroup()
    {
        // Arrange: existing member that will be evicted (simulating stale reconnect)
        var createResult = _sessionService.CreateSession("connection-old");
        var session = createResult.Session!;
        var staleMember = createResult.Creator!;

        var callOrder = new List<string>();
        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, CancellationToken>((conn, _, _) => callOrder.Add($"add:{conn}"))
            .Returns(Task.CompletedTask);
        groups
            .Setup(g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, CancellationToken>((conn, _, _) => callOrder.Add($"remove:{conn}"))
            .Returns(Task.CompletedTask);

        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((method, _, _) => callOrder.Add($"send:{method}"))
            .Returns(Task.CompletedTask);

        var hub = new SessionHub(_sessionService, _objectService,
            Mock.Of<ILogger<SessionHub>>(), new ServerMetricsService());
        var context = new Mock<HubCallerContext>();
        context.SetupGet(c => c.ConnectionId).Returns("connection-new");
        hub.Context = context.Object;
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(clientProxy.Object);
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(clientProxy.Object);
        hub.Clients = clients.Object;
        hub.Groups = groups.Object;

        // Act: join with eviction
        var response = await hub.JoinSession(session.Id, staleMember.Id);

        // Assert
        response.Should().NotBeNull();
        var evictRemoveIdx = callOrder.IndexOf("remove:connection-old");
        var evictBroadcastIdx = callOrder.IndexOf("send:OnMemberLeft");
        var addNewJoinerIdx = callOrder.IndexOf("add:connection-new");

        evictRemoveIdx.Should().BeGreaterThanOrEqualTo(0, "stale connection must be removed from group");
        evictBroadcastIdx.Should().BeGreaterThanOrEqualTo(0, "eviction OnMemberLeft must be broadcast");
        addNewJoinerIdx.Should().BeGreaterThanOrEqualTo(0, "new joiner must be added to group");

        evictBroadcastIdx.Should().BeLessThan(addNewJoinerIdx,
            "eviction broadcast must complete before new joiner is added to group");
    }

    /// <summary>
    /// Verifies AddToGroupAsync for the new joiner happens BEFORE the snapshot is
    /// captured, so any concurrent broadcast in the gap is delivered to the joiner
    /// (in-group) and the snapshot reflects current state. The reverse order would
    /// cause sticky update content (e.g. pendingHit flags) to be lost.
    /// </summary>
    [Fact]
    public async Task JoinSession_AddsToGroupBeforeCapturingSnapshot()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;

        var addToGroupCalled = false;
        var snapshotCapturedAfterAdd = false;

        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, CancellationToken>((_, _, _) =>
            {
                addToGroupCalled = true;
                // Mutate session state mid-add: snapshot taken AFTER must include this
                _objectService.CreateObject(session.Id, createResult.Creator!.Id,
                    Models.ObjectScope.Session,
                    new Dictionary<string, object?> { ["type"] = "post-add" });
            })
            .Returns(Task.CompletedTask);
        groups
            .Setup(g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var hub = CreateHub("connection-2", groups);

        // Act
        var response = await hub.JoinSession(session.Id);

        // Assert
        response.Should().NotBeNull();
        addToGroupCalled.Should().BeTrue();
        snapshotCapturedAfterAdd = response!.Objects.Any(o =>
            o.Data.TryGetValue("type", out var t) && (t as string) == "post-add");
        snapshotCapturedAfterAdd.Should().BeTrue(
            "snapshot must be captured after AddToGroupAsync to include concurrent state changes");
    }

    /// <summary>
    /// Regression: BroadcastToOthersAsync / BroadcastToAllAsync MUST use SendCoreAsync,
    /// not SendAsync. SendAsync has no params object?[] overload, so SendAsync(method, args)
    /// would resolve to SendAsync(string, object?) and wrap the entire args array as a
    /// single client argument — clients expect multiple positional args (e.g.
    /// OnObjectCreated(objectInfo, memberId, sequence, timestamp) → 4 args). This test
    /// verifies CreateObject's broadcast spreads its args correctly.
    /// </summary>
    [Fact]
    public async Task CreateObject_BroadcastsArgsAsMultiplePositionalArguments()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;

        object?[]? capturedArgs = null;
        string? capturedMethod = null;

        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((m, a, _) =>
            {
                capturedMethod = m;
                capturedArgs = a;
            })
            .Returns(Task.CompletedTask);

        var hub = new SessionHub(_sessionService, _objectService,
            Mock.Of<ILogger<SessionHub>>(), new ServerMetricsService());
        var context = new Mock<HubCallerContext>();
        context.SetupGet(c => c.ConnectionId).Returns("connection-1");
        hub.Context = context.Object;
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(clientProxy.Object);
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(clientProxy.Object);
        hub.Clients = clients.Object;
        var groups = new Mock<IGroupManager>();
        groups.Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        hub.Groups = groups.Object;

        // Act
        var response = await hub.CreateObject(
            new Dictionary<string, object?> { ["type"] = "asteroid" }, "Session");

        // Assert
        response.Should().NotBeNull();
        capturedMethod.Should().Be("OnObjectCreated");
        capturedArgs.Should().NotBeNull();
        // OnObjectCreated(objectInfo, memberId, memberSequence, serverTimestamp) = 4 args.
        // If SendAsync wrapping bug regresses, this will be 1 (an object?[] of length 4).
        capturedArgs!.Length.Should().Be(4,
            "broadcast helpers must spread args via SendCoreAsync, not wrap them through SendAsync(string, object?)");
    }
}
