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

    [Fact]
    public void Ping_ShouldReturnUtcMillisecondsCloseToNow()
    {
        // Arrange — Ping requires no session membership, but the existing
        // CreateHub helper sets up a connection context. Just call directly.
        var hub = CreateHub("connection-ping");
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Act
        var result = hub.Ping();

        // Assert
        var after = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        result.Should().BeGreaterThanOrEqualTo(before);
        result.Should().BeLessThanOrEqualTo(after);
    }

    [Fact]
    public void Ping_ShouldSucceedWithoutSessionMembership()
    {
        // Arrange — fresh hub with no session, no member.
        var hub = CreateHub("connection-no-session");

        // Act + Assert — does not throw, returns a positive UTC ms value.
        var act = () => hub.Ping();
        var result = act.Should().NotThrow().Which;
        result.Should().BeGreaterThan(0);
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
        // validAt is now embedded in ObjectInfo (not a trailing arg).
        // If SendAsync wrapping bug regresses, this will be 1 (an object?[] of length 4).
        capturedArgs!.Length.Should().Be(4,
            "broadcast helpers must spread args via SendCoreAsync, not wrap them through SendAsync(string, object?)");
    }

    /// <summary>
    /// Owner-stamped validAt (unified server-time interpolation axis): ReplaceObject
    /// should accept an optional clientValidAt and stamp it on each child's
    /// ObjectInfo.ValidAt when within ±2s of the server's hub-entry timestamp.
    /// </summary>
    [Fact]
    public async Task ReplaceObject_ShouldUseClientValidAt_WhenWithinSanityBounds()
    {
        // Arrange — create a session and an object owned by the connecting member.
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var parent = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        // clientValidAt within sanity bounds AND newer than the parent's stored
        // ValidAt (which the monotonic cap protects against regression).
        var hubEntry = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntry + 100;

        // Act
        var result = await hub.ReplaceObject(parent.Id,
            new List<Dictionary<string, object?>>
            {
                new() { ["type"] = "asteroid" }
            },
            scope: "Session",
            ownerMemberId: null,
            clientValidAt: clientStamp);

        // Assert — broadcast carries 4 args: replaceEvent, memberId, memberSeq, serverTimestamp.
        // validAt is now embedded in each ObjectInfo inside replaceEvent.CreatedObjects.
        result.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(4,
            "OnObjectReplaced broadcast must include serverTimestamp (hub-entry, for recordPacketArrival); validAt is per-child inside ObjectInfo");
        var replaceEvent = (ObjectReplacedEvent)capturedArgs[0]!;
        replaceEvent.CreatedObjects.Should().NotBeEmpty();
        replaceEvent.CreatedObjects[0].ValidAt.Should().Be(clientStamp,
            "in-bounds clientValidAt should be forwarded verbatim as the unified-axis anchor on each child");
    }

    [Fact]
    public async Task ReplaceObject_ShouldFallBackToServerTimestamp_WhenClientStampOutOfBounds()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var parent = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        // Wildly out-of-bounds: 10s in the past (would mean 10s clock skew, far above 2s tolerance).
        var hubEntryEstimate = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntryEstimate - 10_000;

        // Act
        var result = await hub.ReplaceObject(parent.Id,
            new List<Dictionary<string, object?>>
            {
                new() { ["type"] = "asteroid" }
            },
            scope: "Session",
            ownerMemberId: null,
            clientValidAt: clientStamp);

        // Assert
        result.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(4);
        var serverTimestamp = (long)capturedArgs[3]!;
        var replaceEvent = (ObjectReplacedEvent)capturedArgs[0]!;
        replaceEvent.CreatedObjects[0].ValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "out-of-bounds clientValidAt must be rejected and the child's validAt should fall back to the hub-entry serverTimestamp");
    }

    [Fact]
    public async Task ReplaceObject_ShouldFallBackToServerTimestamp_WhenClientStampOmitted()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        var parent = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        // Act — omit clientValidAt (older clients, or unbootstrapped offset).
        var result = await hub.ReplaceObject(parent.Id,
            new List<Dictionary<string, object?>>
            {
                new() { ["type"] = "asteroid" }
            });

        // Assert
        result.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(4);
        var serverTimestamp = (long)capturedArgs[3]!;
        var replaceEvent = (ObjectReplacedEvent)capturedArgs[0]!;
        replaceEvent.CreatedObjects[0].ValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "null clientValidAt must fall back to the hub-entry serverTimestamp");
    }

    // ─────────────────────────────────────────────────────────────────────
    // CreateObject / UpdateObjects — clientValidAt clamp + fallback coverage
    //
    // These mirror the ReplaceObject tests above. The shared ValidateValidAt
    // helper (in ObjectService) applies a ±2s sanity bound vs. the hub-entry
    // serverTimestamp. Within bounds: client value wins (eliminates upload-time
    // bias from the unified server-time interpolation axis). Out-of-bounds or
    // null: fall back to serverTimestamp so receivers always have a usable
    // anchor. The validated value is stored on SessionObject.ValidAt and
    // surfaced to receivers via ObjectInfo.ValidAt / ObjectUpdateInfo.ValidAt.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task CreateObject_ShouldUseClientValidAt_WhenWithinSanityBounds()
    {
        // Arrange — second member so the OthersInGroup broadcast captures args
        // (the creating member is excluded by OthersInGroup).
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var hubEntry = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntry - 250;

        // Act
        var response = await hub.CreateObject(
            new Dictionary<string, object?> { ["type"] = "asteroid" },
            scope: "Session",
            ownerMemberId: null,
            clientValidAt: clientStamp);

        // Assert — broadcast is OnObjectCreated(objectInfo, memberId, memberSeq, serverTimestamp) = 4 args.
        // validAt is embedded in ObjectInfo.
        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(4,
            "OnObjectCreated broadcast carries serverTimestamp; validAt is embedded in ObjectInfo");
        var objectInfo = (ObjectInfo)capturedArgs[0]!;
        objectInfo.ValidAt.Should().Be(clientStamp,
            "in-bounds clientValidAt should be forwarded verbatim as the unified-axis anchor");
    }

    [Fact]
    public async Task CreateObject_ShouldFallBackToServerTimestamp_WhenClientStampOutOfBounds()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var hubEntryEstimate = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntryEstimate - 10_000; // 10s in the past — far outside the 2s window.

        var response = await hub.CreateObject(
            new Dictionary<string, object?> { ["type"] = "asteroid" },
            scope: "Session",
            ownerMemberId: null,
            clientValidAt: clientStamp);

        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(4);
        var serverTimestamp = (long)capturedArgs[3]!;
        var objectInfo = (ObjectInfo)capturedArgs[0]!;
        objectInfo.ValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "out-of-bounds clientValidAt must fall back to the hub-entry serverTimestamp");
    }

    [Fact]
    public async Task CreateObject_ShouldFallBackToServerTimestamp_WhenClientStampOmitted()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var response = await hub.CreateObject(
            new Dictionary<string, object?> { ["type"] = "asteroid" },
            scope: "Session");

        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(4);
        var serverTimestamp = (long)capturedArgs[3]!;
        var objectInfo = (ObjectInfo)capturedArgs[0]!;
        objectInfo.ValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "null clientValidAt must fall back to the hub-entry serverTimestamp");
    }

    [Fact]
    public async Task UpdateObjects_ShouldUseClientValidAt_WhenWithinSanityBounds()
    {
        // Arrange — owner needs an existing object to update.
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var obj = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var hubEntry = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Newer than the existing object's ValidAt so the monotonic cap doesn't override.
        var clientStamp = hubEntry + 100;

        var updates = new List<ObjectUpdateRequest>
        {
            new(obj.Id, new Dictionary<string, object?> { ["x"] = 0.5 })
        };

        // Act
        var response = await hub.UpdateObjects(
            updates,
            senderSequence: 1,
            senderSendIntervalMs: 100,
            clientValidAt: clientStamp);

        // Assert — broadcast is OnObjectsUpdated(updateInfos, memberId, senderSeq, memberSeq, serverTimestamp, senderSendIntervalMs) = 6 args.
        // validAt is per-object inside each ObjectUpdateInfo.
        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(6,
            "OnObjectsUpdated broadcast carries serverTimestamp + senderSendIntervalMs; validAt is per-object inside each ObjectUpdateInfo");
        var updateInfos = (List<ObjectUpdateInfo>)capturedArgs[0]!;
        updateInfos.Should().NotBeEmpty();
        updateInfos[0].ValidAt.Should().Be(clientStamp,
            "in-bounds clientValidAt should be forwarded verbatim as the unified-axis anchor on each update");
    }

    [Fact]
    public async Task UpdateObjects_ShouldFallBackToServerTimestamp_WhenClientStampOutOfBounds()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var obj = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var hubEntryEstimate = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clientStamp = hubEntryEstimate + 10_000; // 10s in the future — far outside the 2s window.

        var updates = new List<ObjectUpdateRequest>
        {
            new(obj.Id, new Dictionary<string, object?> { ["x"] = 0.5 })
        };

        var response = await hub.UpdateObjects(
            updates,
            senderSequence: 1,
            senderSendIntervalMs: 100,
            clientValidAt: clientStamp);

        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(6);
        var serverTimestamp = (long)capturedArgs[4]!;
        var updateInfos = (List<ObjectUpdateInfo>)capturedArgs[0]!;
        updateInfos[0].ValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "out-of-bounds clientValidAt must fall back to the hub-entry serverTimestamp");
    }

    [Fact]
    public async Task UpdateObjects_ShouldFallBackToServerTimestamp_WhenClientStampOmitted()
    {
        var createResult = _sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        var creator = createResult.Creator!;
        _sessionService.JoinSession(session.Id, "connection-2");
        var obj = _objectService.CreateObject(
            session.Id, creator.Id, Models.ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" })!;

        object?[]? capturedArgs = null;
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Callback<string, object?[], CancellationToken>((_, a, _) => capturedArgs = a)
            .Returns(Task.CompletedTask);

        var hub = CreateHubWithProxy("connection-1", clientProxy);

        var updates = new List<ObjectUpdateRequest>
        {
            new(obj.Id, new Dictionary<string, object?> { ["x"] = 0.5 })
        };

        var response = await hub.UpdateObjects(updates);

        response.Should().NotBeNull();
        capturedArgs.Should().NotBeNull();
        capturedArgs!.Length.Should().Be(6);
        var serverTimestamp = (long)capturedArgs[4]!;
        var updateInfos = (List<ObjectUpdateInfo>)capturedArgs[0]!;
        updateInfos[0].ValidAt.Should().BeCloseTo(serverTimestamp, 50,
            "null clientValidAt must fall back to the hub-entry serverTimestamp");
    }

    private SessionHub CreateHubWithProxy(string connectionId, Mock<IClientProxy> proxy)
    {
        var hub = new SessionHub(_sessionService, _objectService,
            Mock.Of<ILogger<SessionHub>>(), new ServerMetricsService());
        var context = new Mock<HubCallerContext>();
        context.SetupGet(c => c.ConnectionId).Returns(connectionId);
        hub.Context = context.Object;
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(proxy.Object);
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(proxy.Object);
        hub.Clients = clients.Object;
        var groups = new Mock<IGroupManager>();
        groups.Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        hub.Groups = groups.Object;
        return hub;
    }
}
