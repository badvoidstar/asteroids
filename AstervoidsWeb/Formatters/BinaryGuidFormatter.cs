using MessagePack;
using MessagePack.Formatters;

namespace AstervoidsWeb.Formatters;

/// <summary>
/// MessagePack formatter that serializes <see cref="Guid"/> as 16-byte binary instead of
/// a 36-character string. Saves ~19 bytes per GUID on the wire (37 bytes string encoding
/// → 18 bytes binary encoding in MessagePack).
///
/// Deserialization accepts both binary (new format) and string (JS clients sending GUID
/// strings), so the server can always read GUIDs regardless of how the client sends them.
/// </summary>
public sealed class BinaryGuidFormatter : IMessagePackFormatter<Guid>
{
    public static readonly BinaryGuidFormatter Instance = new();

    public void Serialize(ref MessagePackWriter writer, Guid value, MessagePackSerializerOptions options)
    {
        byte[] bytes = value.ToByteArray();
        writer.Write(bytes);
    }

    public Guid Deserialize(ref MessagePackReader reader, MessagePackSerializerOptions options)
    {
        if (reader.NextMessagePackType == MessagePackType.Binary)
        {
            var seq = reader.ReadBytes()
                ?? throw new MessagePackSerializationException("Unexpected nil when deserializing Guid binary");

            if (seq.Length != 16)
                throw new MessagePackSerializationException(
                    $"Expected 16 bytes for Guid, got {seq.Length}");

            if (seq.IsSingleSegment)
                return new Guid(seq.FirstSpan);

            // Multi-segment: copy to contiguous buffer
            byte[] buf = new byte[16];
            int offset = 0;
            foreach (var segment in seq)
            {
                segment.Span.CopyTo(buf.AsSpan(offset));
                offset += segment.Length;
            }
            return new Guid(buf);
        }

        if (reader.NextMessagePackType == MessagePackType.String)
        {
            var str = reader.ReadString()!;
            return Guid.Parse(str);
        }

        throw new MessagePackSerializationException(
            $"Cannot deserialize Guid from MessagePack type {reader.NextMessagePackType}");
    }
}

/// <summary>
/// Nullable variant of <see cref="BinaryGuidFormatter"/>.
/// Writes <c>nil</c> for null values; delegates to <see cref="BinaryGuidFormatter"/>
/// for non-null values.
/// </summary>
public sealed class NullableGuidFormatter : IMessagePackFormatter<Guid?>
{
    public static readonly NullableGuidFormatter Instance = new();

    public void Serialize(ref MessagePackWriter writer, Guid? value, MessagePackSerializerOptions options)
    {
        if (!value.HasValue)
        {
            writer.WriteNil();
            return;
        }

        BinaryGuidFormatter.Instance.Serialize(ref writer, value.Value, options);
    }

    public Guid? Deserialize(ref MessagePackReader reader, MessagePackSerializerOptions options)
    {
        if (reader.TryReadNil())
            return null;

        return BinaryGuidFormatter.Instance.Deserialize(ref reader, options);
    }
}

/// <summary>
/// Resolver that provides <see cref="BinaryGuidFormatter"/> for <see cref="Guid"/>
/// and <see cref="NullableGuidFormatter"/> for <see cref="Guid?"/>.
/// Should be composed ahead of <c>ContractlessStandardResolver</c> so that
/// typed Guid properties use binary encoding while everything else falls through.
/// </summary>
public sealed class BinaryGuidResolver : IFormatterResolver
{
    public static readonly BinaryGuidResolver Instance = new();

    public IMessagePackFormatter<T>? GetFormatter<T>()
    {
        if (typeof(T) == typeof(Guid))
            return (IMessagePackFormatter<T>)(object)BinaryGuidFormatter.Instance;

        if (typeof(T) == typeof(Guid?))
            return (IMessagePackFormatter<T>)(object)NullableGuidFormatter.Instance;

        return null;
    }
}
