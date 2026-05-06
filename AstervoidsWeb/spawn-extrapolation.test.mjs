/**
 * Tests for RemoteObjects single-snapshot extrapolation and render-error
 * smoothing of the leading-edge → buffered-interpolation handoff.
 *
 * Run with:  node --test AstervoidsWeb/spawn-extrapolation.test.mjs
 *
 * The pure logic from RemoteObjects.updateState / getInterpolated is mirrored
 * here so the tests are independent of the browser environment. Mirror with
 * AstervoidsWeb/wwwroot/index.html (RemoteObjects).
 *
 * Behaviour verified:
 *  1. Single snapshot → linear extrapolation of x/y from velocity AND of
 *     angle from rotationSpeed. Position and rotation ride the same
 *     extrapolation site; one fix addresses both.
 *  2. Single-snapshot extrapolation is capped at MAX_EXTRAPOLATION seconds.
 *  3. On 1→2 transition, renderError captures the (prevOutput − newOutput)
 *     visual offset so getInterpolated stays continuous across the model
 *     switch (no backward snap).
 *  4. renderError decays linearly to zero over SPAWN_CATCHUP_DURATION ms,
 *     after which it is cleared and the steady-state path is pure buffered
 *     interpolation.
 *  5. Across the entire decay window, rendered position never moves
 *     backward (forward velocity exceeds the offset's per-ms decay rate).
 *  6. Wrap-skip: when the offset suggests a screen-edge teleport (|dx|>0.5
 *     or |dy|>0.5 in normalized coords), renderError is NOT installed —
 *     smoothing across a wrap would slowly drag the object back across the
 *     screen, far worse than just snapping.
 *  7. renderError is captured exactly once per object (1→2 transition);
 *     subsequent snapshots do not overwrite it while it is still active.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const CONFIG = {
    INTERPOLATION_ENABLED: true,
    MAX_EXTRAPOLATION: 1.0,
    SNAPSHOT_BUFFER_SIZE: 6,
    SPAWN_CATCHUP_DURATION: 300,
    TARGET_FPS: 60,
};

// ── Mirror of RemoteObjects internals ─────────────────────────────────────

function makeStore(baseDelay) {
    const states = new Map();
    const store = {
        states,
        baseDelay,

        _baseInterpolated(state, renderTime) {
            const snapshots = state.snapshots;
            const latest = snapshots[snapshots.length - 1];
            if (!CONFIG.INTERPOLATION_ENABLED) return latest.data;

            // While the catchup smoother is active (state.renderError set),
            // ramp the effective delay from 0 (lead from latest snapshot) at
            // progress=0 to baseDelay (bracket regime) at progress=1. This
            // tightens accuracy beneath the smoother during catchup AND
            // guarantees position continuity at the moment renderError clears.
            let delay;
            if (snapshots.length === 1) {
                delay = 0;
            } else if (state.renderError) {
                const elapsed = renderTime - state.renderError.startTime;
                const progress = Math.max(0, Math.min(1, elapsed / CONFIG.SPAWN_CATCHUP_DURATION));
                delay = this.baseDelay * progress;
            } else {
                delay = this.baseDelay;
            }
            const targetTime = renderTime - delay;

            if (targetTime <= snapshots[0].time) return snapshots[0].data;
            if (targetTime >= latest.time) {
                const extra = Math.min((targetTime - latest.time) / 1000, CONFIG.MAX_EXTRAPOLATION);
                return {
                    ...latest.data,
                    x: latest.data.x + latest.velocity.x * extra,
                    y: latest.data.y + latest.velocity.y * extra,
                    angle: latest.data.angle + (latest.rotationSpeed || 0) * CONFIG.TARGET_FPS * extra,
                };
            }
            // Linear blend between bracket snapshots (Hermite stand-in).
            for (let i = snapshots.length - 2; i >= 0; i--) {
                if (targetTime >= snapshots[i].time) {
                    const a = snapshots[i], b = snapshots[i + 1];
                    const t = (targetTime - a.time) / (b.time - a.time);
                    return {
                        ...b.data,
                        x: a.data.x + (b.data.x - a.data.x) * t,
                        y: a.data.y + (b.data.y - a.data.y) * t,
                        angle: a.data.angle + (b.data.angle - a.data.angle) * t,
                    };
                }
            }
            return latest.data;
        },

        getInterpolated(id, renderTime) {
            const state = states.get(id);
            if (!state || state.snapshots.length === 0) return null;
            const result = this._baseInterpolated(state, renderTime);

            if (state.renderError && result) {
                const elapsed = renderTime - state.renderError.startTime;
                const progress = Math.max(0, Math.min(1, elapsed / CONFIG.SPAWN_CATCHUP_DURATION));
                if (progress >= 1) {
                    state.renderError = null;
                } else {
                    const w = 1 - progress;
                    return {
                        ...result,
                        x: result.x + state.renderError.x * w,
                        y: (result.y || 0) + state.renderError.y * w,
                        angle: (result.angle || 0) + state.renderError.angle * w,
                    };
                }
            }
            return result;
        },

        updateState(id, data, time) {
            const snapshot = {
                data: { ...data },
                time,
                velocity: { x: data.velocityX || 0, y: data.velocityY || 0 },
                rotationSpeed: data.rotationSpeed || 0,
            };
            const existing = states.get(id);
            if (existing) {
                const latest = existing.snapshots[existing.snapshots.length - 1];
                if (latest && snapshot.time < latest.time) snapshot.time = latest.time;

                if (existing.snapshots.length === 1 && existing.renderError == null) {
                    const prev = this.getInterpolated(id, snapshot.time);
                    existing.snapshots.push(snapshot);
                    if (existing.snapshots.length > CONFIG.SNAPSHOT_BUFFER_SIZE) existing.snapshots.shift();
                    // Sentinel renderError so _baseInterpolated uses the
                    // catchup-ramp model when computing `next`. Overwritten below.
                    existing.renderError = { x: 0, y: 0, angle: 0, startTime: snapshot.time };
                    const next = this.getInterpolated(id, snapshot.time);
                    if (prev && next && prev.x !== undefined && next.x !== undefined) {
                        const dx = prev.x - next.x;
                        const dy = (prev.y || 0) - (next.y || 0);
                        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
                            existing.renderError = {
                                x: dx, y: dy,
                                angle: (prev.angle || 0) - (next.angle || 0),
                                startTime: snapshot.time,
                            };
                        } else {
                            existing.renderError = null;
                        }
                    } else {
                        existing.renderError = null;
                    }
                    return;
                }
                existing.snapshots.push(snapshot);
                if (existing.snapshots.length > CONFIG.SNAPSHOT_BUFFER_SIZE) existing.snapshots.shift();
            } else {
                states.set(id, { snapshots: [snapshot], renderError: null });
            }
        },
    };
    return store;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('single snapshot: position dead-reckons forward from broadcast velocity', () => {
    const s = makeStore(100);
    const t0 = 1000;
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 2, velocityY: 3, rotationSpeed: 0 }, t0);

    const out = s.getInterpolated('a', t0 + 50);
    assert.ok(Math.abs(out.x - 2 * 0.05) < 1e-9);
    assert.ok(Math.abs(out.y - 3 * 0.05) < 1e-9);
});

test('single snapshot: rotation dead-reckons forward from broadcast rotationSpeed', () => {
    const s = makeStore(100);
    const t0 = 1000;
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0, velocityY: 0, rotationSpeed: 0.01 }, t0);

    const out = s.getInterpolated('a', t0 + 100);
    assert.ok(Math.abs(out.angle - 0.01 * 60 * 0.1) < 1e-9);
});

test('single snapshot: extrapolation is capped at MAX_EXTRAPOLATION', () => {
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 1, rotationSpeed: 0 }, 0);
    const out = s.getInterpolated('a', 5000);
    assert.ok(Math.abs(out.x - 1 * CONFIG.MAX_EXTRAPOLATION) < 1e-9);
});

test('renderError captured on 1→2 transition reflects prev−leadingEdge disagreement', () => {
    // Under the catchup-ramp model, `next` at progress=0 is the leading-edge
    // value at the latest snapshot — i.e. snap[1].x exactly. So renderError.x
    // captures (single-snap extrap from snap[0]) − snap[1].x. For constant
    // velocity this is zero (the smoother has nothing to absorb because the
    // base model is already accurate). Use a scenario where sender velocity
    // changed between snap[0] and snap[1] (e.g. a deflection kick) — then the
    // extrap-from-stale-velocity disagrees with snap[1].x and the smoother
    // captures a real offset.
    const s = makeStore(100);
    // snap[0]: x=0, v=0.4 at t=0
    // snap[1]: x=0.06 (sender accelerated), v=0.5 at t=100
    // prev (single-snap extrap from snap[0] at t=100) = 0 + 0.4*0.1 = 0.04
    // next (LE from snap[1] at t=100) = snap[1].x + v·0 = 0.06
    // Expected renderError.x = 0.04 - 0.06 = -0.02
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.06, y: 0, angle: 0, velocityX: 0.5, rotationSpeed: 0 }, 100);
    const state = s.states.get('a');
    assert.ok(state.renderError, 'renderError installed');
    assert.ok(Math.abs(state.renderError.x - (-0.02)) < 1e-9,
        `expected dx=-0.02, got ${state.renderError.x}`);
    assert.equal(state.renderError.startTime, 100);
});

test('renderError is zero when sender velocity is constant (base model already accurate)', () => {
    // Under the catchup-ramp model, leading-edge from snap[1] at t=snap[1].time
    // equals snap[1].x exactly. For constant velocity, snap[1].x equals
    // (single-snap extrap from snap[0] at t=snap[1].time), so the smoother
    // has no offset to absorb — proof that the underlying base path is now
    // accurate by construction in the constant-velocity case.
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 100);
    const re = s.states.get('a').renderError;
    assert.ok(re, 'renderError installed even when zero');
    assert.ok(Math.abs(re.x) < 1e-9, `expected dx≈0 for constant velocity, got ${re.x}`);
    assert.ok(Math.abs(re.y) < 1e-9);
});

test('continuity across handoff: rendered output equals prev-frame extrapolation at progress=0', () => {
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);

    const beforeArrival = s.getInterpolated('a', 100); // single-snap extrap
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 100);
    const justAfter = s.getInterpolated('a', 100);     // smoothed buffered output

    // The whole point of the smoothing: rendered position must be continuous
    // through the model switch. Pre-fix, justAfter.x would have snapped from
    // 0.04 down to 0 (snapshot[0].x), a backward jump of v·baseDelay.
    assert.ok(Math.abs(justAfter.x - beforeArrival.x) < 1e-9,
        `expected continuity: before=${beforeArrival.x} just-after=${justAfter.x}`);
});

test('renderError decays linearly to zero over SPAWN_CATCHUP_DURATION', () => {
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0, rotationSpeed: 0 }, 100);
    // Force a known renderError so we can check decay independent of motion.
    const state = s.states.get('a');
    state.renderError = { x: 1.0, y: 0, angle: 0, startTime: 100 };

    // At startTime: w=1 → full offset
    assert.ok(Math.abs(s.getInterpolated('a', 100).x - 1.0) < 1e-9);
    // Halfway: w=0.5 → half offset
    assert.ok(Math.abs(s.getInterpolated('a', 100 + 150).x - 0.5) < 1e-9);
    // Past window: cleared, base output (= 0 since velocity 0)
    assert.ok(Math.abs(s.getInterpolated('a', 100 + 301).x - 0) < 1e-9);
    assert.equal(s.states.get('a').renderError, null, 'renderError cleared after window');
});

test('rendered motion never goes backward across the decay window', () => {
    // Constant-velocity sender. After the 1→2 transition, the smoothed output
    // must be monotonically forward (up to floating-point noise) for the
    // entire decay window. Use realistic normalized velocity (0.4 units/sec).
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 100);

    let prev = s.getInterpolated('a', 100).x;
    for (let t = 105; t <= 100 + CONFIG.SPAWN_CATCHUP_DURATION + 100; t += 5) {
        const cur = s.getInterpolated('a', t).x;
        assert.ok(cur >= prev - 1e-9, `backward step at t=${t}: ${prev}→${cur}`);
        prev = cur;
    }
});

test('wrap-skip: large dx (likely screen wrap) does NOT install renderError', () => {
    const s = makeStore(100);
    // Sender wraps from x=0.95 (with velocity moving right) to x=0.05 across the seam.
    // Single-snap extrap at t=100 from snapshot[0](x=0.95, v=10) → 0.95 + 10*0.1 = 1.95 (no wrap in test mirror)
    // snapshot[1] arrives at x=0.05. Disagreement: 1.95 - (clamped to snapshot[0].data x=0.95) = 1.0 — way over 0.5.
    s.updateState('a', { x: 0.95, y: 0, angle: 0, velocityX: 10, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.05, y: 0, angle: 0, velocityX: 10, rotationSpeed: 0 }, 100);
    assert.equal(s.states.get('a').renderError, null,
        'renderError must be skipped for wrap-magnitude offsets');
});

test('renderError installed exactly once: 2→3 snapshot transition does not overwrite', () => {
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 100);
    const original = { ...s.states.get('a').renderError };
    assert.ok(original.x !== undefined, 'baseline renderError installed');

    // 3rd snapshot arrives — must not modify the existing renderError.
    s.updateState('a', { x: 0.08, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 200);
    const after = s.states.get('a').renderError;
    assert.equal(after.x, original.x);
    assert.equal(after.y, original.y);
    assert.equal(after.startTime, original.startTime);
});

test('after renderError clears, steady-state output is pure buffered interpolation', () => {
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 100);
    s.updateState('a', { x: 0.08, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 200);
    s.updateState('a', { x: 0.12, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 300);

    // After the catchup window, render at t=400. baseDelay=100 → targetTime=300 = snapshot[3].time
    // → returns snapshot[3].data = x=0.12.
    const out = s.getInterpolated('a', 400);
    assert.equal(s.states.get('a').renderError, null);
    assert.ok(Math.abs(out.x - 0.12) < 1e-9);
});

// ── Catchup-ramp accuracy tests (proposal (1) from the residual-error plan) ──

test('catchup-ramp: jittered arrivals — rendered tracks sender path closely', () => {
    // Sender broadcasts every 50ms at constant velocity v=0.4 (normalized/sec).
    // Network jitter: snap[1] arrives 30ms early relative to its 100ms cadence.
    // snap[0] at t=0   (sender broadcast 0,   x=0.00)
    // snap[1] at t=80  (sender broadcast at sender-time 100, x=0.02 — but the
    //                   payload x=0.02 is what sender sent; client gets it at t=80)
    // Under the catchup-ramp model during catchup, the smoother is decaying
    // toward leading-edge from the latest snapshot. baseDelay=50.
    const s = makeStore(50);
    const v = 0.4;
    s.updateState('a', { x: 0.00, y: 0, angle: 0, velocityX: v, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.02, y: 0, angle: 0, velocityX: v, rotationSpeed: 0 }, 80);

    // prev (single-snap extrap @t=80) = 0 + 0.4·0.08 = 0.032
    // next (LE from snap[1] @t=80)   = 0.02
    // offset = 0.032 − 0.02 = 0.012  (the smoother absorbs the early-arrival jitter)
    const re = s.states.get('a').renderError;
    assert.ok(Math.abs(re.x - 0.012) < 1e-9, `expected jitter offset 0.012, got ${re.x}`);

    // At seam (t=80): rendered = prev = 0.032 (continuity).
    assert.ok(Math.abs(s.getInterpolated('a', 80).x - 0.032) < 1e-9);

    // Mid-window (t=80+150=230): progress=0.5, w=0.5.
    // effectiveDelay = 50·0.5 = 25 → target=205 → extrap from snap[1] for 125ms:
    //   base = 0.02 + 0.4·0.125 = 0.07
    // + offset·w = 0.012·0.5 = 0.006
    // → 0.076
    const renderMid = s.getInterpolated('a', 230).x;
    assert.ok(Math.abs(renderMid - 0.076) < 1e-9,
        `expected ramped position 0.076 at mid-window, got ${renderMid}`);
});

test('catchup-ramp: acceleration mid-gap — rendered tracks new (snap[1]) velocity', () => {
    // Sender velocity changed between snap[0] and snap[1] (e.g. deflection).
    // snap[0]: x=0,    v=0.4 at t=0
    // snap[1]: x=0.06, v=0.8 at t=100
    // Under the OLD bracket regime, the Hermite tangent at t=0 used the stale
    // snap[0].velocity (0.4), shaping the curve incorrectly. Under the
    // catchup-ramp model the base path leads from snap[1] using snap[1]'s NEW
    // velocity (0.8). Verify the apparent rendered velocity within the
    // catchup window is much closer to 0.8 than to 0.4.
    const s = makeStore(100);
    s.updateState('a', { x: 0,    y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.06, y: 0, angle: 0, velocityX: 0.8, rotationSpeed: 0 }, 100);

    // Sample two points within the catchup window. The ramp also slowly
    // increases effectiveDelay (baseDelay=100, window=300 → factor 1−1/3 = 2/3
    // velocity reduction in steady-state); plus the small offset decay
    // (offset = -0.02, decay over 300ms contributes +0.067/sec). Net apparent
    // velocity ≈ 0.8·2/3 + 0.067 ≈ 0.6 — well above stale 0.4 (= 0.4·2/3 = 0.267).
    const a = s.getInterpolated('a', 150).x;
    const b = s.getInterpolated('a', 250).x;
    const apparentV = (b - a) / 0.1; // 100ms apart, normalized/sec

    assert.ok(apparentV > 0.5,
        `apparent velocity ${apparentV} should reflect snap[1].vel=0.8 (expected ≈0.6), not stale snap[0].vel=0.4 (would give ≈0.27)`);
    assert.ok(apparentV < 0.7,
        `apparent velocity ${apparentV} consistent with the ramp's 2/3 base-velocity factor + offset decay`);
});

test('catchup-ramp: end-of-window continuity — no backward jump when renderError clears', () => {
    // The catchup-ramp model ramps effectiveDelay from 0 → baseDelay over the
    // window. At progress=1, effectiveDelay = baseDelay, exactly matching the
    // post-window bracket regime — so rendered position is continuous when
    // renderError clears. This was the key motivation for the ramp (vs. a
    // pure leading-edge model that would have v·baseDelay backward jump).
    const s = makeStore(100);
    // Constant velocity sender, two snapshots only — post-window output is
    // pure extrapolation from snap[1].
    s.updateState('a', { x: 0,    y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 100);

    // Sample dense around the window-end transition (t=400 = startTime+window)
    // and verify no backward step.
    let prevX = s.getInterpolated('a', 395).x;
    for (let t = 396; t <= 410; t += 1) {
        const cx = s.getInterpolated('a', t).x;
        assert.ok(cx >= prevX - 1e-9,
            `backward step at t=${t} (renderError just cleared): ${prevX} → ${cx}`);
        prevX = cx;
    }
});

test('catchup-ramp: end-of-window continuity holds even with sender acceleration', () => {
    // Same as above but with accelerated sender (snap[1].vel ≠ snap[0].vel).
    // The renderError offset is non-zero in this case, and we must still get
    // continuity at the window end.
    const s = makeStore(100);
    s.updateState('a', { x: 0,    y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.06, y: 0, angle: 0, velocityX: 0.8, rotationSpeed: 0 }, 100);

    let prevX = s.getInterpolated('a', 395).x;
    for (let t = 396; t <= 410; t += 1) {
        const cx = s.getInterpolated('a', t).x;
        assert.ok(cx >= prevX - 1e-9,
            `backward step at t=${t} with acceleration: ${prevX} → ${cx}`);
        prevX = cx;
    }
});

// ── Spawn-position projection (Phase 2 of spawn-latency fix) ──────────────
//
// Pure-logic mirrors of:
//   * RemoteObjects.computeSpawnStaleness (index.html ~line 1709)
//   * RemoteObjects.projectSpawnData      (index.html ~line 1729)
//   * RemoteObjects.spawnAt               (index.html ~line 1761)
//
// Mirror the production helpers exactly so the math under test is the math
// running in browser. Wrap-related helpers (wrapNormalized, wrapMargin*) are
// stubbed to identity here — orthogonal to projection arithmetic, covered by
// the toroidal wrap test below using a fixed pass-through margin.

function computeSpawnStaleness(serverNowMs, spawnServerTime, ownerDelaySec) {
    const elapsedSec = (serverNowMs - spawnServerTime) / 1000;
    const stalenessSec = elapsedSec - ownerDelaySec;
    const cap = CONFIG.MAX_EXTRAPOLATION;
    if (stalenessSec > cap) return cap;
    if (stalenessSec < -cap) return -cap;
    return stalenessSec;
}

function projectSpawnDataNoWrap(data, stalenessSec) {
    if (!stalenessSec) return data;
    const vx = data.velocityX || 0;
    const vy = data.velocityY || 0;
    const rs = data.rotationSpeed || 0;
    return {
        ...data,
        x: data.x + vx * stalenessSec,
        y: data.y + vy * stalenessSec,
        angle: (data.angle || 0) + rs * CONFIG.TARGET_FPS * stalenessSec,
    };
}

test('computeSpawnStaleness: shooter case — locally-owned, ownerDelaySec=0', () => {
    // Spawned at server time 1000. Server now is 1100 (i.e. RTT=100ms).
    // Local owner has no display delay → staleness = 100ms = 0.1s.
    const s = computeSpawnStaleness(1100, 1000, 0);
    assert.equal(s, 0.1);
});

test('computeSpawnStaleness: observer case — per-member-delay subtracted', () => {
    // Spawned at server time 1000. Server now is 1050 (one-way 50ms).
    // Observer's per-member delay for owner = 75ms = 0.075s.
    // staleness = 0.05 − 0.075 = −0.025s (negative — project backward).
    const s = computeSpawnStaleness(1050, 1000, 0.075);
    assert.ok(Math.abs(s - (-0.025)) < 1e-9);
});

test('computeSpawnStaleness: capped at +MAX_EXTRAPOLATION', () => {
    // Wildly stale spawn (e.g. clock not initialized, or 5s clock drift).
    const s = computeSpawnStaleness(6000, 1000, 0);
    assert.equal(s, CONFIG.MAX_EXTRAPOLATION);
});

test('computeSpawnStaleness: capped at −MAX_EXTRAPOLATION', () => {
    // Server time appears to be in the past (clock skew or pathological delay).
    const s = computeSpawnStaleness(0, 5000, 0);
    assert.equal(s, -CONFIG.MAX_EXTRAPOLATION);
});

test('projectSpawnData: zero staleness returns data unchanged', () => {
    const data = { x: 0.5, y: 0.5, angle: 1, velocityX: 0.2, velocityY: 0.3, rotationSpeed: 0.01 };
    const out = projectSpawnDataNoWrap(data, 0);
    assert.equal(out, data);
});

test('projectSpawnData: positive staleness moves position forward by velocity·dt', () => {
    const data = { x: 0.5, y: 0.5, angle: 0, velocityX: 0.2, velocityY: 0.3, rotationSpeed: 0 };
    const out = projectSpawnDataNoWrap(data, 0.1);
    assert.ok(Math.abs(out.x - (0.5 + 0.2 * 0.1)) < 1e-9, `x=${out.x}`);
    assert.ok(Math.abs(out.y - (0.5 + 0.3 * 0.1)) < 1e-9, `y=${out.y}`);
});

test('projectSpawnData: negative staleness moves position backward', () => {
    const data = { x: 0.5, y: 0.5, angle: 0, velocityX: 0.2, velocityY: 0.3, rotationSpeed: 0 };
    const out = projectSpawnDataNoWrap(data, -0.05);
    assert.ok(Math.abs(out.x - (0.5 - 0.2 * 0.05)) < 1e-9, `x=${out.x}`);
    assert.ok(Math.abs(out.y - (0.5 - 0.3 * 0.05)) < 1e-9, `y=${out.y}`);
});

test('projectSpawnData: rotation advances by rotationSpeed·TARGET_FPS·dt', () => {
    const data = { x: 0, y: 0, angle: 0.5, velocityX: 0, velocityY: 0, rotationSpeed: 0.01 };
    const out = projectSpawnDataNoWrap(data, 0.1);
    const expected = 0.5 + 0.01 * CONFIG.TARGET_FPS * 0.1;
    assert.ok(Math.abs(out.angle - expected) < 1e-9, `angle=${out.angle}, expected=${expected}`);
});

test('projectSpawnData: stationary object stays put under any staleness', () => {
    const data = { x: 0.3, y: 0.7, angle: 0, velocityX: 0, velocityY: 0, rotationSpeed: 0 };
    const out = projectSpawnDataNoWrap(data, 0.5);
    assert.equal(out.x, 0.3);
    assert.equal(out.y, 0.7);
});

test('integration: shooter sees children spawn at parent\'s last visible position', () => {
    // Scenario: shooter shoots an asteroid at server time 1000. Parent was
    // moving at vx=0.4 normalized/sec. RTT to server is 120ms (echo arrives
    // at server time 1120). Child data carries the parent's position at
    // T_collision (data.x = 0.5).
    //
    // After projection (Option 1, ownerDelaySec=0 for locally-owned):
    //   staleness = (1120 − 1000)/1000 = 0.12s
    //   spawn_x = 0.5 + 0.4 × 0.12 = 0.548
    //
    // This MUST equal where the shooter's local sim of the parent had moved
    // to in 120ms = 0.5 + 0.4 × 0.12 = 0.548. ✓
    const data = { x: 0.5, y: 0.5, angle: 0, velocityX: 0.4, velocityY: 0, rotationSpeed: 0 };
    const stalenessSec = computeSpawnStaleness(1120, 1000, 0);
    const projected = projectSpawnDataNoWrap(data, stalenessSec);
    const parentLocalSimAfter120ms = 0.5 + 0.4 * 0.12;
    assert.ok(Math.abs(projected.x - parentLocalSimAfter120ms) < 1e-9,
        `projected ${projected.x} should match local-sim parent at ${parentLocalSimAfter120ms}`);
});

test('integration: observer with matched delay sees children spawn at bracket-rendered parent position', () => {
    // Scenario: observer sees the shooter's asteroid bracketed at "snapshot
    // time minus per-member delay". Network one-way A→B = 50ms,
    // per-member-delay for A's stream from B's view = 50ms.
    //
    // OnObjectReplaced arrives at B with spawnServerTime=1000, B's serverNow=1050
    // (50ms one-way). data.x = 0.5 (parent's position at T_collision).
    //
    // staleness = (1050 − 1000)/1000 − 0.05 = 0  → child renders at 0.5.
    //
    // What was B rendering parent at? Bracket interp behind by per_member_delay
    // (50ms). For a parent moving at vx=0.4, the freshest snap arrived ~50ms
    // ago and was at "current trajectory minus 50ms". Bracket interp returns
    // that snap's position because target_time = now - delay. So B was
    // rendering parent at 0.5 (the snapshot value). Child appears there. ✓
    const data = { x: 0.5, y: 0.5, angle: 0, velocityX: 0.4, velocityY: 0, rotationSpeed: 0 };
    const stalenessSec = computeSpawnStaleness(1050, 1000, 0.05);
    const projected = projectSpawnDataNoWrap(data, stalenessSec);
    assert.ok(Math.abs(projected.x - 0.5) < 1e-9,
        `projected ${projected.x} should match parent's bracket-rendered position 0.5`);
});

test('integration: observer with delay > network sees backward projection', () => {
    // Observer's per-member delay over-estimates (e.g. delay=100ms but
    // network one-way is 50ms). The observer was rendering the parent BEHIND
    // T_collision in server time. Children must spawn there too.
    //
    // serverNow=1050, spawnServerTime=1000, ownerDelaySec=0.1.
    // staleness = 0.05 − 0.1 = −0.05s.
    // For vx=0.4: projected.x = 0.5 + 0.4·(−0.05) = 0.48.
    //
    // The bracket-rendered parent was at "snap_time + extrap to (now−delay)"
    // = "1000 + (50ms − 100ms)·vx" = 0.5 + 0.4·(−0.05) = 0.48. Match. ✓
    const data = { x: 0.5, y: 0.5, angle: 0, velocityX: 0.4, velocityY: 0, rotationSpeed: 0 };
    const stalenessSec = computeSpawnStaleness(1050, 1000, 0.1);
    const projected = projectSpawnDataNoWrap(data, stalenessSec);
    assert.ok(Math.abs(projected.x - 0.48) < 1e-9, `projected.x=${projected.x}`);
});

test('integration: bootstrap fallback — clock uninitialized → no projection', () => {
    // RemoteObjects.spawnAt skips projection when offsetInitialized is false:
    // it would be worse to project with garbage offset than to ship the
    // unprojected data. This test mirrors that gating in spirit by checking
    // that callers passing stalenessSec=0 get unmodified data.
    const data = { x: 0.5, y: 0.5, angle: 0, velocityX: 0.4, velocityY: 0, rotationSpeed: 0 };
    const out = projectSpawnDataNoWrap(data, 0);
    assert.equal(out.x, 0.5);
    assert.equal(out.y, 0.5);
});
