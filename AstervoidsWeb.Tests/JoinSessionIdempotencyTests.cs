using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Tests for the idempotent re-join behavior of <see cref="ISessionService.JoinSession"/>.
///
/// Background: when a SignalR transport drops between the time the server processes
/// JoinSession and the time the client receives the response, the server-side join is
/// successful but the client thinks it failed and retries. The retry arrives on the
/// SAME ConnectionId (after auto-reconnect). Without idempotency, the server returns
/// "Already in a session" and the client falls all the way back to the start screen
/// with a ghost member left on the server. With idempotency, the second call returns
/// the existing membership (with <c>AlreadyMember = true</c>) so the client can recover.
/// </summary>
public class JoinSessionIdempotencyTests : TestBase
{
    [Fact]
    public void JoinSession_SameConnectionSameSession_ReturnsExistingMembership()
    {
        // Arrange — connection-1 creates a session
        var (session, creator) = CreateTestSession("connection-1");

        // Act — same connection re-joins (response-loss recovery)
        var result = SessionService.JoinSession(session.Id, "connection-1");

        // Assert — success, returns the SAME member, no state mutation
        result.Success.Should().BeTrue();
        result.AlreadyMember.Should().BeTrue();
        result.Member.Should().NotBeNull();
        result.Member!.Id.Should().Be(creator.Id, "the existing member must be returned");
        result.Session.Should().NotBeNull();
        result.Session!.Id.Should().Be(session.Id);
        result.Eviction.Should().BeNull("no eviction occurs on idempotent re-join");

        // Session still has only one member (no duplicate added)
        session.Members.Should().HaveCount(1);
    }

    [Fact]
    public void JoinSession_SameConnectionSameSession_DoesNotIncrementMemberCount()
    {
        // Arrange — two-member session
        var (session, _, client) = CreateTestSessionWithClient("server-conn", "client-conn");
        session.Members.Should().HaveCount(2);

        // Act — client retries its join on the same connection
        var result = SessionService.JoinSession(session.Id, "client-conn");

        // Assert — same client member returned, member count unchanged
        result.Success.Should().BeTrue();
        result.AlreadyMember.Should().BeTrue();
        result.Member!.Id.Should().Be(client.Id);
        session.Members.Should().HaveCount(2, "idempotent re-join must not add a duplicate member");
    }

    [Fact]
    public void JoinSession_SameConnectionDifferentSession_StillFailsWithError()
    {
        // Arrange — connection-1 is in session A; session B exists separately
        var (sessionA, _) = CreateTestSession("connection-1");
        var sessionBResult = SessionService.CreateSession("connection-2");
        var sessionB = sessionBResult.Session!;

        // Act — connection-1 tries to join the OTHER session
        var result = SessionService.JoinSession(sessionB.Id, "connection-1");

        // Assert — this is a real conflict, not a response-loss retry; must fail
        result.Success.Should().BeFalse();
        result.AlreadyMember.Should().BeFalse();
        result.ErrorMessage.Should().Contain("Already in a session");
    }

    [Fact]
    public void JoinSession_IdempotentRejoin_DoesNotTriggerOrphanAdoption()
    {
        // Arrange — solo player with a session-scoped object, leaves, rejoins (adopts orphan)
        var (session, server) = CreateTestSession("server-conn");
        var orphan = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid" });
        SessionService.LeaveSession("server-conn");

        var firstRejoin = SessionService.JoinSession(session.Id, "server-conn-2");
        firstRejoin.Success.Should().BeTrue();
        firstRejoin.AlreadyMember.Should().BeFalse();
        var newMemberId = firstRejoin.Member!.Id;

        // Capture the orphan's adopted-version after the first rejoin
        var afterFirstRejoin = ObjectService.GetObject(session.Id, orphan!.Id);
        var versionAfterFirstRejoin = afterFirstRejoin!.Version;

        // Act — same connection re-invokes JoinSession (response-loss retry)
        var idempotentRejoin = SessionService.JoinSession(session.Id, "server-conn-2");

        // Assert — same membership returned, no second adoption, version unchanged
        idempotentRejoin.Success.Should().BeTrue();
        idempotentRejoin.AlreadyMember.Should().BeTrue();
        idempotentRejoin.Member!.Id.Should().Be(newMemberId);

        var afterIdempotent = ObjectService.GetObject(session.Id, orphan.Id);
        afterIdempotent!.Version.Should().Be(versionAfterFirstRejoin,
            "idempotent re-join must NOT re-adopt orphans (no version bump)");
        afterIdempotent.OwnerMemberId.Should().Be(newMemberId);
    }

    [Fact]
    public void JoinSession_IdempotentRejoin_DoesNotPerformEviction()
    {
        // Arrange — two members; one (the rejoiner) holds onto its old memberId
        var (session, _, client) = CreateTestSessionWithClient("server-conn", "client-conn");
        var clientMemberIdBefore = client.Id;

        // Act — client retries with its OWN memberId as the evict target (defensive: should be no-op)
        var result = SessionService.JoinSession(session.Id, "client-conn", evictMemberId: clientMemberIdBefore);

        // Assert — succeeds idempotently, eviction skipped (would be a self-evict, dangerous)
        result.Success.Should().BeTrue();
        result.AlreadyMember.Should().BeTrue();
        result.Eviction.Should().BeNull("idempotent path returns before reaching eviction logic");
        result.Member!.Id.Should().Be(clientMemberIdBefore, "client member is preserved, not re-created");
        session.Members.Should().HaveCount(2);
    }

    [Fact]
    public void JoinSession_IdempotentRejoin_ReturnsCurrentSessionSnapshot()
    {
        // Arrange — solo session with some session-scoped objects
        var (session, server) = CreateTestSession("server-conn");
        var obj1 = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid", ["x"] = 100.0 });
        var obj2 = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "GameState", ["wave"] = 5 });

        // Act — idempotent re-join
        var result = SessionService.JoinSession(session.Id, "server-conn");

        // Assert — the returned Session reference exposes the current object set
        result.Success.Should().BeTrue();
        result.AlreadyMember.Should().BeTrue();
        result.Session!.Objects.Should().HaveCount(2);
        result.Session.Objects.Should().ContainKey(obj1!.Id);
        result.Session.Objects.Should().ContainKey(obj2!.Id);
    }

    [Fact]
    public void JoinSession_TripleRejoin_RemainsIdempotent()
    {
        // Arrange — repeated JoinSession invocations from the same connection
        var (session, creator) = CreateTestSession("connection-1");

        // Act — call JoinSession three more times
        var r1 = SessionService.JoinSession(session.Id, "connection-1");
        var r2 = SessionService.JoinSession(session.Id, "connection-1");
        var r3 = SessionService.JoinSession(session.Id, "connection-1");

        // Assert — all succeed, all return the same member, member count never grows
        foreach (var r in new[] { r1, r2, r3 })
        {
            r.Success.Should().BeTrue();
            r.AlreadyMember.Should().BeTrue();
            r.Member!.Id.Should().Be(creator.Id);
        }
        session.Members.Should().HaveCount(1);
    }
}
