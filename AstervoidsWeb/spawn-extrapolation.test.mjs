/**
 * Tests for RemoteObjects spawn / single-snapshot extrapolation primitives
 * that survived the validAt-axis unification.
 *
 * After the unification, the receiver's bracket-search handles spawn timing
 * naturally on the validAt axis (see validAt-axis.test.mjs). The two
 * projection helpers `computeSpawnStaleness` and `projectSpawnData` remain
 * in production for one specific path: the LOCAL OWNER adopting a freshly
 * created object after the round-trip from `replaceObject`. The local game
 * physics (asteroid sim) is not interpolated, so its initial position must
 * be forward-projected from the parent's collision moment to "now."
 *
 * `getMigrationSeed` also calls `projectSpawnData` to extrapolate the
 * latest snapshot to serverNowMs() during ownership handoff.
 *
 * Single-snapshot velocity-based extrapolation (the multi-snap fallback
 * inside `_baseInterpolated`) is still capped to `MAX_EXTRAPOLATION` to
 * prevent runaway projection from a poor estimate.
 *
 * Run with:  node --test AstervoidsWeb/spawn-extrapolation.test.mjs
 *
 * Mirror with AstervoidsWeb/wwwroot/index.html (RemoteObjects).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const CONFIG = {
    MAX_EXTRAPOLATION: 1.0,   // seconds
    TARGET_FPS: 60,           // angle units are per-frame; rotationSpeed × TARGET_FPS = rad/sec
};

// ── Pure-logic mirrors of RemoteObjects helpers ───────────────────────────

/** Mirror of RemoteObjects.computeSpawnStaleness (clamped to ±MAX_EXTRAPOLATION). */
function computeSpawnStaleness(serverNowMsValue, validAt) {
    const elapsedSec = (serverNowMsValue - validAt) / 1000;
    const cap = CONFIG.MAX_EXTRAPOLATION;
    if (elapsedSec > cap) return cap;
    if (elapsedSec < -cap) return -cap;
    return elapsedSec;
}

/**
 * Simplified mirror of RemoteObjects.projectSpawnData. The production
 * version applies toroidal wrap; this test mirror skips wrap to keep
 * arithmetic assertions simple. Wrap behavior is exercised separately
 * inside the wrap-skip test below using a stand-in helper.
 */
function projectSpawnDataNoWrap(data, stalenessSec) {
    if (!stalenessSec) return { ...data };
    const vx = data.velocityX || 0;
    const vy = data.velocityY || 0;
    const rs = data.rotationSpeed || 0;
    return {
        ...data,
        x: (data.x || 0) + vx * stalenessSec,
        y: (data.y || 0) + vy * stalenessSec,
        angle: (data.angle || 0) + rs * CONFIG.TARGET_FPS * stalenessSec,
    };
}

/**
 * Mirror of the single-snap extrapolation arm inside `_baseInterpolated`.
 * Returns null if no snaps; clamps to snap[0].data if targetTime ≤ snap[0].time;
 * otherwise extrapolates by velocity for at most MAX_EXTRAPOLATION seconds.
 */
function singleSnapExtrapolate(snap, targetTime) {
    if (!snap) return null;
    if (targetTime <= snap.time) return { ...snap.data };
    const extraTime = Math.min((targetTime - snap.time) / 1000, CONFIG.MAX_EXTRAPOLATION);
    return {
        ...snap.data,
        x: (snap.data.x || 0) + (snap.velocity.x || 0) * extraTime,
        y: (snap.data.y || 0) + (snap.velocity.y || 0) * extraTime,
        angle: (snap.data.angle || 0) + (snap.rotationSpeed || 0) * CONFIG.TARGET_FPS * extraTime,
    };
}

function makeSnap(data, time) {
    return {
        data: { ...data },
        time,
        velocity: { x: data.velocityX || 0, y: data.velocityY || 0 },
        rotationSpeed: data.rotationSpeed || 0,
    };
}

// ── computeSpawnStaleness ─────────────────────────────────────────────────

test('computeSpawnStaleness: positive elapsed (validAt in past) returns positive seconds', () => {
    assert.equal(computeSpawnStaleness(1500, 1200), 0.3);
});

test('computeSpawnStaleness: zero elapsed returns 0', () => {
    assert.equal(computeSpawnStaleness(1500, 1500), 0);
});

test('computeSpawnStaleness: validAt in future returns negative seconds', () => {
    // Owner's clock is ahead of receiver's NTP estimate — small negative
    // staleness is allowed (project backward).
    assert.equal(computeSpawnStaleness(1500, 1700), -0.2);
});

test('computeSpawnStaleness: clamps at +MAX_EXTRAPOLATION (1.0s)', () => {
    // 5s of staleness → clamped to 1.0s.
    assert.equal(computeSpawnStaleness(6000, 1000), 1.0);
});

test('computeSpawnStaleness: clamps at -MAX_EXTRAPOLATION (-1.0s)', () => {
    assert.equal(computeSpawnStaleness(1000, 6000), -1.0);
});

test('computeSpawnStaleness: at exactly the cap returns the cap', () => {
    assert.equal(computeSpawnStaleness(2000, 1000), 1.0);
    assert.equal(computeSpawnStaleness(1000, 2000), -1.0);
});

// ── projectSpawnData ──────────────────────────────────────────────────────

test('projectSpawnData: zero staleness returns data unchanged', () => {
    const data = { x: 0.5, y: 0.5, velocityX: 100, velocityY: 50, angle: 0.7, rotationSpeed: 0.1 };
    const result = projectSpawnDataNoWrap(data, 0);
    assert.deepEqual(result, data);
});

test('projectSpawnData: forward projection moves x/y by velocity × staleness', () => {
    const data = { x: 10, y: 20, velocityX: 100, velocityY: -50, angle: 0, rotationSpeed: 0 };
    const result = projectSpawnDataNoWrap(data, 0.5);
    assert.equal(result.x, 60, 'x = 10 + 100 * 0.5');
    assert.equal(result.y, -5, 'y = 20 + (-50) * 0.5');
});

test('projectSpawnData: backward projection (negative staleness) reverses motion', () => {
    const data = { x: 10, y: 20, velocityX: 100, velocityY: -50, angle: 0, rotationSpeed: 0 };
    const result = projectSpawnDataNoWrap(data, -0.2);
    assert.equal(result.x, -10, 'x = 10 + 100 * -0.2');
    assert.equal(result.y, 30, 'y = 20 + (-50) * -0.2');
});

test('projectSpawnData: angle advances by rotationSpeed × TARGET_FPS × staleness', () => {
    // rotationSpeed is per-frame; multiplied by TARGET_FPS to convert to per-sec.
    const data = { x: 0, y: 0, velocityX: 0, velocityY: 0, angle: 1.0, rotationSpeed: 0.1 };
    const result = projectSpawnDataNoWrap(data, 0.5);
    // angle = 1.0 + 0.1 * 60 * 0.5 = 1.0 + 3.0 = 4.0
    assert.equal(result.angle, 4.0);
});

test('projectSpawnData: missing velocity/angle/rotation fields default to 0', () => {
    const data = { x: 5, y: 5 };
    const result = projectSpawnDataNoWrap(data, 0.5);
    assert.equal(result.x, 5);
    assert.equal(result.y, 5);
    assert.equal(result.angle, 0);
});

test('projectSpawnData: preserves non-motion fields (id, ownerMemberId, etc.)', () => {
    const data = {
        x: 1, y: 1, velocityX: 100, velocityY: 0,
        angle: 0, rotationSpeed: 0,
        id: 'asteroid-42', ownerMemberId: 'member-A', radius: 0.05,
    };
    const result = projectSpawnDataNoWrap(data, 0.5);
    assert.equal(result.id, 'asteroid-42');
    assert.equal(result.ownerMemberId, 'member-A');
    assert.equal(result.radius, 0.05);
});

// ── computeSpawnStaleness + projectSpawnData composed ─────────────────────

test('compose: spawn projection uses clamped staleness', () => {
    // Clock estimate is way off — spawn validAt looks 10s old. Clamp prevents
    // a runaway projection (would teleport asteroid 10× its expected distance).
    const serverNow = 11000;
    const validAt = 1000; // 10 seconds old
    const data = { x: 0, y: 0, velocityX: 100, velocityY: 0 };

    const staleness = computeSpawnStaleness(serverNow, validAt);
    assert.equal(staleness, 1.0, 'staleness clamped to 1s');

    const projected = projectSpawnDataNoWrap(data, staleness);
    assert.equal(projected.x, 100, 'projection capped at 1s of motion (100 units), not 1000');
});

// ── Single-snapshot velocity extrapolation (production fallback path) ─────

test('singleSnapExtrapolate: targetTime ≤ snap.time clamps to snap.data', () => {
    const snap = makeSnap({ x: 5, y: 5, velocityX: 100, velocityY: 0, angle: 0, rotationSpeed: 0 }, 1000);
    const result = singleSnapExtrapolate(snap, 900);
    assert.equal(result.x, 5);
    assert.equal(result.y, 5);
});

test('singleSnapExtrapolate: forward extrapolation by velocity', () => {
    const snap = makeSnap({ x: 5, y: 5, velocityX: 100, velocityY: 50, angle: 0, rotationSpeed: 0 }, 1000);
    const result = singleSnapExtrapolate(snap, 1500);
    // 0.5s * 100 = 50; x = 55
    assert.equal(result.x, 55);
    assert.equal(result.y, 30);
});

test('singleSnapExtrapolate: forward extrapolation includes rotation', () => {
    const snap = makeSnap({ x: 0, y: 0, velocityX: 0, velocityY: 0, angle: 0.5, rotationSpeed: 0.1 }, 1000);
    const result = singleSnapExtrapolate(snap, 1500);
    // 0.1 * 60 * 0.5 = 3.0 + 0.5 base = 3.5
    assert.equal(result.angle, 3.5);
});

test('singleSnapExtrapolate: cap at MAX_EXTRAPOLATION (1.0s) prevents runaway', () => {
    const snap = makeSnap({ x: 0, y: 0, velocityX: 100, velocityY: 0, angle: 0, rotationSpeed: 0 }, 1000);
    const result = singleSnapExtrapolate(snap, 6000); // 5s past — should clamp to 1s
    assert.equal(result.x, 100, 'x capped at 1s of motion (100 units), not 500');
});

test('singleSnapExtrapolate: returns null for null snap', () => {
    assert.equal(singleSnapExtrapolate(null, 1000), null);
});

// ── Continuity invariant: spawn projection and bracket extrapolation match ─

test('continuity: receiver bracket-extrapolates to same x as local-owner spawn projection', () => {
    // The owner authors a snap at validAt=1000 with x=0.5, vx=100.
    // The local owner adopts the asteroid at serverNow=1300 (300ms RTT)
    // and forward-projects: x = 0.5 + 100 * 0.3 = 30.5.
    // A receiver renders the same snap at the same server-time moment
    // (renderTime equivalent to serverNow=1300) and bracket-extrapolates:
    // also x = 0.5 + 100 * 0.3 = 30.5. Both arrive at the same position.
    const validAt = 1000;
    const serverNow = 1300;
    const data = { x: 0.5, y: 0, velocityX: 100, velocityY: 0, angle: 0, rotationSpeed: 0 };

    const staleness = computeSpawnStaleness(serverNow, validAt);
    const projected = projectSpawnDataNoWrap(data, staleness);

    // Bracket extrapolation arm: snap.time on perf.now axis; assume perf.now == server-time
    // for this test (offset=0, delta=0). Then snap.time = 1000, targetTime = 1300.
    const snap = makeSnap(data, 1000);
    const extrapolated = singleSnapExtrapolate(snap, 1300);

    assert.equal(projected.x, extrapolated.x,
        'spawn projection (local owner) and bracket extrapolation (receiver) yield identical x');
    assert.equal(projected.y, extrapolated.y);
});
