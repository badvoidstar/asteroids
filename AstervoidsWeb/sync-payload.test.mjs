/**
 * Tests for the JS-side SyncPayload envelope adapter
 * (mirror of AstervoidsWeb/Hubs/SyncPayloadCodec.cs).
 *
 * Run with: node --test AstervoidsWeb/sync-payload.test.mjs
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
// sync-payload.js depends on the global MsgpackCodec — attach it before requiring.
globalThis.MsgpackCodec = MsgpackCodec;
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
globalThis.SchemaCodec = SchemaCodec;
const SyncPayload = require('./wwwroot/js/sync-payload.js');

test('wrap returns [0, Uint8Array] for a plain dict', () => {
    const result = SyncPayload.wrap({ x: 1.5, y: 2.5 });
    assert.equal(Array.isArray(result), true);
    assert.equal(result.length, 2);
    assert.equal(result[0], 0);
    assert.ok(result[1] instanceof Uint8Array);
});

test('wrap of null produces an envelope with empty-dict bytes (round-trips to {})', () => {
    const wrapped = SyncPayload.wrap(null);
    const dict = SyncPayload.unwrap(wrapped);
    assert.deepEqual(dict, {});
});

test('wrap is idempotent on already-wrapped payloads', () => {
    const original = SyncPayload.wrap({ foo: 'bar' });
    const re = SyncPayload.wrap(original);
    assert.strictEqual(re, original, 'should return the same reference');
});

test('unwrap is idempotent on plain-dict inputs', () => {
    const dict = { a: 1, b: 'two' };
    const result = SyncPayload.unwrap(dict);
    assert.strictEqual(result, dict);
});

test('unwrap of null returns null', () => {
    assert.equal(SyncPayload.unwrap(null), null);
    assert.equal(SyncPayload.unwrap(undefined), null);
});

test('round-trip preserves common game-dict value shapes', () => {
    const original = {
        type: 'asteroid',
        x: 0.523,
        y: 0.412,
        angle: 1.234,
        velocityX: 0.05,
        velocityY: -0.03,
        thrusting: true,
        invulnerable: false,
        seed: 12345,
        memberId: '12345678-1234-1234-1234-123456789012',
        nested: [1.0, 2.0, 3.0],
        nilField: null,
    };
    const wrapped = SyncPayload.wrap(original);
    const decoded = SyncPayload.unwrap(wrapped);
    assert.deepEqual(decoded, original);
});

test('unwrap throws on an unknown schema id', () => {
    // Phase 4: schemaId=5 dispatches to SchemaCodec; with no schema registered
    // the error mentions the registry/metadata path so debugging stays obvious.
    assert.throws(
        () => SyncPayload.unwrap([5, new Uint8Array([0x80])]),
        /schemaId=5 not registered/);
});

test('unwrapObjectData mutates and returns the same object', () => {
    const wrapped = SyncPayload.wrap({ x: 0.5 });
    const obj = { id: 'abc', data: wrapped, version: 1 };
    const result = SyncPayload.unwrapObjectData(obj);
    assert.strictEqual(result, obj);
    assert.deepEqual(obj.data, { x: 0.5 });
    assert.equal(obj.id, 'abc');
    assert.equal(obj.version, 1);
});

test('unwrapObjectData is a no-op for null/undefined and missing data slot', () => {
    assert.equal(SyncPayload.unwrapObjectData(null), null);
    assert.equal(SyncPayload.unwrapObjectData(undefined), undefined);
    const noData = { id: 'x' };
    SyncPayload.unwrapObjectData(noData);
    assert.deepEqual(noData, { id: 'x' });
});

test('LEGACY_DICT_SCHEMA_ID is 0 (matches SyncPayloadCodec.LegacyDictSchemaId)', () => {
    assert.equal(SyncPayload.LEGACY_DICT_SCHEMA_ID, 0);
});

test('wrap of an empty dict still produces a valid envelope', () => {
    const wrapped = SyncPayload.wrap({});
    assert.equal(wrapped[0], 0);
    assert.ok(wrapped[1] instanceof Uint8Array);
    assert.deepEqual(SyncPayload.unwrap(wrapped), {});
});

test('unwrap accepts an envelope with empty/null Data and returns {}', () => {
    assert.deepEqual(SyncPayload.unwrap([0, new Uint8Array(0)]), {});
    assert.deepEqual(SyncPayload.unwrap([0, null]), {});
});

// ── Phase 4: positional schema dispatch via SchemaCodec ────────────────────

test('phase 4 wrap dispatches to SchemaCodec for schemaId>=1', () => {
    SchemaCodec.clear();
    SchemaCodec.register(7, [['x', 'f64'], ['y', 'f64']]);
    const wrapped = SyncPayload.wrap({ x: 0.5, y: 0.25 }, 7);
    assert.equal(wrapped[0], 7);
    assert.ok(wrapped[1] instanceof Uint8Array);
    // bitmask(1) + 2 × f64(8) = 17
    assert.equal(wrapped[1].length, 17);
});

test('phase 4 wrap → unwrap round-trip matches original dict', () => {
    SchemaCodec.clear();
    SchemaCodec.register(11, [['x', 'f64'], ['y', 'f64'], ['angle', 'f64']]);
    const original = { x: 0.5, y: 0.25, angle: Math.PI / 4 };
    const wrapped = SyncPayload.wrap(original, 11);
    const decoded = SyncPayload.unwrap(wrapped);
    assert.equal(decoded.x, 0.5);
    assert.equal(decoded.y, 0.25);
    assert.ok(Math.abs(decoded.angle - Math.PI / 4) < 1e-12);
});

test('phase 4 wrap with no schema registered throws clear error', () => {
    SchemaCodec.clear();
    assert.throws(
        () => SyncPayload.wrap({ x: 1 }, 99),
        /no schema registered for id=99/);
});

test('phase 4 unwrap of unregistered schemaId throws guidance about metadata.schemas', () => {
    SchemaCodec.clear();
    assert.throws(
        () => SyncPayload.unwrap([42, new Uint8Array([0x00])]),
        /metadata\.schemas before processing object events/);
});

test('phase 4 wrap defaults to schemaId=0 when arg is omitted (back-compat)', () => {
    SchemaCodec.clear();
    const wrapped = SyncPayload.wrap({ a: 1 });
    assert.equal(wrapped[0], 0);
});
