/**
 * Unit tests for AstervoidsWeb/wwwroot/js/wire-enum.js
 *
 * Verifies the byte→string translation contract for MemberRole and ObjectScope,
 * plus the GuidLongPair[] → object adapter used by snapshot/version response paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load wire-enum.js as a CommonJS-ish module (it self-installs WireEnum on globalThis
// when run in a browser; in node we eval into a sandbox to capture the module export).
const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, 'wwwroot/js/wire-enum.js'), 'utf8');
const moduleHost = { exports: {} };
new Function('module', src + '\nmodule.exports = WireEnum;')(moduleHost);
const WireEnum = moduleHost.exports;

// ── roleFromWire ────────────────────────────────────────────────────────────

test('roleFromWire: byte 0 → Server', () => {
    assert.equal(WireEnum.roleFromWire(0), 'Server');
});

test('roleFromWire: byte 1 → Client', () => {
    assert.equal(WireEnum.roleFromWire(1), 'Client');
});

test('roleFromWire: passes through string (idempotent)', () => {
    assert.equal(WireEnum.roleFromWire('Server'), 'Server');
    assert.equal(WireEnum.roleFromWire('Client'), 'Client');
});

test('roleFromWire: unknown byte → null', () => {
    assert.equal(WireEnum.roleFromWire(255), null);
});

test('roleFromWire: null/undefined pass through', () => {
    assert.equal(WireEnum.roleFromWire(null), null);
    assert.equal(WireEnum.roleFromWire(undefined), undefined);
});

// ── scopeFromWire ───────────────────────────────────────────────────────────

test('scopeFromWire: byte 0 → Member', () => {
    assert.equal(WireEnum.scopeFromWire(0), 'Member');
});

test('scopeFromWire: byte 1 → Session', () => {
    assert.equal(WireEnum.scopeFromWire(1), 'Session');
});

test('scopeFromWire: passes through string (idempotent)', () => {
    assert.equal(WireEnum.scopeFromWire('Member'), 'Member');
    assert.equal(WireEnum.scopeFromWire('Session'), 'Session');
});

test('scopeFromWire: unknown byte → null', () => {
    assert.equal(WireEnum.scopeFromWire(99), null);
});

// ── translateMember / translateObject (in-place) ────────────────────────────

test('translateMember: rewrites role byte to string', () => {
    const m = { id: 'guid', role: 0, joinedAt: 'iso' };
    WireEnum.translateMember(m);
    assert.equal(m.role, 'Server');
});

test('translateMember: leaves null/undefined untouched', () => {
    assert.equal(WireEnum.translateMember(null), null);
    assert.equal(WireEnum.translateMember(undefined), undefined);
});

test('translateObject: rewrites scope byte to string', () => {
    const o = { id: 'guid', scope: 1, version: 1 };
    WireEnum.translateObject(o);
    assert.equal(o.scope, 'Session');
});

// ── pairsToObject ───────────────────────────────────────────────────────────

test('pairsToObject: converts GuidLongPair[] form to object', () => {
    // After GuidUtils.transformBinaryGuids walks the wire shape, each entry
    // is a 2-element array [guidString, long].
    const pairs = [
        ['11111111-1111-1111-1111-111111111111', 1700000000000],
        ['22222222-2222-2222-2222-222222222222', 1700000000050],
    ];
    const obj = WireEnum.pairsToObject(pairs);
    assert.equal(obj['11111111-1111-1111-1111-111111111111'], 1700000000000);
    assert.equal(obj['22222222-2222-2222-2222-222222222222'], 1700000000050);
    assert.equal(Object.keys(obj).length, 2);
});

test('pairsToObject: returns empty object for null/undefined', () => {
    assert.deepEqual(WireEnum.pairsToObject(null), {});
    assert.deepEqual(WireEnum.pairsToObject(undefined), {});
});

test('pairsToObject: passes through non-array (legacy/test fixture object)', () => {
    const legacy = { 'guid-a': 100, 'guid-b': 200 };
    assert.equal(WireEnum.pairsToObject(legacy), legacy);
});

test('pairsToObject: skips malformed entries', () => {
    const pairs = [
        ['guid-a', 1],
        null,
        ['guid-b'], // too short
        ['guid-c', 3],
    ];
    const obj = WireEnum.pairsToObject(pairs);
    assert.equal(obj['guid-a'], 1);
    assert.equal(obj['guid-c'], 3);
    assert.equal(Object.keys(obj).length, 2);
});
