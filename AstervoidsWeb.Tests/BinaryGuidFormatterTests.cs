using AstervoidsWeb.Formatters;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Services;
using FluentAssertions;
using MessagePack;
using MessagePack.Resolvers;

namespace AstervoidsWeb.Tests;

public class BinaryGuidFormatterTests
{
    /// <summary>
    /// Build the same composite resolver used in Program.cs so tests exercise the real wire format.
    /// </summary>
    private static readonly MessagePackSerializerOptions Options =
        MessagePackSerializerOptions.Standard
            .WithResolver(CompositeResolver.Create(
                BinaryGuidResolver.Instance,
                ContractlessStandardResolver.Instance))
            .WithSecurity(MessagePackSecurity.UntrustedData);

    // ── Guid round-trip ──────────────────────────────────────────────

    [Fact]
    public void Guid_RoundTrip_ProducesSameValue()
    {
        var guid = Guid.NewGuid();
        var bytes = MessagePackSerializer.Serialize(guid, Options);
        var result = MessagePackSerializer.Deserialize<Guid>(bytes, Options);
        result.Should().Be(guid);
    }

    [Fact]
    public void Guid_Serializes_As_16Bytes_Binary()
    {
        var guid = Guid.NewGuid();
        var bytes = MessagePackSerializer.Serialize(guid, Options);

        // MessagePack bin8 header (0xc4) + length byte (0x10 = 16) + 16 data bytes = 18 bytes total
        bytes.Should().HaveCount(18);
        bytes[0].Should().Be(0xc4); // bin8 format
        bytes[1].Should().Be(16);   // 16 bytes
    }

    [Fact]
    public void Guid_Deserializes_From_String()
    {
        var guid = Guid.NewGuid();
        // Serialize as string (what legacy/JS clients send)
        var bytes = MessagePackSerializer.Serialize(guid.ToString(), Options);
        var result = MessagePackSerializer.Deserialize<Guid>(bytes, Options);
        result.Should().Be(guid);
    }

    [Fact]
    public void Guid_Empty_RoundTrip()
    {
        var bytes = MessagePackSerializer.Serialize(Guid.Empty, Options);
        var result = MessagePackSerializer.Deserialize<Guid>(bytes, Options);
        result.Should().Be(Guid.Empty);
    }

    // ── Nullable Guid ────────────────────────────────────────────────

    [Fact]
    public void NullableGuid_Null_RoundTrip()
    {
        Guid? value = null;
        var bytes = MessagePackSerializer.Serialize(value, Options);
        var result = MessagePackSerializer.Deserialize<Guid?>(bytes, Options);
        result.Should().BeNull();
    }

    [Fact]
    public void NullableGuid_HasValue_RoundTrip()
    {
        Guid? value = Guid.NewGuid();
        var bytes = MessagePackSerializer.Serialize(value, Options);
        var result = MessagePackSerializer.Deserialize<Guid?>(bytes, Options);
        result.Should().Be(value);
    }

    // ── Collection of Guids ──────────────────────────────────────────

    [Fact]
    public void GuidList_RoundTrip()
    {
        var guids = new List<Guid> { Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() };
        var bytes = MessagePackSerializer.Serialize(guids, Options);
        var result = MessagePackSerializer.Deserialize<List<Guid>>(bytes, Options);
        result.Should().BeEquivalentTo(guids);
    }

    [Fact]
    public void IEnumerableGuid_RoundTrip()
    {
        IEnumerable<Guid> guids = new[] { Guid.NewGuid(), Guid.NewGuid() };
        var bytes = MessagePackSerializer.Serialize(guids, Options);
        var result = MessagePackSerializer.Deserialize<IEnumerable<Guid>>(bytes, Options);
        result.Should().BeEquivalentTo(guids);
    }

    // ── Hub DTO round-trips ──────────────────────────────────────────

    [Fact]
    public void CreateSessionResponse_RoundTrip()
    {
        var dto = new CreateSessionResponse(
            Guid.NewGuid(), "TestSession", Guid.NewGuid(), "Server", 1.5);

        var bytes = MessagePackSerializer.Serialize(dto, Options);
        var result = MessagePackSerializer.Deserialize<CreateSessionResponse>(bytes, Options);

        result.SessionId.Should().Be(dto.SessionId);
        result.SessionName.Should().Be(dto.SessionName);
        result.MemberId.Should().Be(dto.MemberId);
        result.Role.Should().Be(dto.Role);
        result.AspectRatio.Should().Be(dto.AspectRatio);
    }

    [Fact]
    public void MemberLeftInfo_RoundTrip_WithPromotion()
    {
        var dto = new MemberLeftInfo(
            Guid.NewGuid(),
            Guid.NewGuid(),
            "Server",
            new List<Guid> { Guid.NewGuid(), Guid.NewGuid() },
            new List<ObjectMigration>
            {
                new(Guid.NewGuid(), Guid.NewGuid(), 5L)
            }
        );

        var bytes = MessagePackSerializer.Serialize(dto, Options);
        var result = MessagePackSerializer.Deserialize<MemberLeftInfo>(bytes, Options);

        result.MemberId.Should().Be(dto.MemberId);
        result.PromotedMemberId.Should().Be(dto.PromotedMemberId);
        result.PromotedRole.Should().Be(dto.PromotedRole);
        result.DeletedObjectIds.Should().BeEquivalentTo(dto.DeletedObjectIds);
        result.MigratedObjects.Should().BeEquivalentTo(dto.MigratedObjects);
    }

    [Fact]
    public void MemberLeftInfo_RoundTrip_NullPromotion()
    {
        var dto = new MemberLeftInfo(
            Guid.NewGuid(), null, null,
            Array.Empty<Guid>(),
            Array.Empty<ObjectMigration>());

        var bytes = MessagePackSerializer.Serialize(dto, Options);
        var result = MessagePackSerializer.Deserialize<MemberLeftInfo>(bytes, Options);

        result.MemberId.Should().Be(dto.MemberId);
        result.PromotedMemberId.Should().BeNull();
        result.PromotedRole.Should().BeNull();
    }

    [Fact]
    public void ObjectInfo_RoundTrip()
    {
        var dto = new ObjectInfo(
            Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(),
            "Session",
            new Dictionary<string, object?> { ["type"] = "ship", ["x"] = 1.5 },
            42L);

        var bytes = MessagePackSerializer.Serialize(dto, Options);
        var result = MessagePackSerializer.Deserialize<ObjectInfo>(bytes, Options);

        result.Id.Should().Be(dto.Id);
        result.CreatorMemberId.Should().Be(dto.CreatorMemberId);
        result.OwnerMemberId.Should().Be(dto.OwnerMemberId);
        result.Scope.Should().Be(dto.Scope);
        result.Version.Should().Be(dto.Version);
    }

    [Fact]
    public void ObjectMigration_RoundTrip()
    {
        var dto = new ObjectMigration(Guid.NewGuid(), Guid.NewGuid(), 10L);
        var bytes = MessagePackSerializer.Serialize(dto, Options);
        var result = MessagePackSerializer.Deserialize<ObjectMigration>(bytes, Options);

        result.ObjectId.Should().Be(dto.ObjectId);
        result.NewOwnerId.Should().Be(dto.NewOwnerId);
        result.NewVersion.Should().Be(dto.NewVersion);
    }

    [Fact]
    public void ObjectReplacedEvent_RoundTrip()
    {
        var created = new ObjectInfo(
            Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(),
            "Session", new Dictionary<string, object?> { ["type"] = "asteroid" }, 1L);

        var dto = new ObjectReplacedEvent(Guid.NewGuid(), new List<ObjectInfo> { created });
        var bytes = MessagePackSerializer.Serialize(dto, Options);
        var result = MessagePackSerializer.Deserialize<ObjectReplacedEvent>(bytes, Options);

        result.DeletedObjectId.Should().Be(dto.DeletedObjectId);
        result.CreatedObjects.Should().HaveCount(1);
        result.CreatedObjects[0].Id.Should().Be(created.Id);
    }

    [Fact]
    public void JoinSessionResponse_RoundTrip()
    {
        var member = new MemberInfo(Guid.NewGuid(), "Client", DateTime.UtcNow);
        var obj = new ObjectInfo(
            Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(),
            "Member", new Dictionary<string, object?>(), 1L);

        var dto = new JoinSessionResponse(
            Guid.NewGuid(), "Banana", Guid.NewGuid(), "Client",
            new[] { member }, new[] { obj }, 1.78);

        var bytes = MessagePackSerializer.Serialize(dto, Options);
        var result = MessagePackSerializer.Deserialize<JoinSessionResponse>(bytes, Options);

        result.SessionId.Should().Be(dto.SessionId);
        result.MemberId.Should().Be(dto.MemberId);
        result.Members.Should().HaveCount(1);
        result.Objects.Should().HaveCount(1);
    }

    // ── Wire size comparison ─────────────────────────────────────────

    [Fact]
    public void BinaryGuid_IsSmallerThan_StringGuid()
    {
        var guid = Guid.NewGuid();

        // Binary encoding (our formatter)
        var binaryBytes = MessagePackSerializer.Serialize(guid, Options);

        // String encoding (what ContractlessStandardResolver would produce)
        var stringBytes = MessagePackSerializer.Serialize(guid.ToString(), Options);

        binaryBytes.Length.Should().BeLessThan(stringBytes.Length,
            "binary GUID (18 bytes) should be smaller than string GUID (37+ bytes)");
    }

    [Fact]
    public void ObjectInfo_WithBinaryGuids_IsSmallerThan_WithStringGuids()
    {
        var dto = new ObjectInfo(
            Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(),
            "Session",
            new Dictionary<string, object?> { ["type"] = "ship", ["x"] = 100.0, ["y"] = 200.0 },
            42L);

        // Binary GUIDs
        var binaryBytes = MessagePackSerializer.Serialize(dto, Options);

        // String GUIDs (using ContractlessStandardResolver which encodes GUIDs as strings)
        var stringOptions = ContractlessStandardResolver.Options
            .WithSecurity(MessagePackSecurity.UntrustedData);
        var stringBytes = MessagePackSerializer.Serialize(dto, stringOptions);

        var savings = stringBytes.Length - binaryBytes.Length;
        savings.Should().BeGreaterThanOrEqualTo(50,
            "ObjectInfo has 3 GUIDs, each saving ~19 bytes = ~57 bytes total");
    }
}
