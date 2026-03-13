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
