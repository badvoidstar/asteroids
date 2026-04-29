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

            const delay = (snapshots.length === 1) ? 0 : this.baseDelay;
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
                        }
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

test('renderError captured on 1→2 transition matches prev−new disagreement', () => {
    // baseDelay 100. Sender at velocity 0.4 normalized/sec.
    // snapshot[0] at t=0 (x=0, v=0.4). snapshot[1] at t=100 (x=0.04, v=0.4).
    // Prev (single-snap extrap at t=100) = 0 + 0.4*0.1 = 0.04
    // New (with baseDelay=100, targetTime = 100-100 = 0 = snapshot[0].time → returns snapshot[0].data) = 0
    // Expected renderError.x = 0.04 - 0 = 0.04
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 100);
    const state = s.states.get('a');
    assert.ok(state.renderError, 'renderError installed');
    assert.ok(Math.abs(state.renderError.x - 0.04) < 1e-9, `expected dx=0.04, got ${state.renderError.x}`);
    assert.equal(state.renderError.startTime, 100);
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
