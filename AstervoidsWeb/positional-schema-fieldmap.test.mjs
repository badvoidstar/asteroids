// Regression: when the game configures a fieldMap (e.g. angle→'a',
// velocityX→'vx', invulnerable→'iv') AND uses a positional schema for
// outbound updates, the schema codec must still see the ORIGINAL field
// names. Field-name compression is for the legacy MessagePack dict path
// only — positional schemas have no key bytes on the wire and look up
// dict[f.name] using the schema's declared names.
//
// Without this guard the positional encoder silently dropped every field
// whose key was remapped: only x and y survived (they pass through the
// fieldMap unchanged). Symptoms in two-player sessions:
//   - Remote asteroids didn't rotate properly (angle frozen → hermite
//     blends identical values → extrapolation snaps).
//   - Remote ships were invisible (invulnerable frozen at create-time
//     value 180 → Math.floor(180/10)%2 === 0 → blink-off forever).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// sync-payload.js depends on the global MsgpackCodec — attach before requiring.
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
globalThis.MsgpackCodec = MsgpackCodec;
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
globalThis.SchemaCodec = SchemaCodec;
const SyncPayload = require('./wwwroot/js/sync-payload.js');

// Mirror compressData behavior from object-sync.js. We don't import
// object-sync directly because it requires SignalR/window globals; the
// failure mode is purely about the order of operations on the dict.
function compressData(data, fieldMap) {
    if (!data) return data;
    const out = {};
    for (const key in data) out[fieldMap[key] || key] = data[key];
    return out;
}

// Reproduce the contract documented in object-sync.js flushUpdates:
// only legacy SchemaId=0 (MessagePack dict path) gets field-name compression.
function buildWirePayload(data, schemaId, fieldMap) {
    const dictForEncode = (schemaId === 0) ? compressData(data, fieldMap) : data;
    return SyncPayload.wrap(dictForEncode, schemaId);
}

test('positional schema receives ALL fields when fieldMap remaps every key', () => {
    SchemaCodec.clear();
    SchemaCodec.register(1, [
        ['x', 'q16'], ['y', 'q16'], ['angle', 'q16_2pi'],
        ['velocityX', 'q16s'], ['velocityY', 'q16s'],
        ['rotationSpeed', 'q16s'],
        ['thrusting', 'bool'], ['invulnerable', 'u16'],
    ]);

    const fieldMap = {
        angle: 'a', velocityX: 'vx', velocityY: 'vy',
        rotationSpeed: 'rs', thrusting: 'th', invulnerable: 'iv',
    };

    const original = {
        x: 0.5, y: 0.25, angle: 1.234,
        velocityX: 0.1, velocityY: -0.2, rotationSpeed: 0.05,
        thrusting: true, invulnerable: 120,
    };

    const wire = buildWirePayload(original, 1, fieldMap);
    assert.strictEqual(wire[0], 1, 'wire schemaId must be 1');
    const d = SyncPayload.unwrap(wire);

    // All field names round-trip with their ORIGINAL names (positional
    // schemas don't go through compressData/expandData).
    for (const k of ['x', 'y', 'angle', 'velocityX', 'velocityY', 'rotationSpeed', 'thrusting', 'invulnerable']) {
        assert.ok(k in d, `missing field on the wire: ${k}`);
    }
    // Quantization tolerances mirror schema-codec-quantize.test.mjs.
    assert.ok(Math.abs(d.x - 0.5) < 2 / 65535);
    assert.ok(Math.abs(d.y - 0.25) < 2 / 65535);
    assert.ok(Math.abs(d.angle - 1.234) < 2 * Math.PI / 65535);
    assert.ok(Math.abs(d.velocityX - 0.1) < 2 / 32767);
    assert.ok(Math.abs(d.velocityY - (-0.2)) < 2 / 32767);
    assert.ok(Math.abs(d.rotationSpeed - 0.05) < 2 / 32767);
    assert.strictEqual(d.thrusting, true);
    assert.strictEqual(d.invulnerable, 120);
});

test('legacy SchemaId=0 still uses fieldMap compression on the dict path', () => {
    SchemaCodec.clear();
    const fieldMap = { angle: 'a', invulnerable: 'iv' };
    const original = { x: 0.5, angle: 1.0, invulnerable: 60 };

    const wire = buildWirePayload(original, 0, fieldMap);
    assert.strictEqual(wire[0], 0, 'wire schemaId must be 0');
    const d = SyncPayload.unwrap(wire);

    // SchemaId=0 receivers are responsible for calling expandData themselves.
    // Here we just assert the wire-level dict is in compressed form, which
    // proves compressData ran for the legacy path (and only for that path).
    assert.deepStrictEqual(d, { x: 0.5, a: 1.0, iv: 60 });
});

test('invulnerable frame counter (0..180) survives positional encoding as integer', () => {
    SchemaCodec.clear();
    // Same shape as the live game's ship-update schema. Critical: 'u16',
    // never 'bool' — a bool schema collapses every nonzero counter value
    // to 1 and the receiver's blink check (Math.floor(v/10)%2===0) parks
    // the ship in the off-half for the entire 3-second invuln period.
    SchemaCodec.register(1, [
        ['x', 'q16'], ['y', 'q16'], ['invulnerable', 'u16'],
    ]);
    const fieldMap = { invulnerable: 'iv' };

    for (const v of [0, 1, 60, 120, 179, 180]) {
        const wire = buildWirePayload({ x: 0.5, y: 0.5, invulnerable: v }, 1, fieldMap);
        const d = SyncPayload.unwrap(wire);
        assert.strictEqual(d.invulnerable, v, `invuln=${v} round-trip`);
        // Receiver's blink phase must reflect the integer value, not a bool.
        assert.strictEqual(
            Math.floor(d.invulnerable / 10) % 2,
            Math.floor(v / 10) % 2,
            `blink phase mismatch at invuln=${v}`
        );
    }
});
