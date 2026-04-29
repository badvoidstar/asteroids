/**
 * Tests for RemoteObjects single-snapshot extrapolation and catch-up ramp.
 *
 * Run with:  node --test AstervoidsWeb/spawn-extrapolation.test.mjs
 *
 * The pure logic from RemoteObjects.updateState / getInterpolated is mirrored
 * here so the tests are independent of the browser environment. Mirror with
 * AstervoidsWeb/wwwroot/index.html (RemoteObjects).
 *
 * Behaviour verified:
 *  1. Single snapshot, INTERPOLATION_ENABLED → linear extrapolation of x/y from
 *     velocity AND of angle from rotationSpeed. (Position and rotation ride the
 *     same code path; same fix addresses both.)
 *  2. Single snapshot is capped at MAX_EXTRAPOLATION seconds.
 *  3. Adding a second snapshot installs `catchupStart` once (idempotent on
 *     subsequent additions).
 *  4. After 2nd snapshot, effective delay ramps linearly 0 → baseDelay over
 *     SPAWN_CATCHUP_DURATION ms.
 *  5. Past SPAWN_CATCHUP_DURATION, catchupStart is cleared and delay = baseDelay.
 *  6. The handoff at the moment the 2nd snapshot arrives produces no backward
 *     position snap larger than the difference between the actual sender state
 *     and the receiver's velocity-based extrapolation (i.e. no rubber-band from
 *     buffered-delay re-engagement itself).
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
// Stripped-down model: 1×1 reference dim with no wrap, no shouldSnap, no
// member-specific delay. Just enough to exercise the new control flow.

function makeStore(baseDelay) {
    const states = new Map();
    return {
        states,
        baseDelay,

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
                if (existing.snapshots.length === 1 && existing.catchupStart == null) {
                    existing.catchupStart = snapshot.time;
                }
                existing.snapshots.push(snapshot);
                if (existing.snapshots.length > CONFIG.SNAPSHOT_BUFFER_SIZE) {
                    existing.snapshots.shift();
                }
            } else {
                states.set(id, { snapshots: [snapshot], catchupStart: null });
            }
        },

        effectiveDelay(state, renderTime) {
            if (state.snapshots.length === 1) return 0;
            if (state.catchupStart != null) {
                const elapsed = renderTime - state.catchupStart;
                const progress = Math.max(0, Math.min(1, elapsed / CONFIG.SPAWN_CATCHUP_DURATION));
                const delay = this.baseDelay * progress;
                if (progress >= 1) state.catchupStart = null;
                return delay;
            }
            return this.baseDelay;
        },

        getInterpolated(id, renderTime) {
            const state = states.get(id);
            if (!state || state.snapshots.length === 0) return null;
            const snapshots = state.snapshots;
            const latest = snapshots[snapshots.length - 1];
            if (!CONFIG.INTERPOLATION_ENABLED) return latest.data;

            const delay = this.effectiveDelay(state, renderTime);
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
            // Linear blend (Hermite stand-in is fine for these regression checks)
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
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('single snapshot: position dead-reckons forward from broadcast velocity', () => {
    const s = makeStore(100);
    const t0 = 1000;
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 2, velocityY: 3, rotationSpeed: 0 }, t0);

    // 50ms later, with delay=0 we extrapolate by 0.05s
    const out = s.getInterpolated('a', t0 + 50);
    assert.ok(Math.abs(out.x - 2 * 0.05) < 1e-9);
    assert.ok(Math.abs(out.y - 3 * 0.05) < 1e-9);
    // Pre-fix bug: would have returned the spawn position {0,0} for ~baseDelay ms.
});

test('single snapshot: rotation dead-reckons forward from broadcast rotationSpeed', () => {
    const s = makeStore(100);
    const t0 = 1000;
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0, velocityY: 0, rotationSpeed: 0.01 }, t0);

    const out = s.getInterpolated('a', t0 + 100);
    // angle = rotSpeed * TARGET_FPS * extraSeconds = 0.01 * 60 * 0.1
    assert.ok(Math.abs(out.angle - 0.01 * 60 * 0.1) < 1e-9);
});

test('single snapshot: extrapolation is capped at MAX_EXTRAPOLATION', () => {
    const s = makeStore(100);
    const t0 = 0;
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 1, rotationSpeed: 0 }, t0);

    // Far in the future, still capped at 1.0s of motion
    const out = s.getInterpolated('a', t0 + 5000);
    assert.ok(Math.abs(out.x - 1 * CONFIG.MAX_EXTRAPOLATION) < 1e-9);
});

test('catchupStart is set on first 1→2 transition and is idempotent thereafter', () => {
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0 }, 1000);
    assert.equal(s.states.get('a').catchupStart, null);

    s.updateState('a', { x: 1, y: 0, angle: 0 }, 1050);
    assert.equal(s.states.get('a').catchupStart, 1050);

    // Subsequent snapshots must NOT reset catchupStart — it tracks the moment
    // the buffered-delay regime began re-engaging, not the latest snapshot.
    s.updateState('a', { x: 2, y: 0, angle: 0 }, 1100);
    assert.equal(s.states.get('a').catchupStart, 1050);
});

test('catch-up: effective delay ramps linearly 0 → baseDelay over SPAWN_CATCHUP_DURATION', () => {
    const s = makeStore(100); // baseDelay = 100ms
    const t0 = 0;
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0 }, t0);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0 }, t0 + 50);
    const state = s.states.get('a');

    // At catchupStart (t0+50): progress=0 → delay 0
    assert.equal(s.effectiveDelay(state, t0 + 50), 0);
    // Quarter through (75ms after start): progress=0.25 → delay 25
    assert.ok(Math.abs(s.effectiveDelay(state, t0 + 50 + 75) - 25) < 1e-9);
    // Half through: 50ms
    assert.ok(Math.abs(s.effectiveDelay(state, t0 + 50 + 150) - 50) < 1e-9);
});

test('catch-up: past SPAWN_CATCHUP_DURATION, delay equals baseDelay and catchupStart is cleared', () => {
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0 }, 0);
    s.updateState('a', { x: 0, y: 0, angle: 0 }, 50);
    const state = s.states.get('a');

    // Just past the catchup window (50 + 300 + 1)
    assert.equal(s.effectiveDelay(state, 351), 100);
    assert.equal(state.catchupStart, null, 'catchupStart cleared once progress reaches 1');

    // Steady state: still baseDelay
    assert.equal(s.effectiveDelay(state, 10000), 100);
});

test('handoff: no backward position snap when 2nd snapshot arrives at t==catchupStart (progress=0)', () => {
    // Sender is moving at v=10/sec. Receiver gets snapshot[0] at t=0, then
    // snapshot[1] at t=100ms whose position reflects 100ms of motion.
    const s = makeStore(80); // baseDelay 80ms
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 10, rotationSpeed: 0 }, 0);

    // Just before snapshot[1] arrives, receiver renders extrapolated position
    const beforeArrival = s.getInterpolated('a', 100);
    assert.ok(Math.abs(beforeArrival.x - 10 * 0.1) < 1e-9, 'extrapolated to 1.0 before 2nd snapshot');

    // 2nd snapshot arrives at t=100 reporting the sender's actual position 1.0
    s.updateState('a', { x: 1.0, y: 0, angle: 0, velocityX: 10, rotationSpeed: 0 }, 100);

    // At the exact moment of arrival (renderTime=100, catchupStart=100), progress=0,
    // delay=0, targetTime=100=latest.time → returns latest.data exactly.
    const justAfter = s.getInterpolated('a', 100);
    assert.ok(Math.abs(justAfter.x - 1.0) < 1e-9, 'no jump at handoff when extrapolation tracked sender');
});

test('handoff: backward shift from buffered-delay re-engagement is bounded by baseDelay', () => {
    // Construct a perfectly tracking case: extrapolated x exactly equals snapshot[1].x.
    // After the catch-up window completes, delay = baseDelay, so targetTime lags
    // renderTime by baseDelay. The rendered position then reflects the sender's
    // state baseDelay ms in the past — which is the design intent of buffered
    // interpolation. The catch-up ramp distributes that lag insertion over
    // SPAWN_CATCHUP_DURATION instead of inserting it in one frame.
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 10, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 1.0, y: 0, angle: 0, velocityX: 10, rotationSpeed: 0 }, 100);

    // Sample at frequent intervals across the catch-up window. The rendered
    // x must never DECREASE by more than the per-frame velocity step times some
    // small slack — i.e. forward motion is preserved even though buffered delay
    // is being re-engaged.
    let prev = s.getInterpolated('a', 100).x;
    let maxBackStep = 0;
    for (let t = 100 + 5; t <= 100 + CONFIG.SPAWN_CATCHUP_DURATION + 200; t += 5) {
        const cur = s.getInterpolated('a', t).x;
        if (cur < prev) maxBackStep = Math.max(maxBackStep, prev - cur);
        prev = cur;
    }
    // The ramp slows the rendered velocity but should never reverse it by much.
    // baseDelay/SPAWN_CATCHUP_DURATION = 100/300 ≈ 0.33; per 5ms step the
    // worst-case backward component of 10 units/sec ≈ 0.33*10*0.005 = 0.0167.
    assert.ok(maxBackStep < 0.05, `backward step ${maxBackStep} should be small`);
});
