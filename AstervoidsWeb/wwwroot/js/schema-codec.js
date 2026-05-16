/**
 * Phase 4 wireopt — Positional Schema Codec + Registry
 *
 * Encodes a JS dict into a compact positional binary form per a registered
 * schema. Fixed-byte slots per type tag (no msgpack value markers); a leading
 * field-presence bitmask carries which slots are populated, so delta encoding
 * still works (omitted slots are inferred from prior state by the receiver,
 * matching the current Object.assign() merge semantics).
 *
 * Wire shape (the bytes inside SyncPayload.Data when SchemaId >= 1):
 *
 *   <bitmask: ceil(N/8) bytes, little-endian byte order, bit i = field i present>
 *   <slot_i ...>      (only for fields whose bit is set, in declaration order)
 *
 * Type tags supported in Phase 4:
 *   - 'f64'  : 8 bytes IEEE-754 little-endian
 *   - 'f32'  : 4 bytes IEEE-754 little-endian
 *   - 'u32'/'i32' : 4 bytes little-endian
 *   - 'u16'/'i16' : 2 bytes little-endian
 *   - 'u8' /'i8'  : 1 byte
 *   - 'bool' : 1 byte (0 or 1)
 *   - 'str'  : 2-byte LE length + UTF-8 bytes (max 65535 bytes)
 *   - 'guid' : 16 bytes little-endian (matches BinaryGuidResolver byte order)
 *   - 'bytes': 4-byte LE length + raw bytes
 *   - 'nullable-str' : 1-byte presence flag + (if present) 2-byte len + UTF-8
 *   - 'nullable-guid': 1-byte presence flag + (if present) 16 bytes
 *
 * Phase 5 quantized type tags (lossy fixed-point, 2 bytes each):
 *   - 'q16'      : uint16 over [0, 1)        — resolution 1/65535 ≈ 1.5e-5
 *   - 'q16w'     : uint16 over [-0.5, 1.5]   — wrap-extended position; covers
 *                  the off-screen margin region used by wrapNormalized so
 *                  asteroids/ships transit smoothly across edges instead of
 *                  clamping at 0 or 1. Resolution 2/65535 ≈ 3.05e-5
 *                  (sub-pixel on a 4K canvas).
 *   - 'q16s'     : int16  over [-1, 1]       — resolution 2/65534 ≈ 3.0e-5
 *   - 'q16_2pi'  : uint16 over [0, 2π)       — resolution ≈ 9.6e-5 rad ≈ 0.0055°
 *   - 'q8'       : uint8  over [0, 1)        — resolution 1/255 ≈ 4e-3
 *
 * All quantized encoders clamp / wrap into the canonical range before
 * rounding. Decoders return float in the same range.
 *
 * Schemas are identified by a single byte SchemaId >= 1 (0 reserved for the
 * Phase 3 legacy dict envelope). Maximum 32 fields per schema (4-byte bitmask).
 *
 * Both peers MUST agree on the schema definition for a given SchemaId.
 * Coordination happens via session metadata (`metadata.schemas`) — see Phase
 * 4.2 / `object-sync.js` registration flow.
 */
const SchemaCodec = (function () {
    const MAX_FIELDS = 32;
    const TYPE_TAGS = new Set([
        'f64', 'f32',
        'u32', 'u16', 'u8',
        'i32', 'i16', 'i8',
        'bool', 'str', 'guid', 'bytes',
        'nullable-str', 'nullable-guid',
        // Phase 5 quantized types — all 2 bytes on the wire
        'q16', 'q16w', 'q16s', 'q16_2pi', 'q8',
    ]);

    const TWO_PI = Math.PI * 2;
    // q16w covers the wrap-extended position range used by wrapNormalized.
    // Asteroid wrapMargin can reach ~0.15 normalized on a tall portrait
    // viewport (radius 0.083 × refDim/gameWidth where refDim = min(w,h)).
    // [-0.5, 1.5] gives 3× headroom over the worst plausible margin while
    // keeping resolution sub-pixel on a 4K canvas.
    const Q16W_LO = -0.5;
    const Q16W_HI = 1.5;
    const Q16W_RANGE = Q16W_HI - Q16W_LO; // 2.0
    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function clamp11(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
    function clampQ16w(v) { return v < Q16W_LO ? Q16W_LO : v > Q16W_HI ? Q16W_HI : v; }
    function wrap2pi(v) {
        // Normalize into [0, 2π) so q16_2pi roundtrips cleanly across 0/2π edge.
        const m = v % TWO_PI;
        return m < 0 ? m + TWO_PI : m;
    }

    function bitmaskByteCount(fieldCount) {
        return Math.ceil(fieldCount / 8);
    }

    /**
     * Validates and normalizes a schema definition. Throws on any structural
     * problem so registration mistakes surface during dev rather than at first
     * encode.
     */
    function normalizeSchema(id, fields) {
        if (!Number.isInteger(id) || id < 1 || id > 255) {
            throw new Error(`Schema id must be a byte in [1, 255]; got ${id}`);
        }
        if (!Array.isArray(fields) || fields.length === 0) {
            throw new Error(`Schema ${id}: fields must be a non-empty array of [name, typeTag]`);
        }
        if (fields.length > MAX_FIELDS) {
            throw new Error(`Schema ${id}: max ${MAX_FIELDS} fields per schema; got ${fields.length}`);
        }
        const seen = new Set();
        const norm = [];
        for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            if (!Array.isArray(f) || f.length !== 2 || typeof f[0] !== 'string' || typeof f[1] !== 'string') {
                throw new Error(`Schema ${id} field ${i}: must be [name:string, typeTag:string]`);
            }
            const [name, type] = f;
            if (!TYPE_TAGS.has(type)) {
                throw new Error(`Schema ${id} field ${name}: unknown type tag '${type}'`);
            }
            if (seen.has(name)) {
                throw new Error(`Schema ${id}: duplicate field name '${name}'`);
            }
            seen.add(name);
            norm.push({ name, type });
        }
        return { id, fields: norm, bitmaskBytes: bitmaskByteCount(norm.length) };
    }

    /**
     * GUID string ("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx") → 16-byte Uint8Array.
     * Byte order matches MessagePack-CSharp's BinaryGuidResolver (little-endian
     * for the first 3 fields, network order for the remaining 8 bytes).
     */
    function guidStringToBytes(s) {
        if (typeof s !== 'string' || s.length !== 36) {
            throw new Error(`GUID must be a 36-char string; got ${typeof s} length ${s && s.length}`);
        }
        const hex = s.replace(/-/g, '');
        if (hex.length !== 32) throw new Error(`Malformed GUID string: ${s}`);
        const bytes = new Uint8Array(16);
        // LE for first 4 bytes, then 2, then 2, then 8 in network order.
        const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
        for (let i = 0; i < 16; i++) {
            const hi = parseInt(hex.charAt(order[i] * 2), 16);
            const lo = parseInt(hex.charAt(order[i] * 2 + 1), 16);
            bytes[i] = (hi << 4) | lo;
        }
        return bytes;
    }

    /**
     * 16-byte GUID buffer → "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".
     */
    function bytesToGuidString(bytes, offset) {
        const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
        const hex = new Array(32);
        for (let i = 0; i < 16; i++) {
            const b = bytes[offset + order[i]];
            hex[i * 2] = (b >>> 4).toString(16);
            hex[i * 2 + 1] = (b & 0x0f).toString(16);
        }
        const h = hex.join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    }

    /**
     * Encode a `dict` according to a schema. Fields not present in `dict` are
     * marked absent in the bitmask (delta encoding). Returns a Uint8Array
     * suitable for SyncPayload.Data.
     *
     * Numeric types are bit-cast at the encoder (no clamp/round) so quantization
     * tags (Phase 5) can layer in via dedicated type tags rather than overload
     * the integer slots.
     */
    function encode(schema, dict) {
        const fields = schema.fields;
        // First pass: compute output size + which bits are set.
        const bitmask = new Uint8Array(schema.bitmaskBytes);
        const slotPresent = new Array(fields.length);
        let bodySize = 0;
        const utf8Cache = new Array(fields.length); // cache encoded strings to avoid re-encoding

        for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            const v = dict ? dict[f.name] : undefined;
            // `null` is only a valid PRESENT value for explicitly nullable
            // types (encoded as the in-band null-marker byte). For every
            // other type tag we treat `null` like `undefined` (bit clear,
            // no body bytes) — mirroring PositionalSchemaCodec.cs:114-118.
            // Without this, JS would encode {x: null} on an `f64` slot as
            // a PRESENT zero, while C# would drop it as ABSENT — silent
            // wire-format divergence the first time anyone adds an
            // optional numeric field to a schema.
            const isNullableType = (f.type === 'nullable-str' || f.type === 'nullable-guid');
            const present = (dict != null) && (v !== undefined) && (v !== null || isNullableType);
            slotPresent[i] = present;
            if (!present) continue;

            bitmask[i >> 3] |= (1 << (i & 7));

            switch (f.type) {
                case 'f64': bodySize += 8; break;
                case 'f32': bodySize += 4; break;
                case 'u32': case 'i32': bodySize += 4; break;
                case 'u16': case 'i16': bodySize += 2; break;
                case 'u8':  case 'i8':  bodySize += 1; break;
                case 'q16': case 'q16w': case 'q16s': case 'q16_2pi': bodySize += 2; break;
                case 'q8':  bodySize += 1; break;
                case 'bool': bodySize += 1; break;
                case 'guid': bodySize += 16; break;
                case 'nullable-guid':
                    bodySize += 1 + (v == null ? 0 : 16);
                    break;
                case 'str': {
                    const enc = utf8Encode(String(v));
                    utf8Cache[i] = enc;
                    if (enc.length > 0xffff) throw new Error(`str field '${f.name}' exceeds 65535 bytes`);
                    bodySize += 2 + enc.length;
                    break;
                }
                case 'nullable-str': {
                    if (v == null) {
                        bodySize += 1;
                    } else {
                        const enc = utf8Encode(String(v));
                        utf8Cache[i] = enc;
                        if (enc.length > 0xffff) throw new Error(`nullable-str field '${f.name}' exceeds 65535 bytes`);
                        bodySize += 1 + 2 + enc.length;
                    }
                    break;
                }
                case 'bytes': {
                    if (!(v instanceof Uint8Array)) {
                        throw new Error(`bytes field '${f.name}' must be a Uint8Array`);
                    }
                    bodySize += 4 + v.length;
                    break;
                }
                default:
                    throw new Error(`Unknown type tag ${f.type} on field ${f.name}`);
            }
        }

        const out = new Uint8Array(schema.bitmaskBytes + bodySize);
        out.set(bitmask, 0);
        let off = schema.bitmaskBytes;
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

        for (let i = 0; i < fields.length; i++) {
            if (!slotPresent[i]) continue;
            const f = fields[i];
            const v = dict[f.name];
            switch (f.type) {
                case 'f64': view.setFloat64(off, +v, true); off += 8; break;
                case 'f32': view.setFloat32(off, +v, true); off += 4; break;
                case 'u32': view.setUint32(off, v >>> 0, true); off += 4; break;
                case 'i32': view.setInt32(off, v | 0, true); off += 4; break;
                case 'u16': view.setUint16(off, v & 0xffff, true); off += 2; break;
                case 'i16': view.setInt16(off, ((v << 16) >> 16), true); off += 2; break;
                case 'u8':  out[off] = v & 0xff; off += 1; break;
                case 'i8':  view.setInt8(off, ((v << 24) >> 24)); off += 1; break;
                case 'q16': {
                    const q = Math.round(clamp01(+v) * 65535);
                    view.setUint16(off, q, true); off += 2; break;
                }
                case 'q16w': {
                    // Map [-0.5, 1.5] → [0, 65535]. Used for normalized x/y
                    // positions so wrap-extended values (off-screen margin)
                    // don't clamp at the canvas edge.
                    const q = Math.round((clampQ16w(+v) - Q16W_LO) / Q16W_RANGE * 65535);
                    view.setUint16(off, q, true); off += 2; break;
                }
                case 'q16s': {
                    const q = Math.round(clamp11(+v) * 32767);
                    view.setInt16(off, q, true); off += 2; break;
                }
                case 'q16_2pi': {
                    const q = Math.round(wrap2pi(+v) / TWO_PI * 65536) & 0xffff;
                    view.setUint16(off, q, true); off += 2; break;
                }
                case 'q8': {
                    const q = Math.round(clamp01(+v) * 255) & 0xff;
                    out[off] = q; off += 1; break;
                }
                case 'bool': out[off] = v ? 1 : 0; off += 1; break;
                case 'guid': {
                    const bytes = guidStringToBytes(v);
                    out.set(bytes, off);
                    off += 16;
                    break;
                }
                case 'nullable-guid': {
                    if (v == null) { out[off++] = 0; }
                    else { out[off++] = 1; out.set(guidStringToBytes(v), off); off += 16; }
                    break;
                }
                case 'str': {
                    const enc = utf8Cache[i];
                    view.setUint16(off, enc.length, true); off += 2;
                    out.set(enc, off); off += enc.length;
                    break;
                }
                case 'nullable-str': {
                    if (v == null) { out[off++] = 0; }
                    else {
                        out[off++] = 1;
                        const enc = utf8Cache[i];
                        view.setUint16(off, enc.length, true); off += 2;
                        out.set(enc, off); off += enc.length;
                    }
                    break;
                }
                case 'bytes': {
                    view.setUint32(off, v.length, true); off += 4;
                    out.set(v, off); off += v.length;
                    break;
                }
            }
        }

        return out;
    }

    /**
     * Decode positional bytes back to a sparse dict. Slots whose bitmask bit is
     * 0 are simply omitted from the returned dict (the caller's merge step
     * handles "keep prior value"). Throws on truncation / unknown type.
     */
    function decode(schema, bytes) {
        if (!(bytes instanceof Uint8Array)) throw new Error('decode requires Uint8Array');
        if (bytes.length < schema.bitmaskBytes) {
            throw new Error(`positional decode: truncated bitmask (need ${schema.bitmaskBytes}, got ${bytes.length})`);
        }
        const fields = schema.fields;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const out = {};
        let off = schema.bitmaskBytes;

        function need(n, fieldName) {
            if (off + n > bytes.length) {
                throw new Error(`positional decode: truncated at field '${fieldName}' (need ${n} bytes, ${bytes.length - off} remaining)`);
            }
        }

        for (let i = 0; i < fields.length; i++) {
            const present = (bytes[i >> 3] & (1 << (i & 7))) !== 0;
            if (!present) continue;
            const f = fields[i];
            switch (f.type) {
                case 'f64': need(8, f.name); out[f.name] = view.getFloat64(off, true); off += 8; break;
                case 'f32': need(4, f.name); out[f.name] = view.getFloat32(off, true); off += 4; break;
                case 'u32': need(4, f.name); out[f.name] = view.getUint32(off, true); off += 4; break;
                case 'i32': need(4, f.name); out[f.name] = view.getInt32(off, true); off += 4; break;
                case 'u16': need(2, f.name); out[f.name] = view.getUint16(off, true); off += 2; break;
                case 'i16': need(2, f.name); out[f.name] = view.getInt16(off, true); off += 2; break;
                case 'u8':  need(1, f.name); out[f.name] = bytes[off]; off += 1; break;
                case 'i8':  need(1, f.name); out[f.name] = view.getInt8(off); off += 1; break;
                case 'q16': need(2, f.name); out[f.name] = view.getUint16(off, true) / 65535; off += 2; break;
                case 'q16w': need(2, f.name); out[f.name] = view.getUint16(off, true) / 65535 * Q16W_RANGE + Q16W_LO; off += 2; break;
                case 'q16s': need(2, f.name); out[f.name] = view.getInt16(off, true) / 32767; off += 2; break;
                case 'q16_2pi': need(2, f.name); out[f.name] = view.getUint16(off, true) / 65536 * TWO_PI; off += 2; break;
                case 'q8':  need(1, f.name); out[f.name] = bytes[off] / 255; off += 1; break;
                case 'bool': need(1, f.name); out[f.name] = bytes[off] !== 0; off += 1; break;
                case 'guid': need(16, f.name); out[f.name] = bytesToGuidString(bytes, off); off += 16; break;
                case 'nullable-guid': {
                    need(1, f.name);
                    const flag = bytes[off++];
                    if (flag === 0) { out[f.name] = null; }
                    else { need(16, f.name); out[f.name] = bytesToGuidString(bytes, off); off += 16; }
                    break;
                }
                case 'str': {
                    need(2, f.name);
                    const len = view.getUint16(off, true); off += 2;
                    need(len, f.name);
                    out[f.name] = utf8Decode(bytes, off, len);
                    off += len;
                    break;
                }
                case 'nullable-str': {
                    need(1, f.name);
                    const flag = bytes[off++];
                    if (flag === 0) { out[f.name] = null; }
                    else {
                        need(2, f.name);
                        const len = view.getUint16(off, true); off += 2;
                        need(len, f.name);
                        out[f.name] = utf8Decode(bytes, off, len);
                        off += len;
                    }
                    break;
                }
                case 'bytes': {
                    need(4, f.name);
                    const len = view.getUint32(off, true); off += 4;
                    need(len, f.name);
                    out[f.name] = bytes.slice(off, off + len);
                    off += len;
                    break;
                }
                default: throw new Error(`Unknown type tag ${f.type}`);
            }
        }
        return out;
    }

    // ── UTF-8 helpers — kept inline so this module is self-contained ───────
    function utf8Encode(s) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
        const out = [];
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        return new Uint8Array(out);
    }

    function utf8Decode(bytes, offset, length) {
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder().decode(bytes.slice(offset, offset + length));
        }
        let s = '';
        for (let i = 0; i < length;) {
            const b = bytes[offset + i++];
            if (b < 0x80) s += String.fromCharCode(b);
            else if ((b & 0xe0) === 0xc0) {
                const b2 = bytes[offset + i++] & 0x3f;
                s += String.fromCharCode(((b & 0x1f) << 6) | b2);
            } else {
                const b2 = bytes[offset + i++] & 0x3f;
                const b3 = bytes[offset + i++] & 0x3f;
                s += String.fromCharCode(((b & 0x0f) << 12) | (b2 << 6) | b3);
            }
        }
        return s;
    }

    // ── Per-process registry ───────────────────────────────────────────────
    // Keyed by SchemaId. Game registers schemas here at session create / on
    // join (after reading metadata.schemas). Lookup is O(1).
    const _schemas = new Map();

    function register(id, fields) {
        const s = normalizeSchema(id, fields);
        _schemas.set(id, s);
        return s;
    }

    function get(id) {
        return _schemas.get(id) || null;
    }

    /**
     * Replace the registry contents in one shot — used by joiners after
     * reading metadata.schemas. Defensive deep-copy avoids leaking the
     * caller's array references into our normalized form.
     */
    function replaceAll(definitions) {
        _schemas.clear();
        if (!definitions) return;
        for (const def of definitions) {
            const id = def.id ?? def.Id;
            const fields = def.fields ?? def.Fields;
            register(id, fields);
        }
    }

    function clear() { _schemas.clear(); }

    /**
     * Snapshot of all currently-registered schemas in a wire-friendly form
     * for embedding in session metadata. Output: [{id, fields: [[name, type], ...]}, ...]
     */
    function snapshot() {
        const out = [];
        for (const s of _schemas.values()) {
            out.push({ id: s.id, fields: s.fields.map(f => [f.name, f.type]) });
        }
        return out;
    }

    return {
        MAX_FIELDS,
        normalizeSchema,
        encode,
        decode,
        register,
        get,
        replaceAll,
        clear,
        snapshot,
        // Exposed for tests + cross-wire fixtures
        _guidStringToBytes: guidStringToBytes,
        _bytesToGuidString: bytesToGuidString,
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SchemaCodec;
}
if (typeof window !== 'undefined') {
    window.SchemaCodec = SchemaCodec;
}
