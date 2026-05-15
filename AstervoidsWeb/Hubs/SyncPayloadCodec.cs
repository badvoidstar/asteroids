using AstervoidsWeb.Formatters;
using MessagePack;
using MessagePack.Resolvers;

namespace AstervoidsWeb.Hubs;

/// <summary>
/// Hub-layer adapter between the server-internal
/// <see cref="Dictionary{TKey, TValue}"/> shape used by
/// <c>SessionObject.Data</c>, <c>ObjectUpdate</c>, and
/// <c>ReplacementObjectSpec</c>, and the wire-level
/// <see cref="SyncPayload"/> envelope used by <see cref="ObjectInfo"/>,
/// <see cref="ObjectUpdateInfo"/>, and <see cref="ObjectUpdateRequest"/>.
///
/// SchemaId=0 (the only schema implemented in Phase 3) represents the
/// dictionary as a MessagePack-serialized
/// <c>Dictionary&lt;string, object?&gt;</c>. The byte stream is wire-compatible
/// with the JS-side codec at <c>wwwroot/js/msgpack-codec.js</c>; both sides
/// can read either party's encoding (see
/// <c>SyncPayloadCrossWireFixturesTests</c> + <c>msgpack-codec-cross.test.mjs</c>).
///
/// Phase 4 will add SchemaId 1..N for positional, type-tagged records;
/// they bypass this codec on the JS side, but the server still treats the
/// byte stream as opaque storage.
/// </summary>
public static class SyncPayloadCodec
{
    /// <summary>
    /// MessagePack options used for the SchemaId=0 inner-dict serialization.
    /// MUST stay in sync with <c>Program.cs</c>'s hub options so the bytes
    /// the wire carries are exactly the same as those JS encodes/decodes.
    /// </summary>
    public static readonly MessagePackSerializerOptions DictOptions =
        MessagePackSerializerOptions.Standard
            .WithResolver(CompositeResolver.Create(
                BinaryGuidResolver.Instance,
                ContractlessStandardResolver.Instance))
            .WithSecurity(MessagePackSecurity.UntrustedData);

    /// <summary>
    /// Sentinel: identifies the "legacy MessagePack-encoded dict" payload format.
    /// Phase 4 will introduce additional schema ids registered per-session.
    /// </summary>
    public const byte LegacyDictSchemaId = 0;

    /// <summary>
    /// Wraps a server-internal data dict into the wire envelope. Returns a
    /// payload with SchemaId=0 and the dict serialized via the standard
    /// MessagePack options. Null/empty dicts produce an empty payload (Data is
    /// the canonical 1-byte empty fixmap, kept for round-trip symmetry).
    /// </summary>
    public static SyncPayload EncodeDict(Dictionary<string, object?>? data)
    {
        var bytes = MessagePackSerializer.Serialize(
            data ?? new Dictionary<string, object?>(0),
            DictOptions);
        return new SyncPayload(LegacyDictSchemaId, bytes);
    }

    /// <summary>
    /// Decodes a wire payload back to the server-internal data dict. Throws
    /// on unknown SchemaId so any future client→server schema-id collision
    /// surfaces loudly during dev rather than silently corrupting state.
    /// </summary>
    public static Dictionary<string, object?> DecodeDict(SyncPayload payload)
    {
        if (payload is null) return new Dictionary<string, object?>(0);
        if (payload.SchemaId != LegacyDictSchemaId)
        {
            throw new NotSupportedException(
                $"SyncPayload SchemaId={payload.SchemaId} is not yet supported by the server-side decoder. " +
                "Phase 3 only implements SchemaId=0 (legacy MessagePack-encoded dict).");
        }
        if (payload.Data is null || payload.Data.Length == 0)
        {
            return new Dictionary<string, object?>(0);
        }
        return MessagePackSerializer.Deserialize<Dictionary<string, object?>>(payload.Data, DictOptions)
               ?? new Dictionary<string, object?>(0);
    }
}
