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


// ── Spawn-bridge: parent → child continuity ──────────────────────────────

/**
 * Mirror of the spawn-bridge integration callback in connectToSessionHub.
 *
 * Synthesizes a bridge snapshot (parent's interpolated x/y/angle + child's
 * velocity/identity) and installs both bridge and authority into the child's
 * snapshot ring in monotonic time order.
 *
 * Returns { bridgeData, bridgeValidAt } so tests can assert against the
 * bridge values directly.
 */
function installSpawnBridge(parentState, childState, childData, childValidAt, baseDelay, clock) {
    const renderTime = clock.perfNow();
    const parentInterp = getInterpolated(parentState, renderTime, baseDelay);
    if (!parentInterp) return null;
    const bridgeValidAt = Math.round(clock.serverNowMs() - baseDelay);
    const timeDiffSec = (childValidAt - bridgeValidAt) / 1000;
    const bridgeIsBeforeAuth = bridgeValidAt <= childValidAt;
    // bridgeV serves dual roles:
    //   - back-projection anchor for bridge.x/y from the child's authoritative
    //     COM to where the fragment was at bridge.time;
    //   - bridge snapshot velocity used for Hermite tangent (LAN bracket) and
    //     for extrapolation past the bridge (high-latency).
    const bridgeVx = bridgeIsBeforeAuth
        ? (parentInterp.velocityX || 0)
        : (childData.velocityX || 0);
    const bridgeVy = bridgeIsBeforeAuth
        ? (parentInterp.velocityY || 0)
        : (childData.velocityY || 0);
    // Back-project child's authoritative COM to bridge.time. For DISK
    // children (centroid offset = 0, childData.x ≡ parent.x_at_validAt),
    // this REDUCES TO parentInterp.x exactly. For FRACTURE children
    // (centroid offset ≠ 0, childData.x ≡ parent.x_at_validAt + centroid),
    // the result is parentInterp.x + centroid — the position at which the
    // fragment's polygon (whose vertices already encode the centroid)
    // renders at the SAME world coordinates as before the split.
    const bridgeX = (childData.x || 0) - bridgeVx * timeDiffSec;
    const bridgeY = (childData.y || 0) - bridgeVy * timeDiffSec;
    const isFractureChild = Array.isArray(childData.vertices) && childData.vertices.length > 0;
    const bridgeData = {
        ...childData,
        x: bridgeX,
        y: bridgeY,
        velocityX: bridgeVx,
        velocityY: bridgeVy,
        ...(isFractureChild ? {} : { angle: parentInterp.angle }),
    };
    if (bridgeIsBeforeAuth) {
        // LAN: bridge older than authority — install bridge first.
        updateState(childState, bridgeData, bridgeValidAt, clock);
        updateState(childState, childData, childValidAt, clock);
    } else {
        // High latency: authority older than bridge — install authority first.
        updateState(childState, childData, childValidAt, clock);
        updateState(childState, bridgeData, bridgeValidAt, clock);
    }
    return { bridgeData, bridgeValidAt };
}

test('spawn bridge: LAN case — renderer interpolates from parent_pos to authority_pos', () => {
    // Setup: parent has been moving for 100ms (snap[0] at validAt=900,
    // x=0 vx=100). Renderer is at "now" wall=1000 with baseDelay=50, so
    // targetTime=950 → parent extrapolates to x = 0 + 100 * 0.05 = 5.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const parentState = newState();
    updateState(parentState, { x: 0, velocityX: 100 }, 900, clock);
    const baseDelay = 50;

    // Replace event lands. Authority for child: x=20 (= parent's predicted COM
    // at validAt=1100, since 0 + 100*0.2 = 20 — physically realistic disk
    // child) vx=200, validAt=1100 (collision is in the receiver's near future,
    // classic LAN spawn case).
    const childData = { x: 20, velocityX: 200 };
    const childValidAt = 1100;
    const childState = newState();
    const result = installSpawnBridge(parentState, childState, childData, childValidAt, baseDelay, clock);

    // Bridge must be the OLDER snapshot (LAN case).
    assert.equal(result.bridgeValidAt, 950); // serverNowMs(1000) - 50
    assert.ok(result.bridgeValidAt < childValidAt, 'LAN: bridge older than authority');
    assert.equal(childState.snapshots.length, 2);
    assert.ok(childState.snapshots[0].time < childState.snapshots[1].time,
        'LAN: install order produces monotonic snapshots [bridge, authority]');

    // Bridge.x = back-projected from child.x by parent.vel:
    //   bridge.x = 20 - 100 * (1100-950)/1000 = 20 - 15 = 5 = parent_interp.x.
    // For DISK children this reduces to parent's interpolated position
    // exactly — no regression vs. the old anchor formula.
    assert.equal(childState.snapshots[0].data.x, 5,
        'bridge.x = parent extrapolated position (5) for disk child');

    // Render right after install: targetTime=950 = bridge.time → clamp to bridge.
    const interpAtInstall = getInterpolated(childState, clock.perfNow(), baseDelay);
    assert.equal(interpAtInstall.x, 5, 'just-after-install renderer sits at parent_pos');

    // Advance halfway through the bridge interval and verify smooth interpolation.
    clock.advance(75); // perfNow=1075, targetTime=1025
    const interpMid = getInterpolated(childState, clock.perfNow(), baseDelay);
    // span=150, t=(1025-950)/150=0.5; x = 5 + (20-5)*0.5 = 12.5
    assert.equal(interpMid.x, 12.5, 'midway through bridge interval renderer interpolates linearly');

    // Advance to past authority: should now extrapolate from authority with child_vel.
    clock.advance(100); // perfNow=1175, targetTime=1125
    const interpAfter = getInterpolated(childState, clock.perfNow(), baseDelay);
    // latest=authority at time=1100, x=20 vx=200; extrapolate (1125-1100)/1000=0.025s
    // x = 20 + 200 * 0.025 = 25
    assert.equal(interpAfter.x, 25, 'past authority: extrapolates with child velocity');
});

test('spawn bridge: WITHOUT bridge — control test showing the spawn jump', () => {
    // Same setup as the LAN test, but DON'T install a bridge — just authority.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const baseDelay = 50;

    // Authority: child.x = parent.x_at_validAt = 20 (realistic disk child).
    const childData = { x: 20, velocityX: 200 };
    const childValidAt = 1100;
    const childState = newState();
    updateState(childState, childData, childValidAt, clock);

    // Render right after install: targetTime=950 ≤ snap[0].time=1100 → clamp to authority.
    const interpAtInstall = getInterpolated(childState, clock.perfNow(), baseDelay);
    assert.equal(interpAtInstall.x, 20,
        'WITHOUT bridge, renderer JUMPS to authority position (20) — this is the hitch');
    // Parent was at x=5 just before. With bridge, renderer would be at x=5.
    // Without bridge, renderer is at x=20. That 15-unit discontinuity (in
    // normalized coords; equivalent to parent_vel × (validAt - bridgeValidAt)
    // = 100 × 0.15 = 15) is the visible spawn hitch the bridge fix
    // eliminates for the LAN case.
});

test('spawn bridge: high-latency case — bridge back-projects child position', () => {
    // Parent has been moving (validAt=900, x=0, vx=100). Renderer is now
    // at wall=1300 with baseDelay=50, so targetTime=1250 → parent
    // extrapolates to x = 0 + 100 * 0.35 = 35.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1300, perfStart: 1300 });
    const parentState = newState();
    updateState(parentState, { x: 0, velocityX: 100 }, 900, clock);
    const baseDelay = 50;

    // Replace event lands AFTER the renderer's targetTime: authority validAt=1000
    // (collision happened 250ms ago in server time; high latency / bursty network).
    // child.x = 10 = parent.x_at_validAt(1000) = 0 + 100 * 0.1 (realistic disk child).
    const childData = { x: 10, velocityX: 50 };
    const childValidAt = 1000;
    const childState = newState();
    const result = installSpawnBridge(parentState, childState, childData, childValidAt, baseDelay, clock);

    // Bridge is the NEWER snapshot (high-latency case).
    assert.equal(result.bridgeValidAt, 1250);
    assert.ok(result.bridgeValidAt > childValidAt, 'high-latency: bridge newer than authority');
    assert.equal(childState.snapshots.length, 2);
    assert.ok(childState.snapshots[0].time < childState.snapshots[1].time,
        'high-latency: install order produces monotonic snapshots [authority, bridge]');

    // Bridge.x = back-projected (forward-projected since timeDiff < 0) from child:
    //   bridge.x = 10 - 50 * (1000-1250)/1000 = 10 + 12.5 = 22.5.
    // This is the PHYSICALLY-CORRECT position of the child at bridge.time
    // along its post-collision trajectory. Old anchor (= parent_interp.x = 35)
    // produced a "deferred jerk" when the next regular update landed and
    // forced a backward bracket [35 → child.x_at_t]. The new formula keeps
    // motion physically continuous from bridge.time onward at the cost of
    // one install-time correction (35 → 22.5).
    assert.equal(childState.snapshots[1].data.x, 22.5,
        'bridge.x = back-projected child position (22.5) for high-latency case');

    // Render right after install: targetTime=1250 = bridge.time → clamp to bridge.
    const interpAtInstall = getInterpolated(childState, clock.perfNow(), baseDelay);
    assert.equal(interpAtInstall.x, 22.5,
        'just-after-install renderer sits at back-projected child position');

    // Advance 30ms and verify bridge extrapolates with CHILD'S velocity.
    clock.advance(30); // perfNow=1330, targetTime=1280
    const interpAfter = getInterpolated(childState, clock.perfNow(), baseDelay);
    // latest=bridge at time=1250, x=22.5, velocityX=50 (child's vel, kept in bridgeData)
    // extrapolate (1280-1250)/1000=0.030s → x = 22.5 + 50*0.030 = 24.0
    assert.equal(interpAfter.x, 24,
        'bridge extrapolation uses CHILD velocity (50), not parent velocity (100)');
});

test('spawn bridge: install order preserves both timestamps under monotonic-cap', () => {
    // Verify the LAN case order: bridge installed first means authority's
    // (newer) timestamp is preserved as-is by updateState.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const parentState = newState();
    updateState(parentState, { x: 0, velocityX: 100 }, 900, clock);
    const baseDelay = 50;

    const childData = { x: 20, velocityX: 200 };
    const childValidAt = 1100;
    const childState = newState();
    installSpawnBridge(parentState, childState, childData, childValidAt, baseDelay, clock);

    assert.equal(childState.snapshots.length, 2);
    assert.equal(childState.snapshots[0].time, 950, 'bridge time preserved');
    assert.equal(childState.snapshots[1].time, 1100, 'authority time preserved (no monotonic clamp)');
});

test('spawn bridge: high-latency install order preserves both timestamps', () => {
    // Verify the high-latency case: authority installed first means bridge's
    // (newer) timestamp is preserved.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1300, perfStart: 1300 });
    const parentState = newState();
    updateState(parentState, { x: 0, velocityX: 100 }, 900, clock);
    const baseDelay = 50;

    const childData = { x: 10, velocityX: 50 };
    const childValidAt = 1000;
    const childState = newState();
    installSpawnBridge(parentState, childState, childData, childValidAt, baseDelay, clock);

    assert.equal(childState.snapshots.length, 2);
    assert.equal(childState.snapshots[0].time, 1000, 'authority time preserved');
    assert.equal(childState.snapshots[1].time, 1250, 'bridge time preserved (no monotonic clamp)');
});

test('spawn bridge: skipped when parent has no snapshots (no-parent case)', () => {
    // Edge case: parent never had any snapshots (e.g. spawn-then-immediate-replace,
    // or parent already cleaned up). installSpawnBridge returns null.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const parentState = newState(); // empty
    const childState = newState();
    const result = installSpawnBridge(parentState, childState, { x: 10, velocityX: 100 }, 1100, 50, clock);
    assert.equal(result, null, 'no parent → skip bridge');
    assert.equal(childState.snapshots.length, 0, 'no install when bridge is skipped');
});

test('spawn bridge: simultaneous-time fallback (bridge == authority validAt)', () => {
    // When bridge and authority have the same validAt (e.g. perfectly-zero-latency
    // case — admittedly rare), the LAN-case install order applies (bridge ≤ auth).
    // Both snapshots end up at the same time; bracket-search returns curr.data
    // for the equal-time bracket.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1050, perfStart: 1050 });
    const parentState = newState();
    updateState(parentState, { x: 0, velocityX: 100 }, 1000, clock);
    const baseDelay = 50;

    // Authority validAt = 1000. bridgeValidAt = serverNowMs(1050) - 50 = 1000. EQUAL.
    const childData = { x: 5, velocityX: 200 };
    const childValidAt = 1000;
    const childState = newState();
    installSpawnBridge(parentState, childState, childData, childValidAt, baseDelay, clock);

    assert.equal(childState.snapshots.length, 2);
    assert.equal(childState.snapshots[0].time, 1000);
    assert.equal(childState.snapshots[1].time, 1000);
});

// ── Spawn-bridge: angle handling for fracture vs disk children ────────────

/**
 * Mirror of the production bridge's conditional angle override.
 * Fracture children store vertices already in world-aligned frame (angle=0
 * structurally); disk children inherit parent.angle (polygon regenerated).
 *
 * x/y back-projection is exercised by the installSpawnBridge tests above;
 * this helper is intentionally simplified to focus on the angle conditional.
 */
function buildBridgeData(childData, parentInterp) {
    const isFractureChild = Array.isArray(childData.vertices) && childData.vertices.length > 0;
    return {
        ...childData,
        // x/y omitted here on purpose — back-projection is tested elsewhere.
        ...(isFractureChild ? {} : { angle: parentInterp.angle }),
    };
}

test('spawn bridge: fracture child preserves angle=0 (no double-rotation)', () => {
    // Fracture child: vertices array present, angle=0 structurally because
    // the vertices already carry parent's rotation. The bridge MUST NOT
    // override angle — doing so would double-rotate the rendered polygon
    // for the bridge interval (a visible spawn glitch).
    const childData = {
        x: 10, y: 20, angle: 0, velocityX: 50, velocityY: 0,
        vertices: [{ angle: 0, distance: 1 }, { angle: 1, distance: 1 }, { angle: 2, distance: 1 }],
    };
    const parentInterp = { x: 5, y: 15, angle: 1.234, velocityX: 100 };
    const bridge = buildBridgeData(childData, parentInterp);

    assert.equal(bridge.angle, 0, 'fracture child bridge.angle MUST stay 0 to avoid double-rotation');
    assert.deepEqual(bridge.vertices, childData.vertices, 'vertices passed through');
});

test('spawn bridge: disk child inherits parentInterp.angle for smooth angular continuity', () => {
    // Disk child: no vertices array (polygon regenerated from seed). Its
    // angle = parent.angle at collision. Bridging with parentInterp.angle
    // gives smooth angular continuation matching parent's last-rendered
    // rotation.
    const childData = {
        x: 10, y: 20, angle: 0.8, velocityX: 50, velocityY: 0, seed: 42,
        // no vertices field
    };
    const parentInterp = { x: 5, y: 15, angle: 0.7, velocityX: 100 };
    const bridge = buildBridgeData(childData, parentInterp);

    assert.equal(bridge.angle, 0.7, 'disk child bridge.angle = parentInterp.angle');
    assert.equal(bridge.seed, 42, 'static fields passed through');
});

test('spawn bridge: empty vertices array treated as disk (defensive)', () => {
    // Edge case: vertices: [] (falsy length) → treat as disk so angle
    // override applies. Vertices: undefined → also disk.
    const childData = { x: 10, y: 20, angle: 0.5, vertices: [] };
    const parentInterp = { x: 5, y: 15, angle: 0.9 };
    const bridge = buildBridgeData(childData, parentInterp);
    assert.equal(bridge.angle, 0.9, 'empty vertices array → angle override applies');
});

// ── Fragment-centroid back-projection (the dominant remote-spawn glitch) ──

test('spawn bridge: fracture child position back-projects from child.data along parent velocity', () => {
    // The bug: in splitAsteroid, fracture children have child.data.x =
    // parent.x_at_validAt + fragment_centroid. Vertices are stored in the
    // child-relative frame (centroid at origin, parent rotation pre-applied).
    // The polygon's WORLD vertices are therefore:
    //   world_vertex_i = bridge.x + (vertex_i_local).
    // For visual continuity at bridge.time, the polygon's world vertices
    // must coincide with where they were on the parent — which means
    // bridge.x must equal parent.x_at_bridgeTime + fragment_centroid.
    // The OLD anchor (bridge.x = parent_interp.x) gave bridge.x =
    // parent.x_at_bridgeTime, MISSING the centroid → polygon teleported by
    // -centroid for the first ~3 frames of the bridge interval.
    // The NEW formula (bridge.x = child.x - parent.vel * timeDiff)
    // recovers parent.x_at_bridgeTime + centroid because:
    //   child.x = parent.x_at_validAt + centroid
    //   parent.x_at_validAt - parent.vel * timeDiff = parent.x_at_bridgeTime
    //   ⇒ bridge.x = parent.x_at_bridgeTime + centroid. ✓
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const parentState = newState();
    updateState(parentState, { x: 0, velocityX: 100 }, 900, clock); // parent at validAt=1100: x=20
    const baseDelay = 50; // bridge.time = 950, parent_interp.x = 5

    // Fracture child with centroid offset cx = 3:
    //   child.x = parent.x_at_validAt(1100) + cx = 20 + 3 = 23.
    const childData = {
        x: 23, velocityX: 200,
        vertices: [{ angle: 0, distance: 1 }, { angle: 1, distance: 1 }, { angle: 2, distance: 1 }],
    };
    const childValidAt = 1100;
    const childState = newState();
    installSpawnBridge(parentState, childState, childData, childValidAt, baseDelay, clock);

    // Expected bridge.x = child.x - parent.vel * timeDiff
    //                   = 23 - 100 * 0.15 = 8 = parent_interp.x(5) + centroid(3).
    assert.equal(childState.snapshots[0].data.x, 8,
        'bridge.x must include the fragment centroid offset (parent_interp.x + cx)');
    // Centroid teleport check: with the OLD formula bridge.x would be 5
    // (parent_interp.x), causing the polygon to render at world position
    // 5 + vertex_local instead of 8 + vertex_local — a -3 unit (in
    // normalized coords) teleport for the first ~3 frames of the bridge
    // interval. The new formula eliminates this teleport.
    assert.notEqual(childState.snapshots[0].data.x, 5,
        'NOT the old (parent_interp.x) anchor — that would teleport the polygon by -cx');
});

test('spawn bridge: disk child (centroid=0) bridge.x reduces to parentInterp.x (no regression)', () => {
    // Sanity check: for disk children the centroid offset is zero, so
    // child.x = parent.x_at_validAt and bridge.x = child.x - parent.vel ×
    // timeDiff = parent_interp.x exactly. Same value as the OLD formula.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
    const parentState = newState();
    updateState(parentState, { x: 0, velocityX: 100 }, 900, clock);
    const baseDelay = 50; // parent_interp.x = 5

    // Disk child (no vertices array): child.x = parent.x_at_validAt(1100) = 20.
    const childData = { x: 20, velocityX: 200 };
    const childValidAt = 1100;
    const childState = newState();
    installSpawnBridge(parentState, childState, childData, childValidAt, baseDelay, clock);

    // bridge.x = 20 - 100 * 0.15 = 5 = parent_interp.x. No regression.
    assert.equal(childState.snapshots[0].data.x, 5,
        'disk child: bridge.x reduces to parent_interp.x exactly (no regression)');
});

test('spawn bridge: high-latency case uses child.velocity for back-projection', () => {
    // For high-latency (bridge after auth), the fragment is already on its
    // post-collision trajectory at bridge.time. Forward-projecting along
    // child.vel from authoritative position yields the physically-correct
    // child position at bridge.time.
    const clock = makeClock({ offsetMs: 0, wallClockNow: 1300, perfStart: 1300 });
    const parentState = newState();
    updateState(parentState, { x: 0, velocityX: 100 }, 900, clock);
    const baseDelay = 50; // bridge.time = 1250

    const childData = { x: 10, velocityX: 50 }; // disk: child.x = parent.x_at_1000 = 10
    const childValidAt = 1000;
    const childState = newState();
    installSpawnBridge(parentState, childState, childData, childValidAt, baseDelay, clock);

    // bridge.x = 10 - 50 * (1000-1250)/1000 = 10 + 12.5 = 22.5.
    // Physically-correct: child has been moving at vx=50 for 250ms post-
    // collision, so it's at 10 + 50*0.25 = 22.5 at bridge.time.
    // Bridge snapshot is at index 1 (newer than auth in install order).
    assert.equal(childState.snapshots[1].data.x, 22.5,
        'high-latency: bridge.x uses child.velocity for forward projection');
});

test('spawn bridge: bridge.velocityX = parent.vel for LAN, child.vel for high-latency', () => {
    // Bridge snapshot's velocity drives Hermite tangent (LAN bracket) and
    // extrapolation past bridge (high-latency). LAN should use parent.vel
    // so the tangent matches parent's last-rendered motion; high-latency
    // should use child.vel so the past-bridge extrapolation walks along
    // the authoritative trajectory.

    // LAN case: bridge before auth.
    {
        const clock = makeClock({ offsetMs: 0, wallClockNow: 1000, perfStart: 1000 });
        const parentState = newState();
        updateState(parentState, { x: 0, velocityX: 100 }, 900, clock);
        const childData = { x: 20, velocityX: 200 };
        const childState = newState();
        installSpawnBridge(parentState, childState, childData, 1100, 50, clock);
        // snapshots[0] = bridge (LAN: bridge first)
        assert.equal(childState.snapshots[0].velocity.x, 100,
            'LAN: bridge.velocityX = parent.velocity');
        assert.equal(childState.snapshots[1].velocity.x, 200,
            'LAN: authority.velocityX = child.velocity (unchanged)');
    }
    // High-latency case: bridge after auth.
    {
        const clock = makeClock({ offsetMs: 0, wallClockNow: 1300, perfStart: 1300 });
        const parentState = newState();
        updateState(parentState, { x: 0, velocityX: 100 }, 900, clock);
        const childData = { x: 10, velocityX: 50 };
        const childState = newState();
        installSpawnBridge(parentState, childState, childData, 1000, 50, clock);
        // snapshots[1] = bridge (high-latency: bridge second)
        assert.equal(childState.snapshots[1].velocity.x, 50,
            'high-latency: bridge.velocityX = child.velocity');
        assert.equal(childState.snapshots[0].velocity.x, 50,
            'high-latency: authority.velocityX = child.velocity (unchanged)');
    }
});

// ── Hermite angle short-circuit (fracture-bridge mid-curve glitch) ────────

/**
 * Mirror of the production Hermite angle interp with the equal-angle
 * short-circuit. Verifies that constant-angle endpoints produce a constant
 * rendered angle regardless of tangent (rotationSpeed) values — which is the
 * fracture-bridge case where bridge.angle=auth.angle=0 but rotationSpeed is
 * non-zero (kept for extrapolation past auth).
 */
function hermiteAngle(prev, curr, prevRotSpeed, currRotSpeed, t, timeDiffMs, targetFps = 60) {
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const dt = timeDiffMs / 1000;
    let dAngle = curr - prev;
    while (dAngle > Math.PI) dAngle -= Math.PI * 2;
    while (dAngle < -Math.PI) dAngle += Math.PI * 2;
    if (Math.abs(dAngle) < 1e-6) return curr;
    const a0 = prev;
    const a1 = a0 + dAngle;
    const am0 = (prevRotSpeed || 0) * targetFps * dt;
    const am1 = (currRotSpeed || 0) * targetFps * dt;
    return h00 * a0 + h10 * am0 + h01 * a1 + h11 * am1;
}

test('Hermite angle: fracture bridge (equal angle, non-zero tangent) → constant angle', () => {
    // The 1-frame glitch case: bridge.angle=auth.angle=0, both have child's
    // rotationSpeed (kept for extrapolation past auth). Without short-circuit,
    // Hermite produces ~1.35° spurious deviation at t=0.32, oscillating to
    // -1.35° at t=0.68. With short-circuit, must stay at 0 throughout.
    const rotSpeed = 0.1; // rad/frame, high spin from collision
    for (const t of [0.0, 0.1, 0.32, 0.5, 0.68, 0.9, 1.0]) {
        const a = hermiteAngle(0, 0, rotSpeed, rotSpeed, t, 50);
        assert.strictEqual(a, 0, 'Hermite angle must be 0 for equal-angle endpoints');
    }
});

test('Hermite angle: fracture bridge (any tangent, equal angle non-zero) → constant', () => {
    // Same short-circuit applies if endpoints both equal some non-zero angle
    // (e.g. fracture child rendered after the very first authority refresh).
    const rotSpeed = 0.05;
    const angle = 1.234;
    for (const t of [0.0, 0.32, 0.5, 0.68, 1.0]) {
        const a = hermiteAngle(angle, angle, rotSpeed, rotSpeed, t, 80);
        assert.strictEqual(a, angle, 'Hermite angle must be constant for equal-angle endpoints');
    }
});

test('Hermite angle: disk bridge (small dAngle) STILL uses Hermite (no short-circuit)', () => {
    // Disk children: bridge.angle = parentInterp.angle, auth.angle = parent.angle
    // at split. Difference = parent.rotSpeed * timeDiff. NON-zero, so Hermite
    // applies. Verify we get a value between endpoints.
    const prev = 0.0, curr = 0.06; // 0.02 rad/frame * 60 * 0.05s = 0.06
    const a = hermiteAngle(prev, curr, 0.02, 0.02, 0.32, 50);
    assert.ok(a > 0 && a < curr, 'disk-bridge Hermite returns interpolated value');
});

test('Hermite angle: normal frame-to-frame interp unaffected by short-circuit', () => {
    // Normal interp: ω rad/frame * timeDiff = noticeable dAngle. Hermite
    // applies and reduces to linear when tangents match the slope.
    const dt = 50;
    const omega = 0.02;
    const dAngle = omega * 60 * (dt / 1000); // = 0.06 rad
    const result = hermiteAngle(0, dAngle, omega, omega, 0.5, dt);
    // For pure constant rotation, Hermite reduces to linear at t=0.5 → 0.5 * dAngle
    assert.ok(Math.abs(result - 0.5 * dAngle) < 1e-9, 'Hermite linear-equivalent at t=0.5');
});

test('Hermite angle: equal-angle near zero (epsilon below threshold) short-circuits', () => {
    // dAngle = 1e-7 < 1e-6 threshold → short-circuit fires.
    const a = hermiteAngle(1.0, 1.0 + 1e-7, 0.1, 0.1, 0.32, 50);
    assert.strictEqual(a, 1.0 + 1e-7, 'epsilon-equal angles short-circuit to current');
});