using AstervoidsWeb.Configuration;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Regression tests for the schema-registry teardown lifecycle. Pre-fix,
/// SessionHub.LeaveSession called <c>SyncSchemaRegistry.ClearSession</c> on
/// last-member-leave, but the underlying session is NOT torn down at that
/// point — it sits in an empty grace window where a rejoin can still occur.
/// Clearing the registry too early broke positional payloads from the
/// rejoiner with "Schema not registered for session..." until cleanup
/// destroyed the session.
///
/// Post-fix, ClearSession is invoked from <see cref="SessionCleanupService"/>
/// at the actual destroy point (after <c>ForceDestroySession</c>), so:
///   1. Last-leave preserves schemas (rejoin works).
///   2. Cleanup destroys the session AND clears the registry (no leak).
/// </summary>
public class SessionCleanupServiceTests
{
    private static IHubContext<SessionHub> CreateHubContextMock()
    {
        var clientProxy = new Mock<IClientProxy>();
        clientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var singleClientProxy = new Mock<ISingleClientProxy>();
        singleClientProxy
            .Setup(p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object?[]>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var clients = new Mock<IHubClients>();
        clients.Setup(c => c.Client(It.IsAny<string>())).Returns(singleClientProxy.Object);
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(clientProxy.Object);

        var groups = new Mock<IGroupManager>();
        groups
            .Setup(g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var hubContext = new Mock<IHubContext<SessionHub>>();
        hubContext.SetupGet(h => h.Clients).Returns(clients.Object);
        hubContext.SetupGet(h => h.Groups).Returns(groups.Object);
        return hubContext.Object;
    }

    private static SessionCleanupService CreateCleanupService(
        ISessionService sessionService,
        SyncSchemaRegistry registry,
        int emptyTimeoutSeconds = 0)
    {
        var settings = Options.Create(new SessionSettings
        {
            EmptyTimeoutSeconds = emptyTimeoutSeconds,
            AbsoluteTimeoutMinutes = 60_000,
        });
        return new SessionCleanupService(
            sessionService,
            CreateHubContextMock(),
            registry,
            settings,
            Mock.Of<ILogger<SessionCleanupService>>());
    }

    private static PositionalSchemaCodec.Schema MakeSchema(byte id) =>
        new(id, new[] { new PositionalSchemaCodec.FieldSpec("x", "f64") });

    /// <summary>
    /// Pre-fix regression: the last member leaving a session called
    /// <c>SyncSchemaRegistry.ClearSession</c> from <see cref="SessionHub"/>,
    /// breaking subsequent rejoins. Post-fix, the schemas MUST survive the
    /// last-leave so a rejoiner can take over the still-alive session.
    /// </summary>
    [Fact]
    public void LastMemberLeave_KeepsSchemaRegistryIntact_ForRejoinPath()
    {
        // Arrange
        var sessionService = new SessionService();
        var registry = new SyncSchemaRegistry();
        var createResult = sessionService.CreateSession("connection-1");
        var session = createResult.Session!;
        registry.SetSessionSchemas(session.Id, new[] { MakeSchema(1), MakeSchema(3) });

        // Act: last member leaves. Session enters the empty-grace window
        // (LastMemberLeftAt is set, but the session is still Active).
        var leaveResult = sessionService.LeaveSession("connection-1");

        // Assert: leave succeeded, session still alive in grace window
        leaveResult.Should().NotBeNull();
        leaveResult!.RemainingMemberIds.Should().BeEmpty();
        session.LastMemberLeftAt.Should().NotBeNull();
        session.LifecycleState.Should().Be(SessionLifecycleState.Active);

        // Schemas MUST still be registered — this is what lets a rejoin
        // (which inherits the registered schemas via session.Metadata) keep
        // working without a schema re-registration in JoinSession.
        registry.HasAnySchemas(session.Id).Should().BeTrue();
        registry.GetSchema(session.Id, 1).Should().NotBeNull();
        registry.GetSchema(session.Id, 3).Should().NotBeNull();
    }

    /// <summary>
    /// Post-fix lifecycle pin: when SessionCleanupService destroys a session
    /// (empty-timeout expired), the schema registry entry MUST be cleared
    /// as a side effect — preventing the per-process growth of orphaned
    /// schema entries that the pre-fix code path would have caused.
    /// </summary>
    [Fact]
    public async Task CleanupExpiredSessions_DestroysEmptySession_AndClearsSchemaRegistry()
    {
        // Arrange: session with schemas, all members gone, empty-timeout = 0
        var sessionService = new SessionService();
        var registry = new SyncSchemaRegistry();
        var session = sessionService.CreateSession("connection-1").Session!;
        registry.SetSessionSchemas(session.Id, new[] { MakeSchema(1) });
        sessionService.LeaveSession("connection-1");
        session.LastMemberLeftAt.Should().NotBeNull();
        registry.HasAnySchemas(session.Id).Should().BeTrue("baseline: schemas survived last-leave");

        var cleanup = CreateCleanupService(sessionService, registry, emptyTimeoutSeconds: 0);

        // Act: trigger one cleanup pass
        await cleanup.CleanupExpiredSessions();

        // Assert: session destroyed AND registry cleared
        sessionService.GetAllSessions().Should().NotContain(s => s.Id == session.Id);
        registry.HasAnySchemas(session.Id).Should().BeFalse(
            "ClearSession must run at the actual destroy point, not at last-leave");
    }

    /// <summary>
    /// Sessions that still have members and are within their absolute
    /// timeout MUST NOT be touched by the cleanup pass — and their schemas
    /// must remain registered.
    /// </summary>
    [Fact]
    public async Task CleanupExpiredSessions_LeavesActiveSessionsAlone()
    {
        var sessionService = new SessionService();
        var registry = new SyncSchemaRegistry();
        var session = sessionService.CreateSession("connection-1").Session!;
        registry.SetSessionSchemas(session.Id, new[] { MakeSchema(1) });

        var cleanup = CreateCleanupService(sessionService, registry, emptyTimeoutSeconds: 0);

        await cleanup.CleanupExpiredSessions();

        sessionService.GetAllSessions().Should().Contain(s => s.Id == session.Id);
        registry.HasAnySchemas(session.Id).Should().BeTrue();
    }

    /// <summary>
    /// Rejoin flow: after last-leave (schemas preserved), a rejoin promotes
    /// the new connection to Server. The schemas MUST still be available so
    /// inbound positional payloads decode without throwing.
    /// </summary>
    [Fact]
    public void RejoinAfterLastLeave_FindsSchemasStillRegistered()
    {
        var sessionService = new SessionService();
        var registry = new SyncSchemaRegistry();
        var session = sessionService.CreateSession("connection-1").Session!;
        registry.SetSessionSchemas(session.Id, new[] { MakeSchema(7) });

        sessionService.LeaveSession("connection-1");

        // Rejoin
        var rejoin = sessionService.JoinSession(session.Id, "connection-2");
        rejoin.Should().NotBeNull();
        rejoin.Member.Should().NotBeNull();

        // The rejoiner can decode positional payloads — schemas survived.
        registry.GetSchema(session.Id, 7).Should().NotBeNull();
    }
}
