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
    assert.throws(() => SyncPayload.unwrap([5, new Uint8Array([0x80])]), /schemaId=5 not supported/);
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
