/**
 * Unit tests for ObjectSync.registerEventKind / emitEvent / dispatch
 * (Phase 2.1 generic per-object event channel).
 *
 * Loads object-sync.js with stubbed SessionClient + signalR globals so we can
 * exercise the registration/dispatch logic without a hub connection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadObjectSync(stubs) {
    // Stubs we feed into the global before evaluating object-sync.js.
    const globals = {
        SessionClient: stubs.SessionClient,
        signalR: { HubConnectionState: { Connected: 'Connected', Reconnecting: 'Reconnecting' } },
        window: { ASTERVOIDS_DEBUG: false },
        console
    };
    const src = readFileSync(resolve(__dirname, 'wwwroot/js/object-sync.js'), 'utf8');
    const moduleHost = { exports: {} };
    const fn = new Function(...Object.keys(globals), 'module', src + '\nmodule.exports = ObjectSync;');
    fn(...Object.values(globals), moduleHost);
    return moduleHost.exports;
}

function makeSessionClientStub() {
    const handlers = {};
    const sent = [];
    return {
        sentEvents: sent,
        handlers,
        on: (event, cb) => { handlers[event] = cb; },
        broadcastObjectEvent: async (objectId, eventKind, payload, validAt) => {
            sent.push({ objectId, eventKind, payload, validAt });
            return true;
        },
        isInSession: () => true
    };
}

test('registerEventKind: maps name ↔ byte both directions', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    ObjectSync.registerEventKind('foo', 7);
    // No throw on identical re-registration (idempotent)
    ObjectSync.registerEventKind('foo', 7);
});

test('registerEventKind: throws on byte conflict', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    ObjectSync.registerEventKind('foo', 7);
    assert.throws(() => ObjectSync.registerEventKind('bar', 7), /already mapped/);
});

test('registerEventKind: throws on name conflict', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    ObjectSync.registerEventKind('foo', 7);
    assert.throws(() => ObjectSync.registerEventKind('foo', 8), /already mapped/);
});

test('registerEventKind: rejects non-string name', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    assert.throws(() => ObjectSync.registerEventKind('', 1), /non-empty string/);
    assert.throws(() => ObjectSync.registerEventKind(123, 1), /non-empty string/);
});

test('registerEventKind: rejects out-of-range byte', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    assert.throws(() => ObjectSync.registerEventKind('foo', -1), /\[0, 255\]/);
    assert.throws(() => ObjectSync.registerEventKind('foo', 256), /\[0, 255\]/);
    assert.throws(() => ObjectSync.registerEventKind('foo', 1.5), /\[0, 255\]/);
});

test('emitEvent: invokes local handler synchronously then sends', async () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    const received = [];
    ObjectSync.registerEventKind('ship-state-changed', 1);
    ObjectSync.on('objectEvent:ship-state-changed', (objectId, payload, ctx) => {
        received.push({ objectId, payload, local: ctx.local });
    });

    await ObjectSync.emitEvent('obj-1', 'ship-state-changed', { score: 100 });

    assert.equal(received.length, 1, 'local handler ran exactly once');
    assert.equal(received[0].objectId, 'obj-1');
    assert.deepEqual(received[0].payload, { score: 100 });
    assert.equal(received[0].local, true);
    assert.equal(stub.sentEvents.length, 1, 'sent over wire');
    assert.equal(stub.sentEvents[0].eventKind, 1);
});

test('emitEvent: silent no-op when kind unregistered', async () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    const result = await ObjectSync.emitEvent('obj-1', 'never-registered', { x: 1 });
    assert.equal(result, false);
    assert.equal(stub.sentEvents.length, 0);
});

test('dispatch: SessionClient onObjectEvent → registered handler invoked', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();

    const received = [];
    ObjectSync.registerEventKind('ship-state-changed', 1);
    ObjectSync.on('objectEvent:ship-state-changed', (objectId, payload, ctx) => {
        received.push({ objectId, payload, ctx });
    });

    // Simulate hub broadcast arrival.
    const onObjectEvent = stub.handlers['onObjectEvent'];
    assert.ok(onObjectEvent, 'object-sync registered onObjectEvent handler');
    onObjectEvent(
        { objectId: 'obj-1', eventKind: 1, payload: { score: 50 } },
        'sender-123',
        42,
        1700000000000
    );

    assert.equal(received.length, 1);
    assert.equal(received[0].objectId, 'obj-1');
    assert.deepEqual(received[0].payload, { score: 50 });
    assert.equal(received[0].ctx.local, false);
    assert.equal(received[0].ctx.senderMemberId, 'sender-123');
    assert.equal(received[0].ctx.memberSequence, 42);
    assert.equal(received[0].ctx.validAt, 1700000000000);
});

test('dispatch: unknown kind byte → silent (warn only)', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();

    const onObjectEvent = stub.handlers['onObjectEvent'];
    // Should not throw even though kind 99 is unregistered.
    onObjectEvent({ objectId: 'obj-1', eventKind: 99, payload: {} }, 's', 1, null);
});

test('dispatch: handler throw is caught (does not propagate)', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();

    ObjectSync.registerEventKind('boom', 5);
    ObjectSync.on('objectEvent:boom', () => { throw new Error('handler bug'); });

    const onObjectEvent = stub.handlers['onObjectEvent'];
    // Should not throw upward.
    onObjectEvent({ objectId: 'obj-1', eventKind: 5, payload: {} }, 's', 1, null);
});

test('on(objectEvent:KIND, null): unregisters handler', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();
    ObjectSync.registerEventKind('foo', 1);

    let calls = 0;
    ObjectSync.on('objectEvent:foo', () => { calls++; });
    ObjectSync.on('objectEvent:foo', null);

    const onObjectEvent = stub.handlers['onObjectEvent'];
    onObjectEvent({ objectId: 'obj-1', eventKind: 1, payload: {} }, 's', 1, null);
    assert.equal(calls, 0);
});
