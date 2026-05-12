/**
 * Tests for the unified validAt interpolation axis.
 *
 * Mirrors logic from AstervoidsWeb/wwwroot/index.html (RemoteObjects):
 *   - validAtToPerfNow:           server-time → perf.now-domain conversion
 *   - wallToPerfDelta:            performance.now - Date.now (refreshed per ping)
 *   - updateState (snapshot push) on the unified axis
 *   - bracket-search clamp/extrapolate on snapshots keyed by validAt
 *   - getMigrationSeed:           leading-edge projection for ownership handoff
 *
 * The behaviour these tests verify is the design goal of the unification:
 * network jitter must NOT shift snapshot positions in the bracket, and
 * spawn / migration handoff must be continuous on the receiver without
 * any explicit smoother running in the interpolator.
 *
 * Run with:  node --test AstervoidsWeb/validAt-axis.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Pure-logic mirrors of RemoteObjects helpers ───────────────────────────

/**
 * Mirror of RemoteObjects.validAtToPerfNow.
 *
 *   server_time_ms = Date.now() + offsetMs
 *   wall_time_ms   = server_time_ms - offsetMs
 *   perf_now_ms    = wall_time_ms + (perf.now - Date.now) [== wallToPerfDelta]
 *
 * If `offsetInitialized` is false, treats offsetMs as 0 (best effort during
 * NTP bootstrap window).
 */
function validAtToPerfNow(validAt, clock) {
    if (validAt == null || !isFinite(validAt)) return clock.perfNow();
    const offset = clock.offsetInitialized ? clock.offsetMs : 0;
    return validAt - offset + clock.wallToPerfDelta;
}

/**
 * Push a snapshot keyed at validAt (converted to perf.now domain) into a
 * per-object ring buffer. Mirrors RemoteObjects.updateState's core push
 * logic (sans owner-tracking and per-member delay state).
 */
function updateState(state, data, validAt, clock) {
    const time = validAtToPerfNow(validAt, clock);
    const snapshot = {
        data: { ...data },
        time,
        velocity: { x: data.velocityX || 0, y: data.velocityY || 0 },
        rotationSpeed: data.rotationSpeed || 0,
    };
    if (state.snapshots.length > 0) {
        const latest = state.snapshots[state.snapshots.length - 1];
        if (snapshot.time < latest.time) snapshot.time = latest.time;
    }
    state.snapshots.push(snapshot);
    if (state.snapshots.length > 6) state.snapshots.shift();
}

/**
 * Bracket-search interpolation on the validAt-derived perf.now axis.
 * Simplified mirror of _baseInterpolated for tests:
 *   - 0 snapshots → null
 *   - target before snap[0] → clamp to snap[0].data
 *   - target after newest → linear extrapolate by velocity (no wrap)
 *   - between → linear blend (Hermite without tangent terms — sufficient
 *     for the axis-correctness assertions in this file)
 */
function getInterpolated(state, renderTime, baseDelay) {
    if (state.snapshots.length === 0) return null;
    const targetTime = renderTime - baseDelay;
    const snaps = state.snapshots;
    if (targetTime <= snaps[0].time) return { ...snaps[0].data };
    const latest = snaps[snaps.length - 1];
    if (targetTime >= latest.time) {
        const dtSec = (targetTime - latest.time) / 1000;
        return {
            ...latest.data,
            x: (latest.data.x || 0) + (latest.velocity.x || 0) * dtSec,
            y: (latest.data.y || 0) + (latest.velocity.y || 0) * dtSec,
        };
    }
    // Between bracketing snapshots: linear blend (no Hermite for this test)
    for (let i = snaps.length - 2; i >= 0; i--) {
        if (snaps[i].time <= targetTime && targetTime < snaps[i + 1].time) {
            const span = snaps[i + 1].time - snaps[i].time;
            const t = span > 0 ? (targetTime - snaps[i].time) / span : 0;
            return {
                ...snaps[i].data,
                x: (snaps[i].data.x || 0) + ((snaps[i + 1].data.x || 0) - (snaps[i].data.x || 0)) * t,
                y: (snaps[i].data.y || 0) + ((snaps[i + 1].data.y || 0) - (snaps[i].data.y || 0)) * t,
            };
        }
    }
    return { ...snaps[0].data };
}

/**
 * Mirror of RemoteObjects.getMigrationSeed (latest snapshot extrapolated
 * to "now" in server time). Used when ownership migrates to a new owner —
 * the new owner's first authored snapshot should match what every observer
 * was already extrapolating, so motion remains continuous.
 */
function getMigrationSeed(state, clock) {
    if (state.snapshots.length === 0) return null;
    const latest = state.snapshots[state.snapshots.length - 1];
    const offset = clock.offsetInitialized ? clock.offsetMs : 0;
    const latestValidAt = latest.time - clock.wallToPerfDelta + offset;
    const stalenessSec = (clock.serverNowMs() - latestValidAt) / 1000;
    return {
        ...latest.data,
        x: (latest.data.x || 0) + (latest.velocity.x || 0) * stalenessSec,
        y: (latest.data.y || 0) + (latest.velocity.y || 0) * stalenessSec,
    };
}

// ── Test fixture helpers ──────────────────────────────────────────────────

/**
 * Build a clock fixture with a deterministic perf.now / Date.now relationship.
 * `perfNow` is a free function returning a controllable monotonic value;
 * Date.now is simulated via wallClockNow. wallToPerfDelta = perfNow - wallClockNow.
 */
function makeClock({ offsetMs = 100, wallClockNow = 1_700_000_000_000, perfStart = 5000 }) {
    let perfCursor = perfStart;
    let wallCursor = wallClockNow;
    return {
        offsetMs,
        offsetInitialized: true,
        wallToPerfDelta: perfStart - wallClockNow,
        perfNow: () => perfCursor,
        wallNow: () => wallCursor,
        serverNowMs: function () { return wallCursor + this.offsetMs; },
        // advance both clocks by the same amount of real time
        advance(ms) {
            perfCursor += ms;
            wallCursor += ms;
        },
        // simulate an OS NTP-daemon slewing wall clock without moving perf.now
        slewWall(ms) {
            wallCursor += ms;
            // wallToPerfDelta is intentionally NOT refreshed here — a real
            // ping burst would refresh it; this models the drift window.
        },
        // refresh wallToPerfDelta as if a ping burst just landed
        refreshDelta() {
            this.wallToPerfDelta = perfCursor - wallCursor;
        },
    };
}

function newState() {
    return { snapshots: [] };
}

// ── validAtToPerfNow ──────────────────────────────────────────────────────

test('validAtToPerfNow: zero-offset zero-delta passes through', () => {
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    // delta = 0, offset = 0 → perfNow == validAt
    assert.equal(validAtToPerfNow(1500, clock), 1500);
});

test('validAtToPerfNow: server-ahead offset subtracts to recover wall time', () => {
    // Server clock is 100ms ahead of wall. validAt=1100 (server-time) →
    // wall=1000 → perf=1000+delta.
    const clock = makeClock({ offsetMs: 100, wallClockNow: 1000, perfStart: 5000 });
    // delta = 4000. perf = 1100 - 100 + 4000 = 5000.
    assert.equal(validAtToPerfNow(1100, clock), 5000);
});

test('validAtToPerfNow: server-behind offset adds back to recover wall time', () => {
    // Server is 50ms BEHIND wall. validAt=950 (server-time) → wall=1000.
    const clock = makeClock({ offsetMs: -50, wallClockNow: 1000, perfStart: 5000 });
    // delta = 4000. perf = 950 - (-50) + 4000 = 5000.
    assert.equal(validAtToPerfNow(950, clock), 5000);
});

test('validAtToPerfNow: null/undefined/NaN returns perfNow fallback', () => {
    const clock = makeClock({ offsetMs: 100, wallClockNow: 1000, perfStart: 7777 });
    assert.equal(validAtToPerfNow(null, clock), 7777);
    assert.equal(validAtToPerfNow(undefined, clock), 7777);
    assert.equal(validAtToPerfNow(NaN, clock), 7777);
});

test('validAtToPerfNow: pre-NTP-bootstrap treats offset as 0', () => {
    const clock = makeClock({ offsetMs: 100, wallClockNow: 1000, perfStart: 5000 });
    clock.offsetInitialized = false;
    // delta = 4000, offset treated as 0 → perf = 1100 + 4000 = 5100.
    // (post-init it would be 5000 — caller absorbs the ~offset gap once
    // the first ping burst lands.)
    assert.equal(validAtToPerfNow(1100, clock), 5100);
});

// ── Network-jitter immunity ───────────────────────────────────────────────

test('jitter immunity: late-arriving packet places snap at same time as on-time packet', () => {
    // Two simulated receivers process packets stamped at the SAME validAt
    // but with very different arrival times (network jitter). The
    // snapshot.time on the bracket axis must be IDENTICAL — that's the
    // entire point of the unification.
    const clockA = makeClock({ offsetMs: 100, wallClockNow: 1000, perfStart: 5000 });
    const clockB = makeClock({ offsetMs: 100, wallClockNow: 1000, perfStart: 5000 });
    const stateA = newState();
    const stateB = newState();
    const validAt = 1500;

    // A processes the packet on-time
    updateState(stateA, { x: 0.5, y: 0.5, velocityX: 100, velocityY: 0 }, validAt, clockA);
    // B's packet was delayed by 200ms of jitter (clock advanced before push)
    clockB.advance(200);
    updateState(stateB, { x: 0.5, y: 0.5, velocityX: 100, velocityY: 0 }, validAt, clockB);

    assert.equal(stateA.snapshots[0].time, stateB.snapshots[0].time,
        'jitter must not shift the snapshot key — both receivers anchor at the same perf.now');
});

test('jitter immunity: bracket-rendered position equal across jittered receivers', () => {
    // Two snapshots stamped at validAt=1000, validAt=1100. One receiver
    // gets them on-time; the other gets the second one 150ms late. With
    // the validAt axis, both render the SAME position at the SAME render time.
    const clockA = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const clockB = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const stateA = newState();
    const stateB = newState();
    const baseDelay = 80;

    updateState(stateA, { x: 0.5, velocityX: 200 }, 1000, clockA);
    clockA.advance(100);
    updateState(stateA, { x: 0.7, velocityX: 200 }, 1100, clockA);

    updateState(stateB, { x: 0.5, velocityX: 200 }, 1000, clockB);
    clockB.advance(250); // packet 2 was 150ms late
    updateState(stateB, { x: 0.7, velocityX: 200 }, 1100, clockB);

    // Both receivers render at the same perf.now value.
    const renderTime = 1100;
    const interpA = getInterpolated(stateA, renderTime, baseDelay);
    const interpB = getInterpolated(stateB, renderTime, baseDelay);
    assert.ok(Math.abs(interpA.x - interpB.x) < 1e-9,
        `bracket position must match across jittered receivers: A=${interpA.x} B=${interpB.x}`);
});

// ── Single-snapshot regime: spawn handling without smoother ───────────────

test('single-snap clamp: targetTime before snap[0] returns snap[0].data unchanged', () => {
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const state = newState();
    updateState(state, { x: 0.5, velocityX: 100 }, 1100, clock);
    const baseDelay = 80;
    // renderTime=1100 → targetTime=1020 → before snap[0].time(=1100) → clamp
    const result = getInterpolated(state, 1100, baseDelay);
    assert.equal(result.x, 0.5, 'clamp returns snap[0].data verbatim — no projection');
});

test('single-snap extrapolate: targetTime after snap[0] uses velocity', () => {
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const state = newState();
    updateState(state, { x: 0.5, velocityX: 100 }, 1000, clock);
    const baseDelay = 0;
    // renderTime=1500 → targetTime=1500 → 500ms past snap[0].time(=1000)
    // x = 0.5 + 100 * 0.5 = 50.5
    const result = getInterpolated(state, 1500, baseDelay);
    assert.ok(Math.abs(result.x - 50.5) < 1e-9, `extrapolation: expected ~50.5, got ${result.x}`);
});

test('single-snap then second snap: bracket continues smoothly with no model switch', () => {
    // The crucial regression: in the OLD design the 1→2 snapshot transition
    // required renderError smoothing because the model switched from
    // delay=0 leading-edge to delay=baseDelay buffered. With validAt
    // unification both regimes use delay=baseDelay so there is no switch.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const state = newState();
    const baseDelay = 50;

    updateState(state, { x: 0.5, velocityX: 100 }, 1000, clock);
    // Sample just before snap[1] arrives (1 snap).
    clock.advance(60);
    const before = getInterpolated(state, 1060, baseDelay);

    // Snap[1] lands at validAt=1050 → time=1050. Now we have 2 snaps.
    updateState(state, { x: 0.55, velocityX: 100 }, 1050, clock);
    // Sample at the same renderTime as `before` but post-2nd-snap.
    const after = getInterpolated(state, 1060, baseDelay);

    // Continuity assertion: |after - before| << any model-switch jump
    // would be (in the old design that was ~v · baseDelay = 100 * 0.05 = 5 units).
    assert.ok(Math.abs(after.x - before.x) < 1.0,
        `1→2 transition must be continuous on the validAt axis (delta=${(after.x - before.x).toFixed(4)})`);
});

// ── Migration handoff seed ────────────────────────────────────────────────

test('getMigrationSeed: returns null with no snapshots', () => {
    const clock = makeClock({});
    assert.equal(getMigrationSeed(newState(), clock), null);
});

test('getMigrationSeed: dead-reckons latest snapshot to serverNowMs()', () => {
    const clock = makeClock({ offsetMs: 100, wallClockNow: 1000, perfStart: 5000 });
    const state = newState();
    // validAt=1100 (server-time). Wall=1000, perf=5000.
    updateState(state, { x: 0.4, velocityX: 100 }, 1100, clock);
    // Advance 250ms of real time.
    clock.advance(250);
    // serverNowMs = wall(1250) + offset(100) = 1350.
    // latestValidAt recovered = 5000 - 4000 + 100 = 1100. ✓
    // staleness = (1350 - 1100)/1000 = 0.25s. seed.x = 0.4 + 100*0.25 = 25.4.
    const seed = getMigrationSeed(state, clock);
    assert.ok(Math.abs(seed.x - 25.4) < 1e-9, `expected 25.4, got ${seed.x}`);
});

test('getMigrationSeed continuity: new owner first snap matches observer extrapolation', () => {
    // Construct a scenario: previous owner's last snap lands; some time
    // passes (the previous owner left, migration completes); new owner
    // computes a seed and authors a new snap. From an OBSERVER's
    // perspective, the new snap must match what bracket extrapolation
    // would have predicted.
    const ownerClock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const observerClock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const observerState = newState();

    // Previous owner authors the last snap: validAt=1000, x=0.5, vx=200.
    updateState(observerState, { x: 0.5, velocityX: 200 }, 1000, observerClock);
    // 200ms passes. The previous owner left mid-window; new owner computes seed.
    ownerClock.advance(200);
    observerClock.advance(200);
    // New owner state mirror: just the latest authored snap (received).
    const newOwnerStateMirror = newState();
    updateState(newOwnerStateMirror, { x: 0.5, velocityX: 200 }, 1000, ownerClock);
    const seed = getMigrationSeed(newOwnerStateMirror, ownerClock);

    // New owner authors first snap from the seed at validAt=now.
    const newOwnerValidAt = ownerClock.serverNowMs(); // 1200
    updateState(observerState, seed, newOwnerValidAt, observerClock);

    // Observer renders just before this would have arrived.
    const baseDelay = 50;
    const renderTime = observerClock.perfNow(); // 1200
    const interpolated = getInterpolated(observerState, renderTime, baseDelay);

    // The seed itself is the dead-reckoning of snap[0] forward by 200ms:
    // x = 0.5 + 200 * 0.2 = 40.5. Bracket rendering should land on a
    // value consistent with that extrapolation (delay-back smoothed).
    // We assert the bracket is continuous through the seed: the rendered
    // x lies between snap[0].x and the seed x.
    const seedX = seed.x; // 40.5
    assert.ok(interpolated.x >= 0.5 && interpolated.x <= seedX,
        `bracket rendering during handoff should remain continuous: got ${interpolated.x} (expected in [0.5, ${seedX}])`);
});

// ── wallToPerfDelta drift handling ────────────────────────────────────────

test('wallToPerfDelta drift: small OS NTP slew shifts snapshot key by exactly the slew', () => {
    // If the OS NTP daemon slews Date.now() by Δ while perf.now stays
    // monotonic, validAtToPerfNow output drifts by Δ until refresh. This
    // bounds the drift to one ping refresh interval (~30s) and is the
    // accepted residual term per the design.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const validAt = 1500;
    const before = validAtToPerfNow(validAt, clock);
    // OS slews wall clock forward by 5ms (typical NTP step).
    clock.slewWall(5);
    // delta is now stale: it was perfStart - wallClockNow = 0; now
    // perf.now is unchanged but wall is 5 ms ahead. Re-compute manually:
    // perf = validAt(1500) - 0 + delta(0) = 1500 BEFORE refresh.
    // Same value (function uses cached delta).
    const after = validAtToPerfNow(validAt, clock);
    assert.equal(before, after,
        'before refresh, the cached delta keeps the conversion stable');

    // After refresh, the drift is reflected:
    clock.refreshDelta();
    const refreshed = validAtToPerfNow(validAt, clock);
    assert.equal(refreshed, before - 5,
        'after refresh, the new delta corrects for the wall-clock slew');
});

test('wallToPerfDelta refresh sequence: monotonic snapshot times preserved', () => {
    // Even when wall clock slews and delta is later refreshed, the
    // monotonic-cap in updateState ensures bracket-search invariants hold.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const state = newState();

    updateState(state, { x: 0.5, velocityX: 100 }, 1100, clock);
    clock.advance(50); // 50ms forward
    clock.slewWall(20); // slew wall further forward
    clock.refreshDelta();
    updateState(state, { x: 0.6, velocityX: 100 }, 1150, clock);

    assert.ok(state.snapshots[1].time >= state.snapshots[0].time,
        'monotonic invariant must hold even across delta refresh');
});
