using AstervoidsWeb.Hubs;
using FluentAssertions;
using Xunit;

namespace AstervoidsWeb.Tests;

public class PositionalSchemaCodecTests
{
    private static PositionalSchemaCodec.Schema Make(byte id, params (string name, string type)[] fields)
        => new(id, fields.Select(f => new PositionalSchemaCodec.FieldSpec(f.name, f.type)).ToArray());

    [Fact]
    public void Schema_RejectsId0()
    {
        Action act = () => Make(0, ("x", "f64"));
        act.Should().Throw<ArgumentException>().WithMessage("*reserved*");
    }

    [Fact]
    public void Schema_RejectsTooManyFields()
    {
        var fields = Enumerable.Range(0, 33).Select(i => ($"f{i}", "u8")).ToArray();
        Action act = () => Make(1, fields);
        act.Should().Throw<ArgumentException>().WithMessage("*max 32 fields*");
    }

    [Fact]
    public void Schema_RejectsDuplicateFieldNames()
    {
        Action act = () => Make(1, ("x", "f64"), ("x", "u8"));
        act.Should().Throw<ArgumentException>().WithMessage("*duplicate*");
    }

    [Fact]
    public void Schema_RejectsUnknownTypeTag()
    {
        Action act = () => Make(1, ("x", "blarg"));
        act.Should().Throw<ArgumentException>().WithMessage("*unknown type tag*");
    }

    [Fact]
    public void Encode_AllFieldsPresent_RoundTripsBackToDict()
    {
        var schema = Make(1,
            ("a", "f64"), ("b", "f32"), ("c", "u32"), ("d", "u16"), ("e", "u8"),
            ("f", "i32"), ("g", "i16"), ("h", "i8"), ("i", "bool"), ("j", "str"));
        var dict = new Dictionary<string, object?>
        {
            ["a"] = 1.5,
            ["b"] = 2.25f,
            ["c"] = (uint)3000000000u,
            ["d"] = (ushort)65000,
            ["e"] = (byte)200,
            ["f"] = -123,
            ["g"] = (short)-32000,
            ["h"] = (sbyte)-7,
            ["i"] = true,
            ["j"] = "hello world"
        };
        var bytes = PositionalSchemaCodec.Encode(schema, dict);
        var decoded = PositionalSchemaCodec.Decode(schema, bytes);

        decoded["a"].Should().Be(1.5);
        ((double)decoded["b"]!).Should().BeApproximately(2.25, 1e-6);
        decoded["c"].Should().Be(3000000000L);
        decoded["d"].Should().Be(65000L);
        decoded["e"].Should().Be(200L);
        decoded["f"].Should().Be(-123L);
        decoded["g"].Should().Be(-32000L);
        decoded["h"].Should().Be(-7L);
        decoded["i"].Should().Be(true);
        decoded["j"].Should().Be("hello world");
    }

    [Fact]
    public void Encode_OmittedFields_AreNotInDecodedDict()
    {
        var schema = Make(1, ("x", "f64"), ("y", "f64"), ("angle", "f64"));
        var dict = new Dictionary<string, object?> { ["x"] = 0.5 };
        var bytes = PositionalSchemaCodec.Encode(schema, dict);

        // 1 byte bitmask + 8 bytes for x = 9 bytes
        bytes.Length.Should().Be(9);
        bytes[0].Should().Be(0b00000001);

        var decoded = PositionalSchemaCodec.Decode(schema, bytes);
        decoded.Should().ContainKey("x");
        decoded.Should().NotContainKey("y");
        decoded.Should().NotContainKey("angle");
        decoded["x"].Should().Be(0.5);
    }

    [Fact]
    public void Encode_BitmaskCoversFieldCount()
    {
        // 9 fields → 2-byte bitmask
        var schema = Make(1,
            ("a", "u8"), ("b", "u8"), ("c", "u8"), ("d", "u8"),
            ("e", "u8"), ("f", "u8"), ("g", "u8"), ("h", "u8"), ("i", "u8"));
        var dict = new Dictionary<string, object?>
        {
            ["a"] = (byte)1, ["i"] = (byte)9
        };
        var bytes = PositionalSchemaCodec.Encode(schema, dict);

        bytes.Length.Should().Be(2 + 1 + 1);
        bytes[0].Should().Be(0b00000001);
        bytes[1].Should().Be(0b00000001);
        bytes[2].Should().Be(1);
        bytes[3].Should().Be(9);
    }

    [Fact]
    public void Encode_GuidField_RoundTrips()
    {
        var schema = Make(1, ("memberId", "guid"));
        var g = Guid.Parse("11223344-5566-7788-99aa-bbccddeeff00");
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>() { ["memberId"] = g });
        var decoded = PositionalSchemaCodec.Decode(schema, bytes);
        decoded["memberId"].Should().Be(g.ToString());
    }

    [Fact]
    public void Encode_NullableGuid_NullCase_OneByte()
    {
        var schema = Make(1, ("hitTargetId", "nullable-guid"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>() { ["hitTargetId"] = null });
        bytes.Length.Should().Be(2);
        var decoded = PositionalSchemaCodec.Decode(schema, bytes);
        decoded["hitTargetId"].Should().BeNull();
    }

    [Fact]
    public void Encode_NullableGuid_PresentCase_RoundTrips()
    {
        var schema = Make(1, ("hitTargetId", "nullable-guid"));
        var g = Guid.NewGuid();
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>() { ["hitTargetId"] = g.ToString() });
        var decoded = PositionalSchemaCodec.Decode(schema, bytes);
        decoded["hitTargetId"].Should().Be(g.ToString());
    }

    [Fact]
    public void Encode_StringField_LengthPrefixIsLittleEndian()
    {
        var schema = Make(1, ("s", "str"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>() { ["s"] = "hi" });
        bytes[0].Should().Be(0b00000001);
        bytes[1].Should().Be(2);
        bytes[2].Should().Be(0);
        bytes[3].Should().Be((byte)'h');
        bytes[4].Should().Be((byte)'i');
        var decoded = PositionalSchemaCodec.Decode(schema, bytes);
        decoded["s"].Should().Be("hi");
    }

    [Fact]
    public void Encode_BytesField_RoundTrips()
    {
        var schema = Make(1, ("v", "bytes"));
        var payload = new byte[] { 0x10, 0x20, 0x30, 0x40 };
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>() { ["v"] = payload });
        var decoded = PositionalSchemaCodec.Decode(schema, bytes);
        decoded["v"].Should().BeEquivalentTo(payload);
    }

    [Fact]
    public void Decode_TruncatedBitmask_ThrowsClearError()
    {
        var schema = Make(1,
            ("a", "u8"), ("b", "u8"), ("c", "u8"), ("d", "u8"),
            ("e", "u8"), ("f", "u8"), ("g", "u8"), ("h", "u8"), ("i", "u8"));
        Action act = () => PositionalSchemaCodec.Decode(schema, new byte[] { 0xFF });
        act.Should().Throw<InvalidOperationException>().WithMessage("*truncated bitmask*");
    }

    [Fact]
    public void Decode_TruncatedBody_ThrowsClearError()
    {
        var schema = Make(1, ("x", "f64"));
        Action act = () => PositionalSchemaCodec.Decode(schema, new byte[] { 0x01, 0x00 }); // bitmask + 1 body byte
        act.Should().Throw<InvalidOperationException>().WithMessage("*truncated*'x'*");
    }

    [Fact]
    public void Encode_NullValueOnNonNullableSlot_TreatedAsAbsent()
    {
        var schema = Make(1, ("x", "f64"), ("y", "f64"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>() { ["x"] = 1.0, ["y"] = null });
        bytes.Length.Should().Be(1 + 8); // bitmask + only x
        bytes[0].Should().Be(0b00000001);
    }

    // PR #96 review fix #4 cross-wire parity. The JS counterpart
    // (schema-codec-cross.test.mjs: "null on non-nullable f64 slot is
    // absent (matches C# bytes)") asserts the same input → same hex.
    // Pinning the byte-for-byte canonical form here keeps the two encoders
    // from drifting at the `null` boundary.
    [Fact]
    public void Encode_NullValueOnNonNullableSlot_ProducesCanonicalBytes()
    {
        var schema = Make(11, ("x", "f64"), ("y", "f64"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>() { ["x"] = 1.0, ["y"] = null });
        // bitmask=0x01 (only x) + IEEE-754 LE 1.0 = 00 00 00 00 00 00 F0 3F
        var hex = Convert.ToHexString(bytes).ToUpperInvariant();
        hex.Should().Be("01" + "000000000000F03F");
    }

    [Fact]
    public void Encode_BoolField_OneByte()
    {
        var schema = Make(1, ("flag", "bool"));
        var bytesT = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>() { ["flag"] = true });
        var bytesF = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>() { ["flag"] = false });
        bytesT.Should().BeEquivalentTo(new byte[] { 0x01, 0x01 });
        bytesF.Should().BeEquivalentTo(new byte[] { 0x01, 0x00 });
    }
}
