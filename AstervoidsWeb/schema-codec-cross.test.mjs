// Phase 4 cross-wire fixtures (JS side). Decode hex strings produced by C#
// PositionalSchemaCodec and assert the JS SchemaCodec returns the same dicts.
// If either codec changes, both sides fail loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SchemaCodec = require('./wwwroot/js/schema-codec.js');

function hexToBytes(hex) {
    if (hex.length % 2 !== 0) throw new Error(`odd hex length: ${hex.length}`);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function freshRegistry() {
    SchemaCodec.clear();
}

test('cross-wire: asteroid update — all fields', () => {
    freshRegistry();
    const schema = SchemaCodec.register(3, [['x', 'f64'], ['y', 'f64'], ['angle', 'f64']]);
    const bytes = hexToBytes(
        '07' +
        '000000000000e03f' +
        '000000000000d03f' +
        '182d4454fb21f93f'
    );
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.x, 0.5);
    assert.equal(decoded.y, 0.25);
    assert.ok(Math.abs(decoded.angle - Math.PI / 2) < 1e-12);
});

test('cross-wire: asteroid update — only angle bit set', () => {
    freshRegistry();
    const schema = SchemaCodec.register(3, [['x', 'f64'], ['y', 'f64'], ['angle', 'f64']]);
    const bytes = hexToBytes('04' + '0000000000000000');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal('x' in decoded, false);
    assert.equal('y' in decoded, false);
    assert.equal(decoded.angle, 0.0);
});

test('cross-wire: ship update — mixed types', () => {
    freshRegistry();
    const schema = SchemaCodec.register(1, [
        ['x', 'f64'], ['y', 'f64'], ['angle', 'f64'],
        ['velocityX', 'f64'], ['velocityY', 'f64'],
        ['rotationSpeed', 'f64'],
        ['thrusting', 'bool'],
        ['invulnerable', 'bool'],
    ]);
    const bytes = hexToBytes(
        'ff' +
        '000000000000e03f' +
        '000000000000e03f' +
        '0000000000000000' +
        '0000000000000000' +
        '0000000000000000' +
        '0000000000000000' +
        '00' +
        '01'
    );
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.x, 0.5);
    assert.equal(decoded.y, 0.5);
    assert.equal(decoded.angle, 0);
    assert.equal(decoded.velocityX, 0);
    assert.equal(decoded.velocityY, 0);
    assert.equal(decoded.rotationSpeed, 0);
    assert.equal(decoded.thrusting, false);
    assert.equal(decoded.invulnerable, true);
});

test('cross-wire: bullet update — guid field', () => {
    freshRegistry();
    const schema = SchemaCodec.register(5, [
        ['x', 'f64'], ['y', 'f64'],
        ['ownerMemberId', 'guid'],
    ]);
    const bytes = hexToBytes(
        '07' +
        '9a9999999999b93f' +
        '9a9999999999c93f' +
        '443322116655887799aabbccddeeff00'
    );
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.ok(Math.abs(decoded.x - 0.1) < 1e-12);
    assert.ok(Math.abs(decoded.y - 0.2) < 1e-12);
    assert.equal(decoded.ownerMemberId.toLowerCase(), '11223344-5566-7788-99aa-bbccddeeff00');
});

test('cross-wire: string field with utf8 length prefix', () => {
    freshRegistry();
    const schema = SchemaCodec.register(7, [['name', 'str']]);
    const bytes = hexToBytes('01' + '0400' + '73686970');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.name, 'ship');
});

test('cross-wire: nullable-guid null case is single zero byte', () => {
    freshRegistry();
    const schema = SchemaCodec.register(8, [['hitTargetId', 'nullable-guid']]);
    const bytes = hexToBytes('01' + '00');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.hitTargetId, null);
});

test('cross-wire: bytes field length is u32 little-endian', () => {
    freshRegistry();
    const schema = SchemaCodec.register(9, [['vertices', 'bytes']]);
    const bytes = hexToBytes('01' + '04000000' + 'deadbeef');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.vertices.length, 4);
    assert.equal(decoded.vertices[0], 0xde);
    assert.equal(decoded.vertices[1], 0xad);
    assert.equal(decoded.vertices[2], 0xbe);
    assert.equal(decoded.vertices[3], 0xef);
});

test('cross-wire: JS encode → C# hex round-trip (asteroid update)', () => {
    freshRegistry();
    const schema = SchemaCodec.register(3, [['x', 'f64'], ['y', 'f64'], ['angle', 'f64']]);
    const bytes = SchemaCodec.encode(schema, { x: 0.5, y: 0.25, angle: Math.PI / 2 });
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    assert.equal(hex,
        '07' +
        '000000000000e03f' +
        '000000000000d03f' +
        '182d4454fb21f93f'
    );
});

test('cross-wire (Phase 5): quantized asteroid update produces canonical hex', () => {
    freshRegistry();
    const schema = SchemaCodec.register(3, [['x', 'q16'], ['y', 'q16'], ['angle', 'q16_2pi']]);
    const bytes = SchemaCodec.encode(schema, { x: 0.5, y: 0.25, angle: Math.PI });
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    // bitmask=0x07 + x=Math.round(0.5*65535)=32768→0x8000 (LE 0080)
    //              + y=Math.round(0.25*65535)=16384→0x4000 (LE 0040)
    //              + angle=π→65536/2=32768→0x8000 (LE 0080)
    assert.equal(hex, '07008000400080');
});

// PR #96 review fix #4 cross-wire parity.
// PositionalSchemaCodecTests.Encode_NullValueOnNonNullableSlot_TreatedAsAbsent
// asserts the C# encoder produces the same bytes for the same dict. This
// test pins the JS encoder to the same canonical hex so the two codecs
// stay byte-identical on the `null` boundary.
test('cross-wire: null on non-nullable f64 slot is absent (matches C# bytes)', () => {
    freshRegistry();
    const schema = SchemaCodec.register(11, [['x', 'f64'], ['y', 'f64']]);
    const bytes = SchemaCodec.encode(schema, { x: 1.0, y: null });
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    // bitmask=0x01 (only x) + x=1.0 (IEEE-754 LE: 0x000000000000F03F)
    assert.equal(hex, '01' + '000000000000f03f');
});
