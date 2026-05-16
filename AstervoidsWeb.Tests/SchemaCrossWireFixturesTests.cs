using AstervoidsWeb.Hubs;
using FluentAssertions;
using Xunit;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Phase 4 cross-wire fixture tests. These pin the C# encoder's exact byte
/// output for canonical schemas. The matching JS file
/// <c>AstervoidsWeb/schema-codec-cross.test.mjs</c> decodes the same hex
/// constants and asserts identical dicts. If either side is changed, both
/// sides will fail and the wire compatibility break is loud.
///
/// Hex literals chosen to match: little-endian for numerics; GUID layout
/// matches <see cref="System.Guid.TryWriteBytes(System.Span{byte})"/> /
/// <see cref="MessagePack.Resolvers.BinaryGuidResolver"/> ordering
/// (first 4 bytes LE, next 2 LE, next 2 LE, final 8 BE).
/// </summary>
public class SchemaCrossWireFixturesTests
{
    private static string Hex(byte[] bytes) =>
        Convert.ToHexString(bytes).ToLowerInvariant();

    private static PositionalSchemaCodec.Schema Schema(byte id, params (string name, string type)[] fields)
        => new(id, fields.Select(f => new PositionalSchemaCodec.FieldSpec(f.name, f.type)).ToArray());

    [Fact]
    public void Fixture_AsteroidUpdate_AllFields()
    {
        var schema = Schema(3, ("x", "f64"), ("y", "f64"), ("angle", "f64"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["x"] = 0.5,
            ["y"] = 0.25,
            ["angle"] = 1.5707963267948966 // pi/2
        });
        Hex(bytes).Should().Be(
            "07" +
            "000000000000e03f" +
            "000000000000d03f" +
            "182d4454fb21f93f");
    }

    [Fact]
    public void Fixture_AsteroidUpdate_OnlyAngle()
    {
        var schema = Schema(3, ("x", "f64"), ("y", "f64"), ("angle", "f64"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["angle"] = 0.0
        });
        Hex(bytes).Should().Be("04" + "0000000000000000");
    }

    [Fact]
    public void Fixture_ShipUpdate_MixedTypes()
    {
        var schema = Schema(1,
            ("x", "f64"), ("y", "f64"), ("angle", "f64"),
            ("velocityX", "f64"), ("velocityY", "f64"),
            ("rotationSpeed", "f64"),
            ("thrusting", "bool"),
            ("invulnerable", "bool"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["x"] = 0.5,
            ["y"] = 0.5,
            ["angle"] = 0.0,
            ["velocityX"] = 0.0,
            ["velocityY"] = 0.0,
            ["rotationSpeed"] = 0.0,
            ["thrusting"] = false,
            ["invulnerable"] = true
        });
        Hex(bytes).Should().Be(
            "ff" +
            "000000000000e03f" +
            "000000000000e03f" +
            "0000000000000000" +
            "0000000000000000" +
            "0000000000000000" +
            "0000000000000000" +
            "00" +
            "01");
    }

    [Fact]
    public void Fixture_BulletUpdate_GuidField()
    {
        var schema = Schema(5,
            ("x", "f64"), ("y", "f64"),
            ("ownerMemberId", "guid"));
        var memberId = Guid.Parse("11223344-5566-7788-99aa-bbccddeeff00");
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["x"] = 0.1,
            ["y"] = 0.2,
            ["ownerMemberId"] = memberId
        });
        Hex(bytes).Should().Be(
            "07" +
            "9a9999999999b93f" +
            "9a9999999999c93f" +
            "443322116655887799aabbccddeeff00");
    }

    [Fact]
    public void Fixture_StringField_Utf8Length()
    {
        var schema = Schema(7, ("name", "str"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["name"] = "ship"
        });
        Hex(bytes).Should().Be("01" + "0400" + "73686970");
    }

    [Fact]
    public void Fixture_NullableGuid_NullCase()
    {
        var schema = Schema(8, ("hitTargetId", "nullable-guid"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["hitTargetId"] = null
        });
        Hex(bytes).Should().Be("01" + "00");
    }

    [Fact]
    public void Fixture_BytesField_LengthIsLittleEndianU32()
    {
        var schema = Schema(9, ("vertices", "bytes"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["vertices"] = new byte[] { 0xde, 0xad, 0xbe, 0xef }
        });
        Hex(bytes).Should().Be("01" + "04000000" + "deadbeef");
    }
}
