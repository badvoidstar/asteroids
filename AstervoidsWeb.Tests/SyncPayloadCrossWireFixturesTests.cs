using System.Text;
using AstervoidsWeb.Formatters;
using AstervoidsWeb.Hubs;
using FluentAssertions;
using MessagePack;
using MessagePack.Resolvers;
using Xunit.Abstractions;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Cross-side wire fixtures for the Phase 3 SyncPayload envelope.
///
/// The Phase 3 wire envelope wraps every game-side data dict in
/// <see cref="SyncPayload"/> bytes. JS encodes outgoing dicts via
/// <c>wwwroot/js/msgpack-codec.js</c>; C# encodes via the standard
/// <see cref="MessagePackSerializer"/> with
/// <see cref="ContractlessStandardResolver"/>. The two MUST agree on
/// the wire format for SchemaId=0 (legacy MessagePack-encoded dict).
///
/// These tests:
/// 1. Pin C# encoder output to a known hex string for a handful of
///    representative dicts.
/// 2. Assert C#-decoded bytes round-trip back to the original dict.
///
/// The same hex strings are also embedded in
/// <c>AstervoidsWeb/msgpack-codec-cross.test.mjs</c>, which runs the
/// JS decoder against them and asserts equivalent JS dicts. Together
/// these two suites lock the wire shape on both sides.
/// </summary>
public class SyncPayloadCrossWireFixturesTests
{
    private readonly ITestOutputHelper _output;

    public SyncPayloadCrossWireFixturesTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private static readonly MessagePackSerializerOptions Options =
        MessagePackSerializerOptions.Standard
            .WithResolver(CompositeResolver.Create(
                BinaryGuidResolver.Instance,
                ContractlessStandardResolver.Instance))
            .WithSecurity(MessagePackSecurity.UntrustedData);

    private static string HexOf<T>(T v)
    {
        var bytes = MessagePackSerializer.Serialize(v, Options);
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (var b in bytes) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    [Fact]
    public void Encode_Simple_TwoDoubles_MatchesFixture()
    {
        var d = new Dictionary<string, object?>
        {
            ["x"] = 0.5,
            ["y"] = 0.25
        };
        var hex = HexOf(d);
        _output.WriteLine($"simple: {hex}");
        // map(2) { fixstr "x" → float64 0.5, fixstr "y" → float64 0.25 }
        // 82 a1 78 cb 3fe0000000000000 a1 79 cb 3fd0000000000000
        hex.Should().Be("82a178cb3fe0000000000000a179cb3fd0000000000000");
    }

    [Fact]
    public void Encode_ShipUpdate_MatchesFixture()
    {
        var d = new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234,
            ["thrusting"] = true,
            ["invulnerable"] = false
        };
        var hex = HexOf(d);
        _output.WriteLine($"ship: {hex}");
        hex.Should().Be(
            "85" +
            "a178" + "cb3fe0bc6a7ef9db23" +     // x = 0.523
            "a179" + "cb3fda5e353f7ced91" +     // y = 0.412
            "a5616e676c65" + "cb3ff3be76c8b43958" + // angle = 1.234
            "a9746872757374696e67" + "c3" +     // thrusting = true (fixstr len 9)
            "ac696e76756c6e657261626c65" + "c2" // invulnerable = false (fixstr len 12)
        );
    }

    [Fact]
    public void Encode_SmallInts_AsInt32_FromCSharpSide()
    {
        // KEY INTEROP NOTE: C#-side ints (literal `100`) are System.Int32.
        // ContractlessStandardResolver's PrimitiveObjectFormatter writes
        // the runtime type directly: int → msgpack int32 (5 bytes), even
        // for small values. The JS-side encoder picks msgpack fixint
        // (1 byte) for the same value. BOTH decoders accept BOTH
        // encodings — interop is sound, just asymmetric on the wire.
        //
        // On the round-trip from JS to server, server reads fixint (1 B),
        // PrimitiveObjectFormatter returns byte/sbyte (smallest fitting
        // type), and re-emission stays compact. So most update broadcasts
        // (server echoes JS-authored dicts) keep the small form.
        var d = new Dictionary<string, object?>
        {
            ["score"] = 100,
            ["hitCount"] = 2
        };
        var hex = HexOf(d);
        _output.WriteLine($"with_int: {hex}");
        // C# emits int32 here because literal 100/2 are System.Int32.
        hex.Should().Be("82" + "a573636f7265" + "d200000064" + "a8686974436f756e74" + "d200000002");
    }

    [Fact]
    public void Encode_StringGuid_AsStr8()
    {
        var d = new Dictionary<string, object?>
        {
            ["memberId"] = "abcdef01-2345-6789-abcd-ef0123456789"
        };
        var hex = HexOf(d);
        _output.WriteLine($"with_string_guid: {hex}");
        // map(1) { "memberId" → str8(36) "abcdef01-..." }
        // 81 a8 6d656d62657249 64 d9 24 <36 ASCII bytes>
        hex.Should().StartWith("81a8" + "6d656d6265724964" + "d924");
        hex.Should().HaveLength(/*81*/2 + /*a8*/2 + /*8 chars*/16 + /*d9 24*/4 + /*36 hex chars*2*/72);
    }

    [Fact]
    public void Encode_NullValue_AsNil()
    {
        var d = new Dictionary<string, object?>
        {
            ["hitTargetId"] = null,
            ["pendingHit"] = false
        };
        var hex = HexOf(d);
        _output.WriteLine($"with_null: {hex}");
        // map(2) { "hitTargetId" → nil(c0), "pendingHit" → false(c2) }
        hex.Should().Be("82" + "ab" + "6869745461726765744964" + "c0" + "aa" + "70656e64696e67486974" + "c2");
    }

    [Fact]
    public void Decode_RoundTrips_PreservesValueTypes()
    {
        // Asserts MessagePack-CSharp decodes its own encoding back to the
        // same dict structure with the same value types. This is what the
        // server will see when reading a JS-side encoded payload.
        var original = new Dictionary<string, object?>
        {
            ["x"] = 0.523,                      // double
            ["score"] = 100,                    // int (encoded as fixint)
            ["thrusting"] = true,               // bool
            ["pendingHit"] = false,             // bool
            ["memberId"] = "abc-def",           // string
            ["hitTargetId"] = null              // null
        };
        var bytes = MessagePackSerializer.Serialize(original, Options);
        var decoded = MessagePackSerializer.Deserialize<Dictionary<string, object?>>(bytes, Options);

        decoded.Should().NotBeNull();
        decoded!["x"].Should().Be(0.523);
        // PrimitiveObjectFormatter reads fixint as the smallest signed integer
        // type that fits — so 100 comes back as `byte` (or sbyte if negative).
        // The exact runtime type doesn't matter to game code; what matters is
        // that downstream Convert.ToInt64(...)/equality checks work.
        Convert.ToInt64(decoded["score"]).Should().Be(100);
        decoded["thrusting"].Should().Be(true);
        decoded["pendingHit"].Should().Be(false);
        decoded["memberId"].Should().Be("abc-def");
        decoded["hitTargetId"].Should().BeNull();
    }
}
