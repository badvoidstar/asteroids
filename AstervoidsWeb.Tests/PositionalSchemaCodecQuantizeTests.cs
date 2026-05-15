using AstervoidsWeb.Hubs;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Phase 5 wireopt — quantization round-trip + tolerance + edge tests for the
/// new q16, q16s, q16_2pi, q8 type tags on the C# positional codec. Mirrors
/// AstervoidsWeb/schema-codec-quantize.test.mjs.
/// </summary>
public class PositionalSchemaCodecQuantizeTests
{
    private const double TwoPi = Math.PI * 2.0;

    private static PositionalSchemaCodec.Schema MakeSchema(byte id, params (string Name, string Type)[] fields)
        => new(id, fields.Select(f => new PositionalSchemaCodec.FieldSpec(f.Name, f.Type)).ToArray());

    [Fact]
    public void Q16_RoundTrip_AtCanonicalValues()
    {
        var s = MakeSchema(1, ("v", "q16"));
        foreach (var v in new[] { 0.0, 0.5, 1.0 })
        {
            var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = v });
            var back = PositionalSchemaCodec.Decode(s, bytes);
            ((double)back["v"]!).Should().BeApproximately(v, 2.0 / 65535.0);
        }
    }

    [Fact]
    public void Q16_WireSize_BitmaskPlus2()
    {
        var s = MakeSchema(1, ("v", "q16"));
        var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = 0.5 });
        bytes.Length.Should().Be(3);
    }

    [Fact]
    public void Q16_ClampsOutOfRange()
    {
        var s = MakeSchema(1, ("v", "q16"));
        var hi = PositionalSchemaCodec.Decode(s, PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = 2.5 }));
        ((double)hi["v"]!).Should().Be(1.0);
        var lo = PositionalSchemaCodec.Decode(s, PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = -0.3 }));
        ((double)lo["v"]!).Should().Be(0.0);
    }

    [Fact]
    public void Q16s_RoundTrip_AcrossSignedRange()
    {
        var s = MakeSchema(1, ("v", "q16s"));
        foreach (var v in new[] { -1.0, -0.5, 0.0, 0.5, 1.0, 0.123456 })
        {
            var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = v });
            var back = PositionalSchemaCodec.Decode(s, bytes);
            ((double)back["v"]!).Should().BeApproximately(v, 2.0 / 32767.0);
        }
    }

    [Fact]
    public void Q16s_WireSize_BitmaskPlus2()
    {
        var s = MakeSchema(1, ("v", "q16s"));
        var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = -0.5 });
        bytes.Length.Should().Be(3);
    }

    [Fact]
    public void Q16s_ClampsOutOfRange()
    {
        var s = MakeSchema(1, ("v", "q16s"));
        var hi = PositionalSchemaCodec.Decode(s, PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = 5.0 }));
        ((double)hi["v"]!).Should().Be(1.0);
        var lo = PositionalSchemaCodec.Decode(s, PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = -5.0 }));
        ((double)lo["v"]!).Should().Be(-1.0);
    }

    [Fact]
    public void Q16_2pi_RoundTrip_AcrossCircle()
    {
        var s = MakeSchema(1, ("v", "q16_2pi"));
        foreach (var v in new[] { 0.0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 1.234 })
        {
            var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = v });
            var back = PositionalSchemaCodec.Decode(s, bytes);
            ((double)back["v"]!).Should().BeApproximately(v, 2 * TwoPi / 65536.0);
        }
    }

    [Fact]
    public void Q16_2pi_WrapsNegativeAngle()
    {
        var s = MakeSchema(1, ("v", "q16_2pi"));
        var back = PositionalSchemaCodec.Decode(s, PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = -0.0001 }));
        var decoded = (double)back["v"]!;
        decoded.Should().BeGreaterThan(Math.PI, "negative input should wrap into the upper half of [0, 2π)");
        Math.Min(decoded, TwoPi - decoded).Should().BeLessThan(1e-3);
    }

    [Fact]
    public void Q16_2pi_WrapsExactly2PiToZero()
    {
        var s = MakeSchema(1, ("v", "q16_2pi"));
        var back = PositionalSchemaCodec.Decode(s, PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = TwoPi }));
        ((double)back["v"]!).Should().BeLessThan(2 * TwoPi / 65536.0);
    }

    [Fact]
    public void Q16_2pi_HandlesMultiRotationInput()
    {
        var s = MakeSchema(1, ("v", "q16_2pi"));
        var v = 5 * TwoPi + 1.0;
        var back = PositionalSchemaCodec.Decode(s, PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = v }));
        ((double)back["v"]!).Should().BeApproximately(1.0, 2 * TwoPi / 65536.0);
    }

    [Fact]
    public void Q8_RoundTrip_WithCoarseTolerance()
    {
        var s = MakeSchema(1, ("v", "q8"));
        foreach (var v in new[] { 0.0, 0.25, 0.5, 0.75, 1.0 })
        {
            var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = v });
            var back = PositionalSchemaCodec.Decode(s, bytes);
            ((double)back["v"]!).Should().BeApproximately(v, 1.0 / 255.0 + 1e-9);
        }
    }

    [Fact]
    public void Q8_WireSize_BitmaskPlus1()
    {
        var s = MakeSchema(1, ("v", "q8"));
        var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["v"] = 0.5 });
        bytes.Length.Should().Be(2);
    }

    [Fact]
    public void MixedQuantizedSchema_PacksAndDecodesCorrectly()
    {
        var s = MakeSchema(1,
            ("x", "q16"), ("y", "q16"), ("angle", "q16_2pi"),
            ("vx", "q16s"), ("thrusting", "bool"));
        var data = new Dictionary<string, object?>
        {
            ["x"] = 0.3, ["y"] = 0.7, ["angle"] = 1.2345,
            ["vx"] = -0.42, ["thrusting"] = true
        };
        var bytes = PositionalSchemaCodec.Encode(s, data);
        // bitmask(1) + 4×u/i16(8) + bool(1) = 10
        bytes.Length.Should().Be(10);
        var back = PositionalSchemaCodec.Decode(s, bytes);
        ((double)back["x"]!).Should().BeApproximately(0.3, 2 / 65535.0);
        ((double)back["y"]!).Should().BeApproximately(0.7, 2 / 65535.0);
        ((double)back["angle"]!).Should().BeApproximately(1.2345, 2 * TwoPi / 65536.0);
        ((double)back["vx"]!).Should().BeApproximately(-0.42, 2 / 32767.0);
        ((bool)back["thrusting"]!).Should().BeTrue();
    }

    [Fact]
    public void DeltaEncoding_OnlyChangedQuantizedFieldEmitted()
    {
        var s = MakeSchema(1, ("x", "q16"), ("y", "q16"), ("angle", "q16_2pi"));
        var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?> { ["x"] = 0.42 });
        // bitmask(1) + 1 q16(2) = 3 bytes
        bytes.Length.Should().Be(3);
        var back = PositionalSchemaCodec.Decode(s, bytes);
        ((double)back["x"]!).Should().BeApproximately(0.42, 2 / 65535.0);
        back.Should().NotContainKey("y");
        back.Should().NotContainKey("angle");
    }

    [Fact]
    public void AsteroidUpdateQuantizedSchema_TotalBodyIs7Bytes()
    {
        var s = MakeSchema(3, ("x", "q16"), ("y", "q16"), ("angle", "q16_2pi"));
        var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234
        });
        // bitmask(1) + 3×u16(6) = 7
        bytes.Length.Should().Be(7);
    }

    // ── Cross-wire parity: bytes from one side must decode on the other ────────
    // The JS counterpart `schema-codec-quantize.test.mjs` produces equivalent
    // bytes for the same inputs; the cross-wire harness in
    // `SchemaCrossWireFixturesTests.cs` covers Phase 4 fixtures; this test just
    // pins the wire shape against a known hex literal so any drift is loud.
    [Fact]
    public void Q16_FixedHexFixture_AsteroidUpdate()
    {
        var s = MakeSchema(3, ("x", "q16"), ("y", "q16"), ("angle", "q16_2pi"));
        var bytes = PositionalSchemaCodec.Encode(s, new Dictionary<string, object?>
        {
            ["x"] = 0.5,
            ["y"] = 0.25,
            ["angle"] = Math.PI
        });
        // C# uses MidpointRounding.AwayFromZero to match JS Math.round semantics:
        //   x = 0.5*65535 = 32767.5 → 32768 (0x8000 LE: 00 80)
        //   y = 0.25*65535 = 16383.75 → 16384 (0x4000 LE: 00 40)
        //   angle = π/(2π)*65536 = 32768 (0x8000 LE: 00 80)
        // Matches schema-codec-cross.test.mjs Phase 5 fixture exactly.
        var hex = Convert.ToHexString(bytes);
        hex.Should().Be("07008000400080");
    }
}
