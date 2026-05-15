/**
 * Tests for the JS-side positional schema codec (Phase 4 wireopt).
 * Run with: node --test AstervoidsWeb/schema-codec.test.mjs
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SchemaCodec = require('./wwwroot/js/schema-codec.js');

function fresh() {
    SchemaCodec.clear();
}

// ── Schema validation ──────────────────────────────────────────────────────

test('register rejects schema id outside [1, 255]', () => {
    fresh();
    assert.throws(() => SchemaCodec.register(0, [['x', 'f64']]), /must be a byte/);
    assert.throws(() => SchemaCodec.register(256, [['x', 'f64']]), /must be a byte/);
    assert.throws(() => SchemaCodec.register(-1, [['x', 'f64']]), /must be a byte/);
});

test('register rejects unknown type tag', () => {
    fresh();
    assert.throws(() => SchemaCodec.register(1, [['x', 'q42']]), /unknown type tag/);
});

test('register rejects duplicate field names', () => {
    fresh();
    assert.throws(() => SchemaCodec.register(1, [['x', 'f64'], ['x', 'f32']]), /duplicate field/);
});

test('register rejects empty schemas and >32 fields', () => {
    fresh();
    assert.throws(() => SchemaCodec.register(1, []), /non-empty/);
    const tooMany = [];
    for (let i = 0; i < 33; i++) tooMany.push([`f${i}`, 'u8']);
    assert.throws(() => SchemaCodec.register(1, tooMany), /max 32/);
});

// ── Round-trip per type tag ────────────────────────────────────────────────

test('round-trip: f64 / f32 / integer types', () => {
    fresh();
    const schema = SchemaCodec.register(1, [
        ['a', 'f64'], ['b', 'f32'],
        ['c', 'u32'], ['d', 'i32'],
        ['e', 'u16'], ['f', 'i16'],
        ['g', 'u8'], ['h', 'i8'],
    ]);
    const dict = { a: 1.234567890123, b: 1.5, c: 4_000_000_000, d: -2_000_000_000,
                   e: 65000, f: -32000, g: 200, h: -100 };
    const bytes = SchemaCodec.encode(schema, dict);
    const out = SchemaCodec.decode(schema, bytes);
    assert.equal(out.a, 1.234567890123);
    assert.ok(Math.abs(out.b - 1.5) < 1e-6);
    assert.equal(out.c, 4_000_000_000);
    assert.equal(out.d, -2_000_000_000);
    assert.equal(out.e, 65000);
    assert.equal(out.f, -32000);
    assert.equal(out.g, 200);
    assert.equal(out.h, -100);
});

test('round-trip: bool / str / guid', () => {
    fresh();
    const schema = SchemaCodec.register(1, [
        ['flag', 'bool'],
        ['name', 'str'],
        ['id', 'guid'],
    ]);
    const dict = { flag: true, name: 'asteroid', id: '12345678-1234-1234-1234-123456789abc' };
    const out = SchemaCodec.decode(schema, SchemaCodec.encode(schema, dict));
    assert.deepEqual(out, dict);
});

test('round-trip: nullable-str and nullable-guid (null and non-null)', () => {
    fresh();
    const schema = SchemaCodec.register(1, [
        ['ns', 'nullable-str'],
        ['ng', 'nullable-guid'],
    ]);
    const dictNull = { ns: null, ng: null };
    assert.deepEqual(SchemaCodec.decode(schema, SchemaCodec.encode(schema, dictNull)), dictNull);
    const dictSet = { ns: 'hi', ng: '12345678-1234-1234-1234-123456789abc' };
    assert.deepEqual(SchemaCodec.decode(schema, SchemaCodec.encode(schema, dictSet)), dictSet);
});

test('round-trip: bytes', () => {
    fresh();
    const schema = SchemaCodec.register(1, [['blob', 'bytes']]);
    const dict = { blob: new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]) };
    const out = SchemaCodec.decode(schema, SchemaCodec.encode(schema, dict));
    assert.deepEqual(Array.from(out.blob), Array.from(dict.blob));
});

test('round-trip: utf-8 string with multibyte chars', () => {
    fresh();
    const schema = SchemaCodec.register(1, [['n', 'str']]);
    const dict = { n: 'héllo · 世界' };
    const out = SchemaCodec.decode(schema, SchemaCodec.encode(schema, dict));
    assert.equal(out.n, dict.n);
});

// ── Bitmask / delta encoding ───────────────────────────────────────────────

test('delta encoding: omitted fields are absent from output dict', () => {
    fresh();
    const schema = SchemaCodec.register(1, [
        ['x', 'f64'], ['y', 'f64'], ['z', 'f64'],
    ]);
    const partial = { x: 1.5 }; // y and z omitted
    const bytes = SchemaCodec.encode(schema, partial);
    // bitmask byte = 0b00000001
    assert.equal(bytes[0], 0x01);
    // body = 8 bytes for x only
    assert.equal(bytes.length, 1 + 8);
    const out = SchemaCodec.decode(schema, bytes);
    assert.deepEqual(out, { x: 1.5 });
    assert.equal('y' in out, false);
});

test('bitmask spans multiple bytes for >8 fields', () => {
    fresh();
    const fields = [];
    for (let i = 0; i < 12; i++) fields.push([`f${i}`, 'u8']);
    const schema = SchemaCodec.register(1, fields);
    // Set every other field
    const dict = {};
    for (let i = 0; i < 12; i += 2) dict[`f${i}`] = i;
    const bytes = SchemaCodec.encode(schema, dict);
    // bitmaskBytes = 2; bits set: 0,2,4,6,8,10 → 0x55, 0x05
    assert.equal(bytes[0], 0x55);
    assert.equal(bytes[1], 0x05);
    assert.equal(bytes.length, 2 + 6);
    const out = SchemaCodec.decode(schema, bytes);
    for (let i = 0; i < 12; i += 2) assert.equal(out[`f${i}`], i);
    for (let i = 1; i < 12; i += 2) assert.equal(`f${i}` in out, false);
});

test('empty dict produces only the bitmask (all zeros)', () => {
    fresh();
    const schema = SchemaCodec.register(1, [['x', 'f64'], ['y', 'f64']]);
    const bytes = SchemaCodec.encode(schema, {});
    assert.equal(bytes.length, 1);
    assert.equal(bytes[0], 0);
    assert.deepEqual(SchemaCodec.decode(schema, bytes), {});
});

// ── Wire-size validation ───────────────────────────────────────────────────

test('asteroid update {x,y,angle} encodes to 25 bytes (1B mask + 3*8B)', () => {
    fresh();
    const schema = SchemaCodec.register(3, [
        ['x', 'f64'], ['y', 'f64'], ['angle', 'f64'],
        // Imagine more fields could be in the asteroid-update schema, but
        // these 3 are the most common ones. Even if the schema has 8 fields,
        // bitmask is still 1 byte.
        ['velocityX', 'f64'], ['velocityY', 'f64'],
        ['rotationSpeed', 'f64'], ['radius', 'f64'], ['seed', 'u32'],
    ]);
    const bytes = SchemaCodec.encode(schema, { x: 0.5, y: 0.5, angle: 1.0 });
    assert.equal(bytes.length, 1 + 24, 'bitmask 1B + 3 f64 fields');
});

test('asteroid full snapshot {all fields} encodes to ~58 bytes', () => {
    fresh();
    const schema = SchemaCodec.register(4, [
        ['x', 'f64'], ['y', 'f64'], ['radius', 'f64'],
        ['velocityX', 'f64'], ['velocityY', 'f64'],
        ['angle', 'f64'], ['rotationSpeed', 'f64'],
        ['seed', 'u32'], ['vertices', 'bytes'],
    ]);
    const dict = {
        x: 0.5, y: 0.5, radius: 0.05,
        velocityX: 0.1, velocityY: -0.05,
        angle: 1.234, rotationSpeed: 0.02,
        seed: 12345,
        vertices: new Uint8Array(0),
    };
    const bytes = SchemaCodec.encode(schema, dict);
    // bitmask 2B + 7 f64 (56) + u32 (4) + bytes (4 len + 0) = 66 B
    assert.equal(bytes.length, 2 + 56 + 4 + 4);
    const out = SchemaCodec.decode(schema, bytes);
    assert.equal(out.x, 0.5);
    assert.equal(out.seed, 12345);
});

// ── Registry ───────────────────────────────────────────────────────────────

test('registry: get returns null for unknown id', () => {
    fresh();
    assert.equal(SchemaCodec.get(1), null);
});

test('registry: replaceAll resets and re-registers', () => {
    fresh();
    SchemaCodec.register(1, [['x', 'f64']]);
    SchemaCodec.replaceAll([
        { id: 5, fields: [['a', 'u32']] },
        { id: 6, fields: [['b', 'str']] },
    ]);
    assert.equal(SchemaCodec.get(1), null);
    assert.equal(SchemaCodec.get(5).fields[0].name, 'a');
    assert.equal(SchemaCodec.get(6).fields[0].type, 'str');
});

test('snapshot returns [{id, fields}, ...] suitable for session metadata', () => {
    fresh();
    SchemaCodec.register(3, [['x', 'f64'], ['y', 'f64']]);
    SchemaCodec.register(7, [['name', 'str']]);
    const snap = SchemaCodec.snapshot();
    assert.equal(snap.length, 2);
    snap.sort((a, b) => a.id - b.id);
    assert.deepEqual(snap[0], { id: 3, fields: [['x', 'f64'], ['y', 'f64']] });
    assert.deepEqual(snap[1], { id: 7, fields: [['name', 'str']] });
});

// ── GUID byte order ────────────────────────────────────────────────────────

test('guid byte order matches BinaryGuidResolver (LE first 4, then 2, then 2, then BE 8)', () => {
    fresh();
    const schema = SchemaCodec.register(1, [['id', 'guid']]);
    // 00112233-4455-6677-8899-aabbccddeeff
    const dict = { id: '00112233-4455-6677-8899-aabbccddeeff' };
    const bytes = SchemaCodec.encode(schema, dict);
    // Skip 1B bitmask
    const guidBytes = Array.from(bytes.slice(1));
    // C# Guid.ToByteArray order:
    //   33 22 11 00 | 55 44 | 77 66 | 88 99 aa bb cc dd ee ff
    assert.deepEqual(guidBytes, [
        0x33, 0x22, 0x11, 0x00,
        0x55, 0x44,
        0x77, 0x66,
        0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    ]);
    // Round-trips through the string form
    assert.equal(SchemaCodec.decode(schema, bytes).id, dict.id);
});

// ── Truncation safety ──────────────────────────────────────────────────────

test('decode throws on truncated bitmask', () => {
    fresh();
    const schema = SchemaCodec.register(1, [['a', 'f64']]);
    assert.throws(() => SchemaCodec.decode(schema, new Uint8Array(0)), /truncated bitmask/);
});

test('decode throws on truncated body', () => {
    fresh();
    const schema = SchemaCodec.register(1, [['a', 'f64']]);
    // bitmask says field 0 present, but no body bytes follow
    assert.throws(() => SchemaCodec.decode(schema, new Uint8Array([0x01])), /truncated/);
});

// ── Type-coercion edge cases ───────────────────────────────────────────────

test('integer overflow wraps via twos-complement (u8/i16/etc.)', () => {
    fresh();
    const schema = SchemaCodec.register(1, [['u', 'u8'], ['s', 'i16']]);
    const out = SchemaCodec.decode(schema, SchemaCodec.encode(schema, { u: 300, s: -40000 }));
    assert.equal(out.u, 300 & 0xff);          // 44
    assert.equal(out.s, ((-40000 << 16) >> 16)); // -7232 (two's-complement wrap)
});

test('bytes field rejects non-Uint8Array input', () => {
    fresh();
    const schema = SchemaCodec.register(1, [['b', 'bytes']]);
    assert.throws(() => SchemaCodec.encode(schema, { b: [1, 2, 3] }), /must be a Uint8Array/);
});
