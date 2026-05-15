// Phase 5 wireopt — round-trip + tolerance + edge tests for the new
// quantized type tags (q16, q16s, q16_2pi, q8) on the JS schema codec.
// Mirrored on the C# side by PositionalSchemaCodecQuantizeTests.cs.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SchemaCodec = require('./wwwroot/js/schema-codec.js');

const TWO_PI = Math.PI * 2;

function fresh(id, fields) {
    SchemaCodec.clear();
    return SchemaCodec.register(id, fields);
}

test('q16 roundtrip at 0, 0.5, 1', () => {
    const s = fresh(1, [['v', 'q16']]);
    for (const v of [0, 0.5, 1]) {
        const out = SchemaCodec.decode(s, SchemaCodec.encode(s, { v }));
        assert.ok(Math.abs(out.v - v) < 2 / 65535, `expected ~${v}, got ${out.v}`);
    }
});

test('q16 wire size: bitmask(1) + 2 = 3 bytes', () => {
    const s = fresh(1, [['v', 'q16']]);
    assert.strictEqual(SchemaCodec.encode(s, { v: 0.5 }).length, 3);
});

test('q16 clamps out-of-range values', () => {
    const s = fresh(1, [['v', 'q16']]);
    const hi = SchemaCodec.decode(s, SchemaCodec.encode(s, { v: 2.5 }));
    assert.strictEqual(hi.v, 1);
    const lo = SchemaCodec.decode(s, SchemaCodec.encode(s, { v: -0.3 }));
    assert.strictEqual(lo.v, 0);
});

// ── q16w (wrap-extended position) ────────────────────────────────────────
// q16w covers [-0.5, 1.5] so off-screen wrap-margin positions used by
// wrapNormalized survive the wire intact. Plain q16 [0,1] would clamp them
// at the edge and freeze remote asteroids/ships during wrap excursions.

test('q16w roundtrip across wrap-extended range [-0.5, 1.5]', () => {
    const s = fresh(1, [['v', 'q16w']]);
    // 2.0 / 65535 ≈ 3.05e-5 per unit; allow 2× quantization step for tolerance.
    const tol = 2 * 2 / 65535;
    for (const v of [-0.5, -0.1, 0, 0.5, 1, 1.1, 1.5]) {
        const out = SchemaCodec.decode(s, SchemaCodec.encode(s, { v }));
        assert.ok(Math.abs(out.v - v) < tol, `expected ~${v}, got ${out.v}`);
    }
});

test('q16w wire size: bitmask(1) + 2 = 3 bytes', () => {
    const s = fresh(1, [['v', 'q16w']]);
    assert.strictEqual(SchemaCodec.encode(s, { v: 0.5 }).length, 3);
});

test('q16w clamps out-of-range values to ±extended bound', () => {
    const s = fresh(1, [['v', 'q16w']]);
    assert.strictEqual(SchemaCodec.decode(s, SchemaCodec.encode(s, { v: 5 })).v, 1.5);
    assert.strictEqual(SchemaCodec.decode(s, SchemaCodec.encode(s, { v: -5 })).v, -0.5);
});

test('q16w preserves wrap-extension positions that q16 would clamp', () => {
    // Concrete regression: an asteroid (radius ≈ 0.083) sliding off the
    // right edge passes through x ≈ 1.05 before wrapping. q16 clamps to
    // 1.0 (frozen at the edge); q16w must preserve it.
    SchemaCodec.clear();
    const sQ16  = SchemaCodec.register(1, [['x', 'q16']]);
    const sQ16w = SchemaCodec.register(2, [['x', 'q16w']]);
    const backQ16  = SchemaCodec.decode(sQ16,  SchemaCodec.encode(sQ16,  { x: 1.05 })).x;
    const backQ16w = SchemaCodec.decode(sQ16w, SchemaCodec.encode(sQ16w, { x: 1.05 })).x;
    assert.strictEqual(backQ16, 1, 'q16 demonstrably clamps at 1 — this is the bug q16w fixes');
    assert.ok(Math.abs(backQ16w - 1.05) < 2 * 2 / 65535, `q16w must preserve 1.05; got ${backQ16w}`);
});

test('q16s roundtrip across [-1, 1]', () => {
    const s = fresh(1, [['v', 'q16s']]);
    for (const v of [-1, -0.5, 0, 0.5, 1, 0.123456]) {
        const out = SchemaCodec.decode(s, SchemaCodec.encode(s, { v }));
        assert.ok(Math.abs(out.v - v) < 2 / 32767, `expected ~${v}, got ${out.v}`);
    }
});

test('q16s wire size: bitmask(1) + 2 = 3 bytes', () => {
    const s = fresh(1, [['v', 'q16s']]);
    assert.strictEqual(SchemaCodec.encode(s, { v: -0.5 }).length, 3);
});

test('q16s clamps out-of-range values', () => {
    const s = fresh(1, [['v', 'q16s']]);
    assert.strictEqual(SchemaCodec.decode(s, SchemaCodec.encode(s, { v: 5 })).v, 1);
    assert.strictEqual(SchemaCodec.decode(s, SchemaCodec.encode(s, { v: -5 })).v, -1);
});

test('q16_2pi roundtrip across [0, 2π)', () => {
    const s = fresh(1, [['v', 'q16_2pi']]);
    for (const v of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 1.234]) {
        const out = SchemaCodec.decode(s, SchemaCodec.encode(s, { v }));
        assert.ok(Math.abs(out.v - v) < 2 * TWO_PI / 65536, `expected ~${v}, got ${out.v}`);
    }
});

test('q16_2pi wraps negative angles into [0, 2π)', () => {
    const s = fresh(1, [['v', 'q16_2pi']]);
    // -0.0001 should wrap to ~(2π - 0.0001), well within the resolution.
    const out = SchemaCodec.decode(s, SchemaCodec.encode(s, { v: -0.0001 }));
    assert.ok(out.v > Math.PI, `expected wrap into upper half, got ${out.v}`);
    const distFromZero = Math.min(out.v, TWO_PI - out.v);
    assert.ok(distFromZero < 1e-3, `expected close to 2π, got ${out.v}`);
});

test('q16_2pi roundtrip near 2π wraps to ~0', () => {
    const s = fresh(1, [['v', 'q16_2pi']]);
    const out = SchemaCodec.decode(s, SchemaCodec.encode(s, { v: TWO_PI }));
    // 2π exactly wraps to 0; tolerance is one quantum.
    assert.ok(out.v < 2 * TWO_PI / 65536, `expected wrap to ~0, got ${out.v}`);
});

test('q16_2pi handles large multi-rotation inputs', () => {
    const s = fresh(1, [['v', 'q16_2pi']]);
    // 5.5 full rotations + 1.0 rad
    const v = 5 * TWO_PI + 1.0;
    const out = SchemaCodec.decode(s, SchemaCodec.encode(s, { v }));
    assert.ok(Math.abs(out.v - 1.0) < 2 * TWO_PI / 65536, `expected ~1.0, got ${out.v}`);
});

test('q8 roundtrip with ~4e-3 tolerance', () => {
    const s = fresh(1, [['v', 'q8']]);
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        const out = SchemaCodec.decode(s, SchemaCodec.encode(s, { v }));
        assert.ok(Math.abs(out.v - v) < 1 / 255 + 1e-9, `expected ~${v}, got ${out.v}`);
    }
});

test('q8 wire size: bitmask(1) + 1 = 2 bytes', () => {
    const s = fresh(1, [['v', 'q8']]);
    assert.strictEqual(SchemaCodec.encode(s, { v: 0.5 }).length, 2);
});

test('mixed quantized + bool schema packs correctly', () => {
    const s = fresh(1, [
        ['x', 'q16'], ['y', 'q16'], ['angle', 'q16_2pi'],
        ['vx', 'q16s'], ['thrusting', 'bool'],
    ]);
    const data = { x: 0.3, y: 0.7, angle: 1.2345, vx: -0.42, thrusting: true };
    const wire = SchemaCodec.encode(s, data);
    // bitmask(1) + 4×u/i16(8) + bool(1) = 10
    assert.strictEqual(wire.length, 10);
    const out = SchemaCodec.decode(s, wire);
    assert.ok(Math.abs(out.x - data.x) < 2 / 65535);
    assert.ok(Math.abs(out.y - data.y) < 2 / 65535);
    assert.ok(Math.abs(out.angle - data.angle) < 2 * TWO_PI / 65536);
    assert.ok(Math.abs(out.vx - data.vx) < 2 / 32767);
    assert.strictEqual(out.thrusting, true);
});

test('quantized fields work with delta encoding (omitted slots stay omitted)', () => {
    const s = fresh(1, [
        ['x', 'q16'], ['y', 'q16'], ['angle', 'q16_2pi'],
    ]);
    // Only x present.
    const wire = SchemaCodec.encode(s, { x: 0.42 });
    // bitmask(1) + 1 q16 (2) = 3 bytes
    assert.strictEqual(wire.length, 3);
    const out = SchemaCodec.decode(s, wire);
    assert.ok(Math.abs(out.x - 0.42) < 2 / 65535);
    assert.ok(!('y' in out));
    assert.ok(!('angle' in out));
});

test('asteroid-update quantized schema: 3×q16 = 7 bytes total', () => {
    // This mirrors the Phase 5 game schema: x/y as q16, angle as q16_2pi.
    const s = fresh(3, [
        ['x', 'q16'], ['y', 'q16'], ['angle', 'q16_2pi'],
    ]);
    const wire = SchemaCodec.encode(s, { x: 0.523, y: 0.412, angle: 1.234 });
    // bitmask(1) + 3×u16(6) = 7
    assert.strictEqual(wire.length, 7);
});
