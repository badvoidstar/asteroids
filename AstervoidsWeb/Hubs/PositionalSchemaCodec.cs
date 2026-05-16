using System.Buffers.Binary;
using System.Text;

namespace AstervoidsWeb.Hubs;

/// <summary>
/// Phase 4 wireopt — positional schema codec. Counterpart to
/// <c>AstervoidsWeb/wwwroot/js/schema-codec.js</c>; the two MUST stay in
/// lockstep on the wire format.
///
/// Fixed-byte slots per type tag (no MessagePack value markers); a leading
/// presence bitmask carries which slots are populated, so delta encoding
/// still works (omitted slots are merged against prior state by
/// <see cref="Services.ObjectService.ApplyUpdate"/>, matching the existing
/// dict-merge semantics).
///
/// Wire shape (the bytes inside <c>SyncPayload.Data</c> when SchemaId &gt;= 1):
///
///   &lt;bitmask: ceil(N/8) bytes, bit i = field i present&gt;
///   &lt;slot_i ...&gt; (only for fields whose bit is set, in declaration order)
///
/// Type tags supported in Phase 4:
/// <list type="bullet">
///   <item><c>f64/f32</c> — IEEE-754 little-endian (8 / 4 bytes)</item>
///   <item><c>u32/i32 u16/i16 u8/i8</c> — little-endian fixed</item>
///   <item><c>bool</c> — 1 byte (0 or 1)</item>
///   <item><c>str</c> — 2-byte LE length + UTF-8 bytes (max 65535 bytes)</item>
///   <item><c>guid</c> — 16 bytes (matches <c>BinaryGuidResolver</c> ordering)</item>
///   <item><c>bytes</c> — 4-byte LE length + raw bytes</item>
///   <item><c>nullable-str</c>, <c>nullable-guid</c> — 1-byte presence flag + (if set) the value</item>
/// </list>
///
/// Phase 5 quantized type tags (lossy fixed-point):
/// <list type="bullet">
///   <item><c>q16</c>     — uint16 over [0, 1)   (2 B; resolution ≈ 1.5e-5)</item>
///   <item><c>q16s</c>    — int16  over [-1, 1]  (2 B; resolution ≈ 3.0e-5)</item>
///   <item><c>q16_2pi</c> — uint16 over [0, 2π)  (2 B; resolution ≈ 9.6e-5 rad)</item>
///   <item><c>q8</c>      — uint8  over [0, 1)   (1 B; resolution ≈ 4e-3)</item>
/// </list>
/// </summary>
public static class PositionalSchemaCodec
{
    public const int MaxFields = 32;
    private const double TwoPi = Math.PI * 2.0;
    // q16w: wrap-extended quantized position. Maps [-0.5, 1.5] → [0, 65535].
    // The game's wrapNormalized lets owner positions transit an off-screen
    // margin of up to ~0.15 normalized (large asteroid on a tall portrait
    // viewport) before snapping to the opposite edge. q16's [0,1] clamp would
    // park remote objects at the edge for the whole excursion. q16w gives 3×
    // headroom over the worst plausible margin while keeping resolution
    // sub-pixel on a 4K canvas (2/65535 ≈ 3.05e-5).
    private const double Q16wLo = -0.5;
    private const double Q16wHi = 1.5;
    private const double Q16wRange = Q16wHi - Q16wLo; // 2.0

    public sealed record FieldSpec(string Name, string Type);

    public sealed class Schema
    {
        public byte Id { get; }
        public IReadOnlyList<FieldSpec> Fields { get; }
        public int BitmaskBytes { get; }

        public Schema(byte id, IReadOnlyList<FieldSpec> fields)
        {
            if (id == 0) throw new ArgumentException("Schema id 0 is reserved for the legacy dict envelope.");
            if (fields == null || fields.Count == 0) throw new ArgumentException("Schema must have at least one field.");
            if (fields.Count > MaxFields) throw new ArgumentException($"Schema {id}: max {MaxFields} fields per schema; got {fields.Count}");
            var seen = new HashSet<string>();
            foreach (var f in fields)
            {
                if (f == null || string.IsNullOrEmpty(f.Name)) throw new ArgumentException($"Schema {id}: empty field name");
                if (!seen.Add(f.Name)) throw new ArgumentException($"Schema {id}: duplicate field name '{f.Name}'");
                ValidateTypeTag(id, f.Name, f.Type);
            }
            Id = id;
            Fields = fields;
            BitmaskBytes = (fields.Count + 7) / 8;
        }

        private static void ValidateTypeTag(byte schemaId, string fieldName, string type)
        {
            switch (type)
            {
                case "f64": case "f32":
                case "u32": case "u16": case "u8":
                case "i32": case "i16": case "i8":
                case "bool": case "str": case "guid": case "bytes":
                case "nullable-str": case "nullable-guid":
                case "q16": case "q16w": case "q16s": case "q16_2pi": case "q8":
                    return;
                default:
                    throw new ArgumentException($"Schema {schemaId} field '{fieldName}': unknown type tag '{type}'");
            }
        }
    }

    /// <summary>
    /// Encode a key/value dict into the positional binary form per the schema.
    /// Fields not present in <paramref name="dict"/> (key missing) are omitted
    /// from the bitmask. Throws on type-mismatch / unsupported value types.
    /// </summary>
    public static byte[] Encode(Schema schema, IDictionary<string, object?> dict)
    {
        var fields = schema.Fields;
        var bitmask = new byte[schema.BitmaskBytes];
        var slotPresent = new bool[fields.Count];
        var utf8Cache = new byte[fields.Count][];
        var bodySize = 0;

        for (int i = 0; i < fields.Count; i++)
        {
            var f = fields[i];
            if (!dict.TryGetValue(f.Name, out var v) || v is null && f.Type is not "nullable-str" and not "nullable-guid")
            {
                // Plain absent OR a hard-typed slot getting a null -> treat as absent.
                if (!dict.ContainsKey(f.Name)) continue;
                if (v is null && f.Type is not "nullable-str" and not "nullable-guid") continue;
            }
            slotPresent[i] = true;
            bitmask[i >> 3] |= (byte)(1 << (i & 7));

            switch (f.Type)
            {
                case "f64": bodySize += 8; break;
                case "f32": bodySize += 4; break;
                case "u32": case "i32": bodySize += 4; break;
                case "u16": case "i16": bodySize += 2; break;
                case "u8":  case "i8":  bodySize += 1; break;
                case "q16": case "q16w": case "q16s": case "q16_2pi": bodySize += 2; break;
                case "q8":  bodySize += 1; break;
                case "bool": bodySize += 1; break;
                case "guid": bodySize += 16; break;
                case "nullable-guid":
                    bodySize += 1 + (v is null ? 0 : 16);
                    break;
                case "str":
                {
                    var s = Convert.ToString(v) ?? string.Empty;
                    var enc = Encoding.UTF8.GetBytes(s);
                    if (enc.Length > 0xFFFF) throw new InvalidOperationException($"str field '{f.Name}' exceeds 65535 bytes");
                    utf8Cache[i] = enc;
                    bodySize += 2 + enc.Length;
                    break;
                }
                case "nullable-str":
                {
                    if (v is null) { bodySize += 1; }
                    else
                    {
                        var s = Convert.ToString(v) ?? string.Empty;
                        var enc = Encoding.UTF8.GetBytes(s);
                        if (enc.Length > 0xFFFF) throw new InvalidOperationException($"nullable-str field '{f.Name}' exceeds 65535 bytes");
                        utf8Cache[i] = enc;
                        bodySize += 1 + 2 + enc.Length;
                    }
                    break;
                }
                case "bytes":
                {
                    if (v is not byte[] ba) throw new InvalidOperationException($"bytes field '{f.Name}' must be byte[], got {v?.GetType().Name}");
                    bodySize += 4 + ba.Length;
                    break;
                }
            }
        }

        var output = new byte[schema.BitmaskBytes + bodySize];
        bitmask.CopyTo(output.AsSpan());
        var span = output.AsSpan(schema.BitmaskBytes);
        var off = 0;

        for (int i = 0; i < fields.Count; i++)
        {
            if (!slotPresent[i]) continue;
            var f = fields[i];
            var v = dict[f.Name];
            switch (f.Type)
            {
                case "f64":
                    BinaryPrimitives.WriteDoubleLittleEndian(span.Slice(off, 8), Convert.ToDouble(v));
                    off += 8; break;
                case "f32":
                    BinaryPrimitives.WriteSingleLittleEndian(span.Slice(off, 4), (float)Convert.ToDouble(v));
                    off += 4; break;
                case "u32":
                    BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(off, 4), Convert.ToUInt32(v));
                    off += 4; break;
                case "i32":
                    BinaryPrimitives.WriteInt32LittleEndian(span.Slice(off, 4), Convert.ToInt32(v));
                    off += 4; break;
                case "u16":
                    BinaryPrimitives.WriteUInt16LittleEndian(span.Slice(off, 2), Convert.ToUInt16(v));
                    off += 2; break;
                case "i16":
                    BinaryPrimitives.WriteInt16LittleEndian(span.Slice(off, 2), Convert.ToInt16(v));
                    off += 2; break;
                case "u8":  span[off] = Convert.ToByte(v); off += 1; break;
                case "i8":  span[off] = (byte)Convert.ToSByte(v); off += 1; break;
                case "q16":
                {
                    var d = Clamp01(Convert.ToDouble(v));
                    var q = (ushort)Math.Round(d * 65535.0, MidpointRounding.AwayFromZero);
                    BinaryPrimitives.WriteUInt16LittleEndian(span.Slice(off, 2), q);
                    off += 2; break;
                }
                case "q16w":
                {
                    // Wrap-extended position; see Q16w* constants for rationale.
                    var d = ClampQ16w(Convert.ToDouble(v));
                    var q = (ushort)Math.Round((d - Q16wLo) / Q16wRange * 65535.0, MidpointRounding.AwayFromZero);
                    BinaryPrimitives.WriteUInt16LittleEndian(span.Slice(off, 2), q);
                    off += 2; break;
                }
                case "q16s":
                {
                    var d = Clamp11(Convert.ToDouble(v));
                    var q = (short)Math.Round(d * 32767.0, MidpointRounding.AwayFromZero);
                    BinaryPrimitives.WriteInt16LittleEndian(span.Slice(off, 2), q);
                    off += 2; break;
                }
                case "q16_2pi":
                {
                    var d = Wrap2Pi(Convert.ToDouble(v));
                    var q = (ushort)(((long)Math.Round(d / TwoPi * 65536.0, MidpointRounding.AwayFromZero)) & 0xffff);
                    BinaryPrimitives.WriteUInt16LittleEndian(span.Slice(off, 2), q);
                    off += 2; break;
                }
                case "q8":
                {
                    var d = Clamp01(Convert.ToDouble(v));
                    span[off] = (byte)Math.Round(d * 255.0, MidpointRounding.AwayFromZero);
                    off += 1; break;
                }
                case "bool": span[off] = (Convert.ToBoolean(v) ? (byte)1 : (byte)0); off += 1; break;
                case "guid":
                {
                    if (v is null) throw new InvalidOperationException($"guid field '{f.Name}' cannot be null; use nullable-guid");
                    var g = ToGuid(v);
                    g.TryWriteBytes(span.Slice(off, 16));
                    off += 16; break;
                }
                case "nullable-guid":
                {
                    if (v is null) { span[off++] = 0; }
                    else
                    {
                        span[off++] = 1;
                        var g = ToGuid(v);
                        g.TryWriteBytes(span.Slice(off, 16));
                        off += 16;
                    }
                    break;
                }
                case "str":
                {
                    var enc = utf8Cache[i];
                    BinaryPrimitives.WriteUInt16LittleEndian(span.Slice(off, 2), (ushort)enc.Length);
                    off += 2;
                    enc.CopyTo(span.Slice(off, enc.Length));
                    off += enc.Length;
                    break;
                }
                case "nullable-str":
                {
                    if (v is null) { span[off++] = 0; }
                    else
                    {
                        span[off++] = 1;
                        var enc = utf8Cache[i];
                        BinaryPrimitives.WriteUInt16LittleEndian(span.Slice(off, 2), (ushort)enc.Length);
                        off += 2;
                        enc.CopyTo(span.Slice(off, enc.Length));
                        off += enc.Length;
                    }
                    break;
                }
                case "bytes":
                {
                    var ba = (byte[])v!;
                    BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(off, 4), (uint)ba.Length);
                    off += 4;
                    ba.CopyTo(span.Slice(off, ba.Length));
                    off += ba.Length;
                    break;
                }
            }
        }

        return output;
    }

    /// <summary>
    /// Decode positional bytes back to a sparse dict. Slots whose bitmask bit
    /// is 0 are simply omitted from the returned dict (matches the JS-side
    /// behavior; the caller's merge step handles "keep prior value").
    /// </summary>
    public static Dictionary<string, object?> Decode(Schema schema, byte[] bytes)
    {
        if (bytes is null) throw new ArgumentNullException(nameof(bytes));
        if (bytes.Length < schema.BitmaskBytes)
            throw new InvalidOperationException($"positional decode: truncated bitmask (need {schema.BitmaskBytes}, got {bytes.Length})");
        var fields = schema.Fields;
        var span = bytes.AsSpan(schema.BitmaskBytes);
        var off = 0;
        var result = new Dictionary<string, object?>(fields.Count);

        for (int i = 0; i < fields.Count; i++)
        {
            var present = (bytes[i >> 3] & (1 << (i & 7))) != 0;
            if (!present) continue;
            var f = fields[i];
            switch (f.Type)
            {
                case "f64": Need(8, f.Name, span, off); result[f.Name] = BinaryPrimitives.ReadDoubleLittleEndian(span.Slice(off, 8)); off += 8; break;
                case "f32": Need(4, f.Name, span, off); result[f.Name] = (double)BinaryPrimitives.ReadSingleLittleEndian(span.Slice(off, 4)); off += 4; break;
                case "u32": Need(4, f.Name, span, off); result[f.Name] = (long)BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(off, 4)); off += 4; break;
                case "i32": Need(4, f.Name, span, off); result[f.Name] = (long)BinaryPrimitives.ReadInt32LittleEndian(span.Slice(off, 4)); off += 4; break;
                case "u16": Need(2, f.Name, span, off); result[f.Name] = (long)BinaryPrimitives.ReadUInt16LittleEndian(span.Slice(off, 2)); off += 2; break;
                case "i16": Need(2, f.Name, span, off); result[f.Name] = (long)BinaryPrimitives.ReadInt16LittleEndian(span.Slice(off, 2)); off += 2; break;
                case "u8":  Need(1, f.Name, span, off); result[f.Name] = (long)span[off]; off += 1; break;
                case "i8":  Need(1, f.Name, span, off); result[f.Name] = (long)(sbyte)span[off]; off += 1; break;
                case "q16": Need(2, f.Name, span, off); result[f.Name] = (double)BinaryPrimitives.ReadUInt16LittleEndian(span.Slice(off, 2)) / 65535.0; off += 2; break;
                case "q16w": Need(2, f.Name, span, off); result[f.Name] = (double)BinaryPrimitives.ReadUInt16LittleEndian(span.Slice(off, 2)) / 65535.0 * Q16wRange + Q16wLo; off += 2; break;
                case "q16s": Need(2, f.Name, span, off); result[f.Name] = (double)BinaryPrimitives.ReadInt16LittleEndian(span.Slice(off, 2)) / 32767.0; off += 2; break;
                case "q16_2pi": Need(2, f.Name, span, off); result[f.Name] = (double)BinaryPrimitives.ReadUInt16LittleEndian(span.Slice(off, 2)) / 65536.0 * TwoPi; off += 2; break;
                case "q8":  Need(1, f.Name, span, off); result[f.Name] = (double)span[off] / 255.0; off += 1; break;
                case "bool": Need(1, f.Name, span, off); result[f.Name] = span[off] != 0; off += 1; break;
                case "guid": Need(16, f.Name, span, off); result[f.Name] = new Guid(span.Slice(off, 16)).ToString(); off += 16; break;
                case "nullable-guid":
                {
                    Need(1, f.Name, span, off);
                    var flag = span[off++];
                    if (flag == 0) result[f.Name] = null;
                    else
                    {
                        Need(16, f.Name, span, off);
                        result[f.Name] = new Guid(span.Slice(off, 16)).ToString();
                        off += 16;
                    }
                    break;
                }
                case "str":
                {
                    Need(2, f.Name, span, off);
                    var len = BinaryPrimitives.ReadUInt16LittleEndian(span.Slice(off, 2)); off += 2;
                    Need(len, f.Name, span, off);
                    result[f.Name] = Encoding.UTF8.GetString(span.Slice(off, len));
                    off += len;
                    break;
                }
                case "nullable-str":
                {
                    Need(1, f.Name, span, off);
                    var flag = span[off++];
                    if (flag == 0) result[f.Name] = null;
                    else
                    {
                        Need(2, f.Name, span, off);
                        var len = BinaryPrimitives.ReadUInt16LittleEndian(span.Slice(off, 2)); off += 2;
                        Need(len, f.Name, span, off);
                        result[f.Name] = Encoding.UTF8.GetString(span.Slice(off, len));
                        off += len;
                    }
                    break;
                }
                case "bytes":
                {
                    Need(4, f.Name, span, off);
                    var len = (int)BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(off, 4)); off += 4;
                    Need(len, f.Name, span, off);
                    var ba = new byte[len];
                    span.Slice(off, len).CopyTo(ba);
                    result[f.Name] = ba;
                    off += len;
                    break;
                }
                default: throw new InvalidOperationException($"Unknown type tag {f.Type}");
            }
        }
        return result;
    }

    private static void Need(int n, string fieldName, ReadOnlySpan<byte> span, int off)
    {
        if (off + n > span.Length)
            throw new InvalidOperationException($"positional decode: truncated at field '{fieldName}' (need {n} bytes, {span.Length - off} remaining)");
    }

    private static Guid ToGuid(object value)
    {
        if (value is Guid g) return g;
        if (value is string s) return Guid.Parse(s);
        throw new InvalidOperationException($"guid field expects Guid or string; got {value?.GetType().Name}");
    }

    private static double Clamp01(double v) => v < 0 ? 0 : v > 1 ? 1 : v;
    private static double Clamp11(double v) => v < -1 ? -1 : v > 1 ? 1 : v;
    private static double ClampQ16w(double v) => v < Q16wLo ? Q16wLo : v > Q16wHi ? Q16wHi : v;
    private static double Wrap2Pi(double v)
    {
        var m = v % TwoPi;
        return m < 0 ? m + TwoPi : m;
    }
}
