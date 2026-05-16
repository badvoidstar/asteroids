// Run with: node --test AstervoidsWeb/msgpack-codec.test.mjs
//
// Unit tests for the minimal MessagePack codec that backs the Phase 3
// SyncPayload envelope. Round-trips the value types the game uses (the
// Hazard L5 mitigation in plan.md). Also asserts byte-exact encodings for
// canonical small fixtures so any wire-shape regression surfaces here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');

function hex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function bytes(...args) { return new Uint8Array(args); }

function roundtrip(v) {
    return MsgpackCodec.decode(MsgpackCodec.encode(v));
}

// ── Primitives ────────────────────────────────────────────────────────────

test('encode/decode null', () => {
    const enc = MsgpackCodec.encode(null);
    assert.equal(hex(enc), 'c0');
    assert.equal(MsgpackCodec.decode(enc), null);
});

test('encode/decode undefined → null', () => {
    const enc = MsgpackCodec.encode(undefined);
    assert.equal(hex(enc), 'c0');
    assert.equal(MsgpackCodec.decode(enc), null);
});

test('encode/decode booleans', () => {
    assert.equal(hex(MsgpackCodec.encode(true)), 'c3');
    assert.equal(hex(MsgpackCodec.encode(false)), 'c2');
    assert.equal(roundtrip(true), true);
    assert.equal(roundtrip(false), false);
});

// ── Integer encoding selection ───────────────────────────────────────────

test('positive fixint (0..127) is 1 byte', () => {
    for (const v of [0, 1, 42, 100, 127]) {
        const enc = MsgpackCodec.encode(v);
        assert.equal(enc.length, 1, `value ${v} should be 1 byte`);
        assert.equal(roundtrip(v), v);
    }
});

test('negative fixint (-32..-1) is 1 byte', () => {
    for (const v of [-1, -16, -32]) {
        const enc = MsgpackCodec.encode(v);
        assert.equal(enc.length, 1, `value ${v} should be 1 byte`);
        assert.equal(roundtrip(v), v);
    }
});

test('uint 8 / uint 16 / uint 32 selection', () => {
    assert.equal(hex(MsgpackCodec.encode(128)), 'cc80');
    assert.equal(hex(MsgpackCodec.encode(255)), 'ccff');
    assert.equal(hex(MsgpackCodec.encode(256)), 'cd0100');
    assert.equal(hex(MsgpackCodec.encode(65535)), 'cdffff');
    assert.equal(hex(MsgpackCodec.encode(65536)), 'ce00010000');
    assert.equal(hex(MsgpackCodec.encode(0xffffffff)), 'ceffffffff');
    for (const v of [128, 255, 256, 65535, 65536, 0xffffffff]) {
        assert.equal(roundtrip(v), v);
    }
});

test('int 8 / int 16 / int 32 selection for negatives', () => {
    assert.equal(hex(MsgpackCodec.encode(-33)), 'd0df');
    assert.equal(hex(MsgpackCodec.encode(-128)), 'd080');
    assert.equal(hex(MsgpackCodec.encode(-129)), 'd1ff7f');
    assert.equal(hex(MsgpackCodec.encode(-32768)), 'd18000');
    assert.equal(hex(MsgpackCodec.encode(-32769)), 'd2ffff7fff');
    for (const v of [-33, -128, -129, -32768, -32769, -100000]) {
        assert.equal(roundtrip(v), v);
    }
});

test('large positive integer uses uint64', () => {
    const v = 1_700_000_000_123; // typical timestamp
    const enc = MsgpackCodec.encode(v);
    assert.equal(enc[0], 0xcf, 'expected uint64 tag');
    assert.equal(enc.length, 9);
    assert.equal(roundtrip(v), v);
});

test('large negative integer uses int64', () => {
    const v = -10_000_000_000;
    const enc = MsgpackCodec.encode(v);
    assert.equal(enc[0], 0xd3, 'expected int64 tag');
    assert.equal(enc.length, 9);
    assert.equal(roundtrip(v), v);
});

// ── Floats ────────────────────────────────────────────────────────────────

test('non-integer numbers encode as float64', () => {
    const v = 0.5;
    const enc = MsgpackCodec.encode(v);
    assert.equal(enc[0], 0xcb, 'expected float64 tag');
    assert.equal(enc.length, 9);
    assert.equal(roundtrip(v), v);
});

test('NaN and Infinity round-trip as float64', () => {
    assert.equal(Number.isNaN(roundtrip(NaN)), true);
    assert.equal(roundtrip(Infinity), Infinity);
    assert.equal(roundtrip(-Infinity), -Infinity);
});

test('decoder accepts float32 from C# (smoke)', () => {
    // Manually craft a float32 0.5 (0x3f000000)
    const enc = bytes(0xca, 0x3f, 0x00, 0x00, 0x00);
    assert.equal(MsgpackCodec.decode(enc), 0.5);
});

// ── Strings ───────────────────────────────────────────────────────────────

test('fixstr (< 32 bytes)', () => {
    const enc = MsgpackCodec.encode('hello');
    assert.equal(hex(enc), 'a568656c6c6f'); // 0xa5 + 'hello'
    assert.equal(roundtrip('hello'), 'hello');
});

test('str8 / str16 selection', () => {
    const s40 = 'a'.repeat(40);
    const enc8 = MsgpackCodec.encode(s40);
    assert.equal(enc8[0], 0xd9);
    assert.equal(enc8[1], 40);
    assert.equal(roundtrip(s40), s40);

    const s300 = 'b'.repeat(300);
    const enc16 = MsgpackCodec.encode(s300);
    assert.equal(enc16[0], 0xda);
    assert.equal(roundtrip(s300), s300);
});

test('utf-8 multibyte strings round-trip', () => {
    const s = 'café 🚀 banana';
    assert.equal(roundtrip(s), s);
});

test('GUID-string field round-trips', () => {
    const g = 'abcdef01-2345-6789-abcd-ef0123456789';
    const enc = MsgpackCodec.encode(g);
    // 36 chars -> 36 bytes UTF-8 -> str8 (length > 31)
    assert.equal(enc[0], 0xd9);
    assert.equal(roundtrip(g), g);
});

// ── Binary ────────────────────────────────────────────────────────────────

test('bin8 round-trip', () => {
    const v = new Uint8Array([1, 2, 3, 4, 5]);
    const dec = roundtrip(v);
    assert.ok(dec instanceof Uint8Array);
    assert.deepEqual(Array.from(dec), [1, 2, 3, 4, 5]);
});

// ── Arrays ────────────────────────────────────────────────────────────────

test('fixarray of numbers', () => {
    const v = [1, 2, 3];
    assert.deepEqual(roundtrip(v), v);
});

test('nested array of arrays (vertices pattern)', () => {
    const v = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
    const dec = roundtrip(v);
    assert.deepEqual(dec, v);
});

test('array16 (length > 15)', () => {
    const v = Array.from({ length: 30 }, (_, i) => i);
    const enc = MsgpackCodec.encode(v);
    assert.equal(enc[0], 0xdc);
    assert.deepEqual(roundtrip(v), v);
});

// ── Maps (string-keyed objects) ───────────────────────────────────────────

test('fixmap with string keys', () => {
    const v = { x: 0.5, y: 0.25 };
    assert.deepEqual(roundtrip(v), v);
});

test('mixed value types in a map', () => {
    const v = {
        x: 0.5, y: 0.25,
        score: 100,
        thrusting: true,
        invulnerable: false,
        pendingHit: false,
        memberId: 'abcdef01-2345-6789-abcd-ef0123456789',
        hitTargetId: null,
        seed: 12345
    };
    assert.deepEqual(roundtrip(v), v);
});

test('nested map (game payload pattern)', () => {
    const v = {
        type: 1,
        x: 0.5,
        y: 0.5,
        radius: 0.05,
        velocityX: 0.1,
        velocityY: -0.05,
        vertices: [[0.0, 0.05], [0.05, 0.0], [0.0, -0.05], [-0.05, 0.0]]
    };
    assert.deepEqual(roundtrip(v), v);
});

test('map16 (> 15 keys)', () => {
    const v = {};
    for (let i = 0; i < 20; i++) v['k' + i] = i;
    const enc = MsgpackCodec.encode(v);
    assert.equal(enc[0], 0xde);
    assert.deepEqual(roundtrip(v), v);
});

test('decoder rejects non-string map keys', () => {
    // map of 1 entry: int 1 → string "x"
    const enc = bytes(0x81, 0x01, 0xa1, 0x78);
    assert.throws(() => MsgpackCodec.decode(enc), /non-string map key/);
});

test('encoder rejects unsupported types (Function)', () => {
    assert.throws(() => MsgpackCodec.encode(() => 1), /unsupported value type/);
});

// ── Decoder accepts encodings the C# side may emit ───────────────────────

test('decoder accepts uint64 and int64 directly', () => {
    // uint64 value 65536 (would normally be uint16/32) — test the decoder path
    const enc = bytes(0xcf, 0, 0, 0, 0, 0, 1, 0, 0);
    assert.equal(MsgpackCodec.decode(enc), 65536);

    // int64 value -1
    const enc2 = bytes(0xd3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
    assert.equal(MsgpackCodec.decode(enc2), -1);
});

// ── Trailing bytes detection ─────────────────────────────────────────────

test('decode rejects trailing bytes', () => {
    const enc = bytes(0xc0, 0xc0); // two nils back-to-back
    assert.throws(() => MsgpackCodec.decode(enc), /trailing bytes/);
});

// ── Realistic game-data round-trip ────────────────────────────────────────

test('asteroid full-create payload round-trip', () => {
    const v = {
        type: 'asteroid',
        x: 0.5, y: 0.5,
        radius: 0.05,
        velocityX: 0.1,
        velocityY: -0.05,
        angle: 1.234,
        rotationSpeed: 0.02,
        seed: 12345
    };
    const dec = roundtrip(v);
    assert.deepEqual(dec, v);
    // Sanity on size: between 100-200 bytes (9 fields, mostly float64)
    const sz = MsgpackCodec.encode(v).length;
    assert.ok(sz > 100 && sz < 200, `expected 100-200 bytes, got ${sz}`);
});

test('ship per-frame update round-trip', () => {
    const v = {
        x: 0.523, y: 0.412,
        angle: 1.234,
        velocityX: 0.05,
        velocityY: -0.03,
        rotationSpeed: 0.01,
        thrusting: true,
        invulnerable: false
    };
    assert.deepEqual(roundtrip(v), v);
});

test('bullet full sync payload (with pendingHit) round-trip', () => {
    const v = {
        type: 'bullet',
        x: 0.523, y: 0.412,
        velocityX: 0.5, velocityY: 0.0,
        lifetime: 0.8,
        colorIndex: 2,
        ownerMemberId: 'abcdef01-2345-6789-abcd-ef0123456789',
        pendingHit: true,
        hitTargetId: '11111111-2222-3333-4444-555555555555',
        hitImpactTorque: 0.05,
        hitBulletAngle: 1.57,
        hitOffsetN: 0.3
    };
    assert.deepEqual(roundtrip(v), v);
});
