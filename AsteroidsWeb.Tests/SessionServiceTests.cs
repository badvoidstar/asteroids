using AsteroidsWeb.Models;
using AsteroidsWeb.Services;
using FluentAssertions;

namespace AsteroidsWeb.Tests;

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
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;

        // Assert
        result.Success.Should().BeTrue();
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
        var result = _sessionService.CreateSession("connection-1");
        var session = result.Session!;
        var creator = result.Creator!;

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
        var session = _sessionService.CreateSession("connection-1").Session!;

        // Act
        var result = _sessionService.JoinSession(session.Id, "connection-2");

        // Assert
        Assert.True(result.Success);
        var joinedSession = result.Session!;
        var member = result.Member!;
        member.Role.Should().Be(MemberRole.Client);
        member.ConnectionId.Should().Be("connection-2");
        joinedSession.Members.Should().HaveCount(2);
    }

    [Fact]
    public void JoinSession_NonExistentSession_ShouldFail()
    {
        // Act
        var result = _sessionService.JoinSession(Guid.NewGuid(), "connection-1");

        // Assert
        result.Success.Should().BeFalse();
        result.Session.Should().BeNull();
        result.Member.Should().BeNull();
        result.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void LeaveSession_ServerLeaves_ShouldPromoteClient()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1").Session!;
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
        var session = _sessionService.CreateSession("connection-1").Session!;

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
        var session = _sessionService.CreateSession("connection-1").Session!;
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
        var sessions = _sessionService.GetActiveSessions().Sessions.ToList();

        // Assert
        sessions.Should().HaveCount(3);
    }

    [Fact]
    public void GetMemberByConnectionId_ShouldReturnMember()
    {
        // Arrange
        var creator = _sessionService.CreateSession("connection-1").Creator!;

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
        var session = _sessionService.CreateSession("connection-1").Session!;

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
        for (int i = 0; i < 6; i++)
        {
            var result = _sessionService.CreateSession($"connection-{i}");
            names.Add(result.Session!.Name);
        }

        // Assert
        names.Should().HaveCount(6, "all session names should be unique");
    }

    [Fact]
    public void CreateSession_ExceedsMaxSessions_ShouldFail()
    {
        // Arrange - create max sessions (6)
        for (int i = 0; i < 6; i++)
        {
            var result = _sessionService.CreateSession($"connection-{i}");
            result.Success.Should().BeTrue($"session {i} should be created successfully");
        }

        // Act - try to create one more
        var failedResult = _sessionService.CreateSession("connection-overflow");

        // Assert
        failedResult.Success.Should().BeFalse();
        failedResult.Session.Should().BeNull();
        failedResult.Creator.Should().BeNull();
        failedResult.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void CreateSession_WhileAlreadyInSession_ShouldFail()
    {
        // Arrange - create a session first
        var result = _sessionService.CreateSession("connection-1");
        result.Success.Should().BeTrue();

        // Act - try to create another session with the same connection
        var failedResult = _sessionService.CreateSession("connection-1");

        // Assert
        failedResult.Success.Should().BeFalse();
        failedResult.Session.Should().BeNull();
        failedResult.Creator.Should().BeNull();
        failedResult.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void JoinSession_WhileAlreadyInSession_ShouldFail()
    {
        // Arrange - create two sessions
        var session1 = _sessionService.CreateSession("connection-1").Session!;
        var session2 = _sessionService.CreateSession("connection-2").Session!;

        // Join session1 with connection-3
        var joinResult = _sessionService.JoinSession(session1.Id, "connection-3");
        Assert.True(joinResult.Success);

        // Act - try to join session2 with the same connection
        var failedResult = _sessionService.JoinSession(session2.Id, "connection-3");

        // Assert
        failedResult.Success.Should().BeFalse();
        failedResult.Session.Should().BeNull();
        failedResult.Member.Should().BeNull();
        failedResult.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void JoinSession_SessionFull_ShouldFail()
    {
        // Arrange - create a session and fill it with 4 members (max)
        var session = _sessionService.CreateSession("connection-1").Session!;
        _sessionService.JoinSession(session.Id, "connection-2");
        _sessionService.JoinSession(session.Id, "connection-3");
        _sessionService.JoinSession(session.Id, "connection-4");

        // Verify session is full
        var fullSession = _sessionService.GetSession(session.Id);
        fullSession!.Members.Should().HaveCount(4);

        // Act - try to join with a 5th member
        var failedResult = _sessionService.JoinSession(session.Id, "connection-5");

        // Assert
        failedResult.Success.Should().BeFalse();
        failedResult.Session.Should().BeNull();
        failedResult.Member.Should().BeNull();
        failedResult.ErrorMessage.Should().NotBeNullOrEmpty();
    }
}
