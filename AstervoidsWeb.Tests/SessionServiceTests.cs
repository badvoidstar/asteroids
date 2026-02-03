using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class SessionServiceTests
{
    private readonly SessionService _sessionService;

    public SessionServiceTests()
    {
        _sessionService = new SessionService();
    }

    [Fact]
    public void CreateSession_ShouldCreateSessionWithFruitName()
    {
        // Act
        var (session, creator) = _sessionService.CreateSession("connection-1");

        // Assert
        session.Should().NotBeNull();
        session.Id.Should().NotBe(Guid.Empty);
        session.Name.Should().NotBeNullOrEmpty();
        session.Members.Should().HaveCount(1);
        session.CreatedAt.Should().BeCloseTo(DateTime.UtcNow, TimeSpan.FromSeconds(5));
    }

    [Fact]
    public void CreateSession_CreatorShouldBeServer()
    {
        // Act
        var (session, creator) = _sessionService.CreateSession("connection-1");

        // Assert
        creator.Should().NotBeNull();
        creator.Role.Should().Be(MemberRole.Server);
        creator.ConnectionId.Should().Be("connection-1");
        creator.SessionId.Should().Be(session.Id);
    }

    [Fact]
    public void JoinSession_ShouldAddMemberAsClient()
    {
        // Arrange
        var (session, _) = _sessionService.CreateSession("connection-1");

        // Act
        var result = _sessionService.JoinSession(session.Id, "connection-2");

        // Assert
        result.Should().NotBeNull();
        var (joinedSession, member) = result.Value;
        member.Role.Should().Be(MemberRole.Client);
        member.ConnectionId.Should().Be("connection-2");
        joinedSession.Members.Should().HaveCount(2);
    }

    [Fact]
    public void JoinSession_NonExistentSession_ShouldReturnNull()
    {
        // Act
        var result = _sessionService.JoinSession(Guid.NewGuid(), "connection-1");

        // Assert
        result.Should().BeNull();
    }

    [Fact]
    public void LeaveSession_ServerLeaves_ShouldPromoteClient()
    {
        // Arrange
        var (session, server) = _sessionService.CreateSession("connection-1");
        _sessionService.JoinSession(session.Id, "connection-2");

        // Act
        var result = _sessionService.LeaveSession("connection-1");

        // Assert
        result.Should().NotBeNull();
        result!.PromotedMember.Should().NotBeNull();
        result.PromotedMember!.Role.Should().Be(MemberRole.Server);
        result.SessionDestroyed.Should().BeFalse();
    }

    [Fact]
    public void LeaveSession_LastMemberLeaves_ShouldDestroySession()
    {
        // Arrange
        var (session, _) = _sessionService.CreateSession("connection-1");

        // Act
        var result = _sessionService.LeaveSession("connection-1");

        // Assert
        result.Should().NotBeNull();
        result!.SessionDestroyed.Should().BeTrue();
        _sessionService.GetSession(session.Id).Should().BeNull();
    }

    [Fact]
    public void LeaveSession_ClientLeaves_ShouldNotPromote()
    {
        // Arrange
        var (session, _) = _sessionService.CreateSession("connection-1");
        _sessionService.JoinSession(session.Id, "connection-2");

        // Act
        var result = _sessionService.LeaveSession("connection-2");

        // Assert
        result.Should().NotBeNull();
        result!.PromotedMember.Should().BeNull();
        result.SessionDestroyed.Should().BeFalse();
    }

    [Fact]
    public void GetActiveSessions_ShouldReturnAllSessions()
    {
        // Arrange
        _sessionService.CreateSession("connection-1");
        _sessionService.CreateSession("connection-2");
        _sessionService.CreateSession("connection-3");

        // Act
        var sessions = _sessionService.GetActiveSessions().ToList();

        // Assert
        sessions.Should().HaveCount(3);
    }

    [Fact]
    public void GetMemberByConnectionId_ShouldReturnMember()
    {
        // Arrange
        var (session, creator) = _sessionService.CreateSession("connection-1");

        // Act
        var member = _sessionService.GetMemberByConnectionId("connection-1");

        // Assert
        member.Should().NotBeNull();
        member!.Id.Should().Be(creator.Id);
    }

    [Fact]
    public void GetSessionByConnectionId_ShouldReturnSession()
    {
        // Arrange
        var (session, _) = _sessionService.CreateSession("connection-1");

        // Act
        var foundSession = _sessionService.GetSessionByConnectionId("connection-1");

        // Assert
        foundSession.Should().NotBeNull();
        foundSession!.Id.Should().Be(session.Id);
    }

    [Fact]
    public void CreateSession_MultipleSessions_ShouldHaveUniqueFruitNames()
    {
        // Arrange & Act
        var names = new HashSet<string>();
        for (int i = 0; i < 20; i++)
        {
            var (session, _) = _sessionService.CreateSession($"connection-{i}");
            names.Add(session.Name);
        }

        // Assert
        names.Should().HaveCount(20, "all session names should be unique");
    }
}
