using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;
using Xunit;

namespace AstervoidsWeb.Tests;

public class ReplaceAfterEvictTest : TestBase
{
    [Fact]
    public void JoinWithEvict_ReplaceObjectWorksOnAdoptedAsteroid()
    {
        // Arrange — solo player with an asteroid
        var (session, server) = CreateTestSession("server-conn");
        var asteroid = ObjectService.CreateObject(session.Id, server.Id, ObjectScope.Session,
            new Dictionary<string, object?> { ["type"] = "asteroid", ["radius"] = 0.05 });

        // Act — reconnect (evict old member, join as new)
        var rejoinResult = SessionService.JoinSession(session.Id, "new-conn", server.Id);
        var newMember = rejoinResult.Member!;

        // Verify asteroid was adopted
        var adoptedAsteroid = ObjectService.GetObject(session.Id, asteroid!.Id);
        adoptedAsteroid!.OwnerMemberId.Should().Be(newMember.Id);

        // Act — try to replace (split) the adopted asteroid
        var specs = new List<ReplacementObjectSpec> {
            new(ObjectScope.Session, new Dictionary<string, object?> { ["type"] = "asteroid", ["radius"] = 0.03 }, null),
            new(ObjectScope.Session, new Dictionary<string, object?> { ["type"] = "asteroid", ["radius"] = 0.03 }, null)
        };
        var replaceResult = ObjectService.ReplaceObject(session.Id, asteroid.Id, newMember.Id, specs);

        // Assert — replace should succeed
        replaceResult.Should().NotBeNull("ReplaceObject should succeed for adopted asteroid");
        replaceResult.Should().HaveCount(2);
        replaceResult![0].OwnerMemberId.Should().Be(newMember.Id);
        replaceResult[1].OwnerMemberId.Should().Be(newMember.Id);
        
        // Parent should be deleted
        ObjectService.GetObject(session.Id, asteroid.Id).Should().BeNull();
    }
}
