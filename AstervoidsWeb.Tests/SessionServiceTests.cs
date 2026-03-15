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
        var result = _sessionService.CreateSession("connection-1", 1.5);
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
        var result = _sessionService.CreateSession("connection-1", 1.5);
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
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;

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
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;
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
    public void LeaveSession_LastMemberLeaves_ShouldKeepSessionForTimeout()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;

        // Act
        var result = _sessionService.LeaveSession("connection-1");

        // Assert
        result.Should().NotBeNull();
        result!.SessionDestroyed.Should().BeFalse();
        var remainingSession = _sessionService.GetSession(session.Id);
        remainingSession.Should().NotBeNull();
        remainingSession!.Members.Should().BeEmpty();
        remainingSession.LastMemberLeftAt.Should().NotBeNull();
    }

    [Fact]
    public void LeaveSession_ClientLeaves_ShouldNotPromote()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;
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
        _sessionService.CreateSession("connection-1", 1.5);
        _sessionService.CreateSession("connection-2", 1.5);
        _sessionService.CreateSession("connection-3", 1.5);

        // Act
        var sessions = _sessionService.GetActiveSessions().Sessions.ToList();

        // Assert
        sessions.Should().HaveCount(3);
    }

    [Fact]
    public void GetMemberByConnectionId_ShouldReturnMember()
    {
        // Arrange
        var creator = _sessionService.CreateSession("connection-1", 1.5).Creator!;

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
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;

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
            var result = _sessionService.CreateSession($"connection-{i}", 1.5);
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
            var result = _sessionService.CreateSession($"connection-{i}", 1.5);
            result.Success.Should().BeTrue($"session {i} should be created successfully");
        }

        // Act - try to create one more
        var failedResult = _sessionService.CreateSession("connection-overflow", 1.5);

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
        var result = _sessionService.CreateSession("connection-1", 1.5);
        result.Success.Should().BeTrue();

        // Act - try to create another session with the same connection
        var failedResult = _sessionService.CreateSession("connection-1", 1.5);

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
        var session1 = _sessionService.CreateSession("connection-1", 1.5).Session!;
        var session2 = _sessionService.CreateSession("connection-2", 1.5).Session!;

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
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;
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

    [Fact]
    public void CreateSession_ShouldStoreAspectRatio()
    {
        // Act
        var result = _sessionService.CreateSession("connection-1", 1.7777);
        var session = result.Session!;

        // Assert
        session.AspectRatio.Should().BeApproximately(1.7777, 0.001);
    }

    [Fact]
    public void CreateSession_ShouldClampAspectRatioToValidRange()
    {
        // Act - try to create with extreme aspect ratios
        var tooWide = _sessionService.CreateSession("connection-1", 10.0);
        var tooTall = _sessionService.CreateSession("connection-2", 0.1);

        // Assert - should be clamped to 0.25-4.0 range
        tooWide.Session!.AspectRatio.Should().Be(4.0);
        tooTall.Session!.AspectRatio.Should().Be(0.25);
    }

    [Fact]
    public void JoinSession_ShouldReturnSessionWithAspectRatio()
    {
        // Arrange
        var createResult = _sessionService.CreateSession("connection-1", 1.333);
        var session = createResult.Session!;

        // Act
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");

        // Assert
        joinResult.Success.Should().BeTrue();
        joinResult.Session!.AspectRatio.Should().BeApproximately(1.333, 0.001);
    }

    [Fact]
    public void JoinSession_EmptySession_ShouldBecomeServer()
    {
        // Arrange - create session, then all members leave
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;
        _sessionService.LeaveSession("connection-1");

        // Act - join the empty session
        var joinResult = _sessionService.JoinSession(session.Id, "connection-2");

        // Assert
        joinResult.Success.Should().BeTrue();
        joinResult.Member!.Role.Should().Be(MemberRole.Server);
    }

    [Fact]
    public void JoinSession_EmptySession_ShouldClearLastMemberLeftAt()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;
        _sessionService.LeaveSession("connection-1");
        session.LastMemberLeftAt.Should().NotBeNull();

        // Act
        _sessionService.JoinSession(session.Id, "connection-2");

        // Assert
        session.LastMemberLeftAt.Should().BeNull();
    }

    [Fact]
    public void GetAllSessions_ShouldIncludeEmptySessions()
    {
        // Arrange - create sessions, leave one empty
        _sessionService.CreateSession("connection-1", 1.5);
        var session2 = _sessionService.CreateSession("connection-2", 1.5).Session!;
        _sessionService.LeaveSession("connection-2");

        // Act
        var allSessions = _sessionService.GetAllSessions().ToList();
        var activeSessions = _sessionService.GetActiveSessions().Sessions.ToList();

        // Assert
        allSessions.Should().HaveCount(2);
        activeSessions.Should().HaveCount(1); // Empty sessions excluded from active list
    }

    [Fact]
    public void ForceDestroySession_ShouldRemoveSessionAndMembers()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;
        _sessionService.JoinSession(session.Id, "connection-2");

        // Act
        var result = _sessionService.ForceDestroySession(session.Id);

        // Assert
        result.Should().NotBeNull();
        result!.ConnectionIds.Should().HaveCount(2);
        result.ConnectionIds.Should().Contain("connection-1");
        result.ConnectionIds.Should().Contain("connection-2");
        result.SessionName.Should().Be(session.Name);
        _sessionService.GetSession(session.Id).Should().BeNull();
        _sessionService.GetMemberByConnectionId("connection-1").Should().BeNull();
        _sessionService.GetMemberByConnectionId("connection-2").Should().BeNull();
    }

    [Fact]
    public void ForceDestroySession_EmptySession_ShouldReturnEmptyConnectionIds()
    {
        // Arrange
        var session = _sessionService.CreateSession("connection-1", 1.5).Session!;
        _sessionService.LeaveSession("connection-1");

        // Act
        var result = _sessionService.ForceDestroySession(session.Id);

        // Assert
        result.Should().NotBeNull();
        result!.ConnectionIds.Should().BeEmpty();
        _sessionService.GetSession(session.Id).Should().BeNull();
    }

    [Fact]
    public void ForceDestroySession_NonExistentSession_ShouldReturnNull()
    {
        // Act
        var result = _sessionService.ForceDestroySession(Guid.NewGuid());

        // Assert
        result.Should().BeNull();
    }
}
