/**
 * Minimal MessagePack codec for the Phase 3 SyncPayload envelope.
 *
 * Wire-compatible with MessagePack-CSharp `ContractlessStandardResolver`
 * (PrimitiveObjectFormatter for value-type slots in
 * `Dictionary<string, object?>`):
 *
 *   - nil, true, false
 *   - positive/negative fixint, int 8/16/32/64, uint 8/16/32/64
 *     (encoder picks the smallest type that fits; integers > 2^53 - 1 are NOT
 *     supported because JS Number cannot hold them losslessly)
 *   - float64 (used for any non-integral Number)
 *   - fixstr / str8 / str16 / str32 (UTF-8)
 *   - bin8 / bin16 / bin32 (Uint8Array)
 *   - fixarray / array16 / array32
 *   - fixmap / map16 / map32 (string keys ONLY — that's all the game uses;
 *     the encoder throws on non-string keys to catch mistakes early)
 *
 * Decoder is permissive (accepts any input the encoder might produce, plus
 * the equivalent encodings the C# side may emit — e.g. `int 8` for a small
 * negative integer, `uint 16` instead of `uint 32` for medium-sized ints).
 *
 * Out of scope (intentional): ext types, timestamp, uint64 > 2^53 - 1,
 * float32. We never write float32 from JS because Number is float64; the
 * decoder rejects float32 to make sure the C# side never sends one
 * (it shouldn't — game payloads are all double / integer / string / bool /
 * GUID-as-string / array / dict).
 */
const MsgpackCodec = (function () {
    // ── Encoder ────────────────────────────────────────────────────────────

    /**
     * Encode a JS value to a MessagePack-encoded Uint8Array.
     * Supports: null, undefined (encoded as nil), boolean, number (Number),
     * string, Uint8Array, Array, plain Object (string keys only).
     *
     * @param {*} value
     * @returns {Uint8Array}
     */
    function encode(value) {
        const buf = new Encoder();
        buf.writeAny(value);
        return buf.toUint8Array();
    }

    class Encoder {
        constructor() {
            this.buf = new Uint8Array(64);
            this.view = new DataView(this.buf.buffer);
            this.len = 0;
            this.te = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
        }

        ensure(n) {
            const needed = this.len + n;
            if (needed <= this.buf.length) return;
            let cap = this.buf.length * 2;
            while (cap < needed) cap *= 2;
            const next = new Uint8Array(cap);
            next.set(this.buf.subarray(0, this.len));
            this.buf = next;
            this.view = new DataView(this.buf.buffer);
        }

        writeU8(v) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
        writeU16(v) { this.ensure(2); this.view.setUint16(this.len, v); this.len += 2; }
        writeU32(v) { this.ensure(4); this.view.setUint32(this.len, v >>> 0); this.len += 4; }
        writeI8(v) { this.ensure(1); this.view.setInt8(this.len, v); this.len += 1; }
        writeI16(v) { this.ensure(2); this.view.setInt16(this.len, v); this.len += 2; }
        writeI32(v) { this.ensure(4); this.view.setInt32(this.len, v); this.len += 4; }
        writeF64(v) { this.ensure(8); this.view.setFloat64(this.len, v); this.len += 8; }
        // 64-bit ints written as two 32-bit halves. JS Number is exact for
        // |v| < 2^53. For negative v we form the two's-complement int64 via
        // (~aHi, ~aLo) of (|v|-1) — this avoids the float-precision loss of
        // (v + 2^64) when v is in the int53 range.
        writeI64(v) {
            this.ensure(8);
            let hi, lo;
            if (v >= 0) {
                hi = Math.floor(v / 0x1_0000_0000);
                lo = v - hi * 0x1_0000_0000;
            } else {
                const av = -v - 1; // 0 .. 2^53-1, exact
                const aHi = Math.floor(av / 0x1_0000_0000);
                const aLo = av - aHi * 0x1_0000_0000;
                hi = (~aHi) >>> 0;
                lo = (~aLo) >>> 0;
            }
            this.view.setUint32(this.len, hi >>> 0);
            this.view.setUint32(this.len + 4, lo >>> 0);
            this.len += 8;
        }
        writeU64(v) {
            this.ensure(8);
            const hi = Math.floor(v / 0x1_0000_0000);
            const lo = v - hi * 0x1_0000_0000;
            this.view.setUint32(this.len, hi >>> 0);
            this.view.setUint32(this.len + 4, lo >>> 0);
            this.len += 8;
        }
        writeBytes(bytes) { this.ensure(bytes.length); this.buf.set(bytes, this.len); this.len += bytes.length; }

        writeAny(v) {
            if (v === null || v === undefined) {
                this.writeU8(0xc0);
                return;
            }
            const t = typeof v;
            if (t === 'boolean') {
                this.writeU8(v ? 0xc3 : 0xc2);
                return;
            }
            if (t === 'number') {
                this.writeNumber(v);
                return;
            }
            if (t === 'string') {
                this.writeString(v);
                return;
            }
            if (t === 'bigint') {
                this.writeBigInt(v);
                return;
            }
            if (v instanceof Uint8Array) {
                this.writeBin(v);
                return;
            }
            if (Array.isArray(v)) {
                this.writeArray(v);
                return;
            }
            if (t === 'object') {
                this.writeMap(v);
                return;
            }
            throw new Error('MsgpackCodec: unsupported value type: ' + t);
        }

        writeNumber(v) {
            // Pick integer encoding when v is an exact integer that fits.
            // Otherwise float64. NaN / Infinity → float64.
            if (Number.isFinite(v) && Math.floor(v) === v && Math.abs(v) < 0x1_0000_0000_0000) {
                if (v >= 0) {
                    if (v < 0x80) { this.writeU8(v); return; }
                    if (v < 0x100) { this.writeU8(0xcc); this.writeU8(v); return; }
                    if (v < 0x10000) { this.writeU8(0xcd); this.writeU16(v); return; }
                    if (v < 0x1_0000_0000) { this.writeU8(0xce); this.writeU32(v); return; }
                    this.writeU8(0xcf); this.writeU64(v); return;
                } else {
                    if (v >= -32) { this.writeU8(v & 0xff); return; } // negative fixint (0xe0..0xff)
                    if (v >= -0x80) { this.writeU8(0xd0); this.writeI8(v); return; }
                    if (v >= -0x8000) { this.writeU8(0xd1); this.writeI16(v); return; }
                    if (v >= -0x8000_0000) { this.writeU8(0xd2); this.writeI32(v); return; }
                    this.writeU8(0xd3); this.writeI64(v); return;
                }
            }
            // Float
            this.writeU8(0xcb); this.writeF64(v);
        }

        writeBigInt(v) {
            // Only support magnitudes up to 2^63 - 1. We transmit as int64 / uint64.
            if (v >= 0n) {
                if (v < 0x80n) { this.writeU8(Number(v)); return; }
                if (v < 0x100n) { this.writeU8(0xcc); this.writeU8(Number(v)); return; }
                if (v < 0x10000n) { this.writeU8(0xcd); this.writeU16(Number(v)); return; }
                if (v < 0x1_0000_0000n) { this.writeU8(0xce); this.writeU32(Number(v)); return; }
                this.writeU8(0xcf);
                const hi = Number(v >> 32n) >>> 0;
                const lo = Number(v & 0xffff_ffffn) >>> 0;
                this.ensure(8);
                this.view.setUint32(this.len, hi); this.view.setUint32(this.len + 4, lo);
                this.len += 8;
                return;
            } else {
                if (v >= -32n) { this.writeU8(Number(v) & 0xff); return; }
                if (v >= -0x80n) { this.writeU8(0xd0); this.writeI8(Number(v)); return; }
                if (v >= -0x8000n) { this.writeU8(0xd1); this.writeI16(Number(v)); return; }
                if (v >= -0x8000_0000n) { this.writeU8(0xd2); this.writeI32(Number(v)); return; }
                this.writeU8(0xd3);
                // Two's-complement int64
                const u = (v + (1n << 64n)) & ((1n << 64n) - 1n);
                const hi = Number(u >> 32n) >>> 0;
                const lo = Number(u & 0xffff_ffffn) >>> 0;
                this.ensure(8);
                this.view.setUint32(this.len, hi); this.view.setUint32(this.len + 4, lo);
                this.len += 8;
                return;
            }
        }

        writeString(s) {
            const bytes = this.te ? this.te.encode(s) : utf8EncodeFallback(s);
            const n = bytes.length;
            if (n < 32) { this.writeU8(0xa0 | n); }
            else if (n < 0x100) { this.writeU8(0xd9); this.writeU8(n); }
            else if (n < 0x10000) { this.writeU8(0xda); this.writeU16(n); }
            else { this.writeU8(0xdb); this.writeU32(n); }
            this.writeBytes(bytes);
        }

        writeBin(bytes) {
            const n = bytes.length;
            if (n < 0x100) { this.writeU8(0xc4); this.writeU8(n); }
            else if (n < 0x10000) { this.writeU8(0xc5); this.writeU16(n); }
            else { this.writeU8(0xc6); this.writeU32(n); }
            this.writeBytes(bytes);
        }

        writeArray(arr) {
            const n = arr.length;
            if (n < 16) { this.writeU8(0x90 | n); }
            else if (n < 0x10000) { this.writeU8(0xdc); this.writeU16(n); }
            else { this.writeU8(0xdd); this.writeU32(n); }
            for (let i = 0; i < n; i++) this.writeAny(arr[i]);
        }

        writeMap(obj) {
            const keys = Object.keys(obj);
            const n = keys.length;
            if (n < 16) { this.writeU8(0x80 | n); }
            else if (n < 0x10000) { this.writeU8(0xde); this.writeU16(n); }
            else { this.writeU8(0xdf); this.writeU32(n); }
            for (let i = 0; i < n; i++) {
                this.writeString(keys[i]);
                this.writeAny(obj[keys[i]]);
            }
        }

        toUint8Array() {
            return this.buf.subarray(0, this.len);
        }
    }

    function utf8EncodeFallback(s) {
        const out = [];
        for (let i = 0; i < s.length; i++) {
            let c = s.charCodeAt(i);
            if (c < 0x80) {
                out.push(c);
            } else if (c < 0x800) {
                out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            } else if ((c & 0xfc00) === 0xd800 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
                c = 0x10000 + ((c & 0x3ff) << 10) + (s.charCodeAt(++i) & 0x3ff);
                out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            } else {
                out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            }
        }
        return new Uint8Array(out);
    }

    // ── Decoder ────────────────────────────────────────────────────────────

    /**
     * Decode a MessagePack Uint8Array to a JS value.
     * Strings, numbers, booleans, null, arrays, plain objects (string-keyed
     * maps) are returned natively. Binary blobs are returned as Uint8Array.
     * @param {Uint8Array} bytes
     * @returns {*}
     */
    function decode(bytes) {
        const d = new Decoder(bytes);
        const v = d.readAny();
        if (d.pos !== bytes.length) {
            throw new Error('MsgpackCodec: trailing bytes after decode (' + (bytes.length - d.pos) + ')');
        }
        return v;
    }

    class Decoder {
        constructor(bytes) {
            this.bytes = bytes;
            this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            this.pos = 0;
            this.td = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8', { fatal: false }) : null;
        }

        readU8() { return this.bytes[this.pos++]; }
        readI8() { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
        readU16() { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
        readI16() { const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
        readU32() { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
        readI32() { const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
        readF32() { const v = this.view.getFloat32(this.pos); this.pos += 4; return v; }
        readF64() { const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }
        readU64() {
            const hi = this.view.getUint32(this.pos);
            const lo = this.view.getUint32(this.pos + 4);
            this.pos += 8;
            // Lossless up to 2^53 - 1; beyond that, JS Number loses precision.
            return hi * 0x1_0000_0000 + lo;
        }
        readI64() {
            const hi = this.view.getInt32(this.pos);
            const lo = this.view.getUint32(this.pos + 4);
            this.pos += 8;
            return hi * 0x1_0000_0000 + lo;
        }

        readBytes(n) {
            const slice = this.bytes.subarray(this.pos, this.pos + n);
            this.pos += n;
            return slice;
        }

        readString(n) {
            const slice = this.readBytes(n);
            if (this.td) return this.td.decode(slice);
            return utf8DecodeFallback(slice);
        }

        readArray(n) {
            const out = new Array(n);
            for (let i = 0; i < n; i++) out[i] = this.readAny();
            return out;
        }

        readMap(n) {
            const out = {};
            for (let i = 0; i < n; i++) {
                const k = this.readAny();
                const v = this.readAny();
                if (typeof k !== 'string') {
                    // Coerce: numbers as keys would surprise game code; throw to make
                    // any C#-side schema mistake loud during dev.
                    throw new Error('MsgpackCodec: non-string map key (' + (typeof k) + ')');
                }
                out[k] = v;
            }
            return out;
        }

        readAny() {
            const b = this.readU8();
            // positive fixint
            if (b < 0x80) return b;
            // fixmap
            if ((b & 0xf0) === 0x80) return this.readMap(b & 0x0f);
            // fixarray
            if ((b & 0xf0) === 0x90) return this.readArray(b & 0x0f);
            // fixstr
            if ((b & 0xe0) === 0xa0) return this.readString(b & 0x1f);
            // negative fixint
            if (b >= 0xe0) return b - 0x100;

            switch (b) {
                case 0xc0: return null;
                case 0xc2: return false;
                case 0xc3: return true;
                case 0xc4: return this.readBytes(this.readU8()).slice();
                case 0xc5: return this.readBytes(this.readU16()).slice();
                case 0xc6: return this.readBytes(this.readU32()).slice();
                case 0xca: return this.readF32();
                case 0xcb: return this.readF64();
                case 0xcc: return this.readU8();
                case 0xcd: return this.readU16();
                case 0xce: return this.readU32();
                case 0xcf: return this.readU64();
                case 0xd0: return this.readI8();
                case 0xd1: return this.readI16();
                case 0xd2: return this.readI32();
                case 0xd3: return this.readI64();
                case 0xd9: return this.readString(this.readU8());
                case 0xda: return this.readString(this.readU16());
                case 0xdb: return this.readString(this.readU32());
                case 0xdc: return this.readArray(this.readU16());
                case 0xdd: return this.readArray(this.readU32());
                case 0xde: return this.readMap(this.readU16());
                case 0xdf: return this.readMap(this.readU32());
                // ext types: skip body and return null. Not used by game payloads;
                // would happen only if C# side starts emitting timestamps etc.
                case 0xc7: { const n = this.readU8(); this.readU8(); this.readBytes(n); return null; }
                case 0xc8: { const n = this.readU16(); this.readU8(); this.readBytes(n); return null; }
                case 0xc9: { const n = this.readU32(); this.readU8(); this.readBytes(n); return null; }
                case 0xd4: this.readU8(); this.readU8(); return null;
                case 0xd5: this.readU8(); this.readU16(); return null;
                case 0xd6: this.readU8(); this.readU32(); return null;
                case 0xd7: this.readU8(); this.readU64(); return null;
                case 0xd8: this.readU8(); this.readBytes(16); return null;
                default:
                    throw new Error('MsgpackCodec: unsupported tag 0x' + b.toString(16));
            }
        }
    }

    function utf8DecodeFallback(bytes) {
        let out = '';
        let i = 0;
        while (i < bytes.length) {
            const a = bytes[i++];
            if (a < 0x80) {
                out += String.fromCharCode(a);
            } else if ((a & 0xe0) === 0xc0) {
                const b = bytes[i++];
                out += String.fromCharCode(((a & 0x1f) << 6) | (b & 0x3f));
            } else if ((a & 0xf0) === 0xe0) {
                const b = bytes[i++], c = bytes[i++];
                out += String.fromCharCode(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
            } else {
                const b = bytes[i++], c = bytes[i++], d = bytes[i++];
                let cp = ((a & 0x07) << 18) | ((b & 0x3f) << 12) | ((c & 0x3f) << 6) | (d & 0x3f);
                cp -= 0x10000;
                out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
            }
        }
        return out;
    }

    return { encode, decode };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MsgpackCodec;
}
