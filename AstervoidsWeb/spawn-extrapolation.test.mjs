/**
 * Tests for RemoteObjects single-snapshot clamping and render-error
 * smoothing of the leading-edge → buffered-interpolation handoff.
 *
 * Run with:  node --test AstervoidsWeb/spawn-extrapolation.test.mjs
 *
 * The pure logic from RemoteObjects.updateState / getInterpolated is mirrored
 * here so the tests are independent of the browser environment. Mirror with
 * AstervoidsWeb/wwwroot/index.html (RemoteObjects).
 *
 * Behaviour verified:
 *  1. Single snapshot uses baseDelay and clamps to snapshot[0].data through
 *     the 1→2 handoff window, avoiding spawn jump-back.
 *  2. Extrapolation (when targetTime > latest.time) remains capped at
 *     MAX_EXTRAPOLATION seconds.
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

            // Single snapshot uses full baseDelay (not delay=0) so targetTime
            // is behind snapshot[0].time during the initial fill and clamps to
            // snapshot[0].data. When snapshot[1] arrives, bracket interpolation
            // continues from the same targetTime formula without jump-back.
            // Catchup ramp still transitions delay from baseDelay·0 to
            // baseDelay while renderError decays.
            let delay;
            if (snapshots.length === 1) {
                delay = this.baseDelay;
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

test('single snapshot: clamps to snap[0].data — bracket-transition-safe (position)', () => {
    const s = makeStore(100);
    const t0 = 1000;
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 2, velocityY: 3, rotationSpeed: 0 }, t0);

    // Contract change: single-snapshot mode now uses delay=baseDelay, so
    // targetTime stays at/before snap[0].time during the initial fill window.
    // This avoids the old forward extrapolation + backward handoff jump.
    const t1 = s.getInterpolated('a', t0 + 1);
    const t50 = s.getInterpolated('a', t0 + 50);
    const t99 = s.getInterpolated('a', t0 + 99);
    assert.equal(t1.x, 0);
    assert.equal(t1.y, 0);
    assert.equal(t50.x, 0);
    assert.equal(t50.y, 0);
    assert.equal(t99.x, 0);
    assert.equal(t99.y, 0);
});

test('single snapshot: clamps to snap[0].data — bracket-transition-safe (rotation)', () => {
    const s = makeStore(100);
    const t0 = 1000;
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0, velocityY: 0, rotationSpeed: 0.01 }, t0);

    const out = s.getInterpolated('a', t0 + 99);
    assert.equal(out.angle, 0);
});

test('extrapolation branch is capped at MAX_EXTRAPOLATION', () => {
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 1, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.1, y: 0, angle: 0, velocityX: 1, rotationSpeed: 0 }, 100);
    s.states.get('a').renderError = null; // exercise pure extrapolation branch
    const out = s.getInterpolated('a', 5100); // targetTime=5000, latest.time=100
    assert.ok(Math.abs(out.x - (0.1 + 1 * CONFIG.MAX_EXTRAPOLATION)) < 1e-9);
});

test('renderError captured on 1→2 transition reflects prev−leadingEdge disagreement', () => {
    // With delay=baseDelay in single-snap mode:
    // prev @t=100 clamps to snap[0].x=0.
    // During renderError capture, `next` is evaluated with progress=0
    // (effective delay=0), so next=snap[1].x=0.06.
    // Expected renderError.x = prev − next = 0 − 0.06 = -0.06.
    const s = makeStore(100);
    // snap[0]: x=0, v=0.4 at t=0
    // snap[1]: x=0.06 (sender accelerated), v=0.5 at t=100
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.06, y: 0, angle: 0, velocityX: 0.5, rotationSpeed: 0 }, 100);
    const state = s.states.get('a');
    assert.ok(state.renderError, 'renderError installed');
    assert.ok(Math.abs(state.renderError.x - (-0.06)) < 1e-9,
        `expected dx=-0.06, got ${state.renderError.x}`);
    assert.equal(state.renderError.startTime, 100);
});

test('renderError captures single-snap clamp → leading-edge handoff under constant velocity', () => {
    // With delay=baseDelay for single-snap:
    // prev @t=100 clamps to snap[0].x=0.
    // next during capture (progress=0) is snap[1].x=0.04.
    // renderError.x = -0.04.
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 100);
    const re = s.states.get('a').renderError;
    assert.ok(re, 'renderError installed');
    assert.ok(Math.abs(re.x - (-0.04)) < 1e-9, `expected dx=-0.04, got ${re.x}`);
    assert.ok(Math.abs(re.y) < 1e-9);
});

test('continuity across handoff: rendered output equals prev-frame extrapolation at progress=0', () => {
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 0);

    const beforeArrival = s.getInterpolated('a', 100); // single-snap output
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 100);
    const justAfter = s.getInterpolated('a', 100);     // smoothed buffered output

    // The whole point of the smoothing: rendered output remains continuous
    // through the model switch.
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
    // Single-snap now clamps at t=100 to snapshot[0].x=0.95.
    // snapshot[1] arrives at x=0.05. Disagreement: 0.95 - 0.05 = 0.9 (> 0.5).
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

test('regression (from PR #87): no spawn jump-back across single-snap → bracket transition', () => {
    // Pre-fix scenario: single-snap with delay=0 extrapolated forward for
    // ~sendInterval ms; bracket regime then rendered at targetTime =
    // renderTime − baseDelay, snapping backward by ~v·sendInterval. The
    // renderError smoother masked this in the wrapped output, but the
    // underlying base path was discontinuous. Post-fix: single-snap uses
    // delay=baseDelay → clamps to snap[0].data → bracket transitions
    // continuously when snap[1] arrives.
    //
    // Setup: parent at v=0.4 normalized/sec, sendInterval=100ms, baseDelay=100.
    // snap[0] arrives at t=50; snap[1] at t=150.
    const s = makeStore(100);
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 50);

    // Render every ms from t=50 to t=200; assert position is monotonically
    // non-decreasing (no backward jump) — this is the property pre-fix
    // violated. Push snap[1] in the middle (at t=150) to cover the transition.
    let prev = s._baseInterpolated(s.states.get('a'), 50).x;
    let snap1Pushed = false;
    for (let t = 51; t <= 200; t += 1) {
        if (!snap1Pushed && t >= 150) {
            s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, 150);
            snap1Pushed = true;
        }
        const cur = s._baseInterpolated(s.states.get('a'), t).x;
        assert.ok(cur >= prev - 1e-9,
            `JUMP-BACK at t=${t} (snap1Pushed=${snap1Pushed}): ${prev} → ${cur}`);
        prev = cur;
    }
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

    // prev (single-snap @t=80 uses baseDelay=50) = 0 + 0.4·(0.08−0.05) = 0.012
    // next (LE from snap[1] @t=80)   = 0.02
    // offset = 0.012 − 0.02 = -0.008  (the smoother absorbs the early-arrival jitter)
    const re = s.states.get('a').renderError;
    assert.ok(Math.abs(re.x - (-0.008)) < 1e-9, `expected jitter offset -0.008, got ${re.x}`);

    // At seam (t=80): rendered = prev = 0.012 (continuity).
    assert.ok(Math.abs(s.getInterpolated('a', 80).x - 0.012) < 1e-9);

    // Mid-window (t=80+150=230): progress=0.5, w=0.5.
    // effectiveDelay = 50·0.5 = 25 → target=205 → extrap from snap[1] for 125ms:
    //   base = 0.02 + 0.4·0.125 = 0.07
    // + offset·w = (-0.008)·0.5 = -0.004
    // → 0.066
    const renderMid = s.getInterpolated('a', 230).x;
    assert.ok(Math.abs(renderMid - 0.066) < 1e-9,
        `expected ramped position 0.066 at mid-window, got ${renderMid}`);
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
    // velocity reduction in steady-state); plus larger offset decay here
    // (offset = -0.06, decay over 300ms contributes +0.2/sec). Net apparent
    // velocity ≈ 0.8·2/3 + 0.2 ≈ 0.73 — still far above stale 0.4.
    const a = s.getInterpolated('a', 150).x;
    const b = s.getInterpolated('a', 250).x;
    const apparentV = (b - a) / 0.1; // 100ms apart, normalized/sec

    assert.ok(apparentV > 0.65,
        `apparent velocity ${apparentV} should reflect snap[1].vel=0.8 (expected ≈0.73), not stale snap[0].vel=0.4`);
    assert.ok(apparentV < 0.8,
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

// ── Phase 2 owner-stamped spawn anchor (eliminates upload-time bias) ─────
//
// With the old design, spawnServerTime = serverTimestamp = hub-entry time:
//   spawnServerTime_OLD = T_collision_owner + upload_time_owner_to_server
// Children would be placed `velocity * upload_time` BEHIND where the
// observer's bracket-renderer was showing the parent.
//
// With the new design, the owner stamps clientSpawnServerTime via their
// own clock-offset estimate at collision detection time:
//   spawnServerTime_NEW = T_collision_owner   (modulo NTP residual)
// The upload_time bias term disappears.

test('phase 2: owner-stamped time eliminates upload-time bias on observer projection', () => {
    // Setup:
    //   T_collision_owner  = 1000 (server time space, owner's clock-corrected)
    //   upload_time        = 30ms (owner→server one-way)
    //   download_time      = 50ms (server→observer one-way)
    //   delay_observer_C   = 100ms per-member buffer
    //   parent vx          = 0.5 normalized/sec
    //
    // OLD behavior (server hub-entry timestamp):
    //   spawnServerTime_OLD = 1000 + 30 = 1030
    //   serverNow_observer  = T_collision_owner + upload + download = 1080
    //   staleness_OLD       = (1080 − 1030 − 100)/1000 = -0.05s
    //   projected_OLD       = 0.5 + 0.5*(-0.05) = 0.475
    //   bracket-render      = parent at server time (1080 − 100) = 980
    //                       = position at 980 = 0.5 + 0.5*(980−1000)/1000 = 0.49
    //   error_OLD           = 0.475 − 0.49 = -0.015 (15 px on 1000px screen)
    //
    // NEW behavior (owner-stamped time):
    //   spawnServerTime_NEW = 1000
    //   staleness_NEW       = (1080 − 1000 − 100)/1000 = -0.02s
    //   projected_NEW       = 0.5 + 0.5*(-0.02) = 0.49
    //   bracket-render      = 0.49
    //   error_NEW           = 0
    //
    // The new path matches bracket-render exactly. Old path lags by
    // velocity * upload_time = 0.015 (the residual jump).
    const data = { x: 0.5, y: 0.5, angle: 0, velocityX: 0.5, velocityY: 0, rotationSpeed: 0 };

    const T_collision_owner = 1000;
    const upload_time_ms = 30;
    const download_time_ms = 50;
    const delay_C_sec = 0.1;
    const serverNow_observer = T_collision_owner + upload_time_ms + download_time_ms;

    const spawnServerTime_OLD = T_collision_owner + upload_time_ms;
    const spawnServerTime_NEW = T_collision_owner;

    const stalenessSec_OLD = computeSpawnStaleness(serverNow_observer, spawnServerTime_OLD, delay_C_sec);
    const stalenessSec_NEW = computeSpawnStaleness(serverNow_observer, spawnServerTime_NEW, delay_C_sec);

    const projected_OLD = projectSpawnDataNoWrap(data, stalenessSec_OLD);
    const projected_NEW = projectSpawnDataNoWrap(data, stalenessSec_NEW);

    // Where the observer's bracket-renderer was showing the parent: at
    // server-time (serverNow − delay_C), translated to position via parent's
    // velocity from its known T_collision spawn point.
    const bracketRenderTimeServerSec = (serverNow_observer / 1000) - delay_C_sec;
    const parentT_collision_sec = T_collision_owner / 1000;
    const bracketRenderPosition = data.x + data.velocityX * (bracketRenderTimeServerSec - parentT_collision_sec);

    // OLD projection has measurable error proportional to upload_time × velocity.
    const error_OLD = Math.abs(projected_OLD.x - bracketRenderPosition);
    const error_NEW = Math.abs(projected_NEW.x - bracketRenderPosition);

    // OLD: ≈ velocity * upload_time = 0.5 * 0.03 = 0.015 normalized.
    assert.ok(Math.abs(error_OLD - 0.5 * 0.03) < 1e-9,
        `OLD error should equal velocity*upload_time, got ${error_OLD}`);
    // NEW: zero (within fp).
    assert.ok(error_NEW < 1e-9,
        `NEW error should be ~0, got ${error_NEW}`);
    // Strict improvement.
    assert.ok(error_NEW < error_OLD,
        `NEW (${error_NEW}) must be strictly better than OLD (${error_OLD})`);
});

test('phase 2: server-side sanity-clamp logic — pure mirror of SessionHub.ReplaceObject', () => {
    // Pure mirror of the C# clamp. Lets us drift-detect if the constants
    // get tweaked on either side without coordinated update.
    const SPAWN_TIME_SANITY_BOUND_MS = 2000;
    function clampSpawnAnchor(clientSpawnServerTime, hubEntryMs) {
        if (clientSpawnServerTime == null) return hubEntryMs;
        if (Math.abs(clientSpawnServerTime - hubEntryMs) > SPAWN_TIME_SANITY_BOUND_MS) {
            return hubEntryMs;
        }
        return clientSpawnServerTime;
    }
    const HUB = 1_000_000;
    // Within bounds: forwarded verbatim.
    assert.equal(clampSpawnAnchor(HUB - 250, HUB), HUB - 250);
    assert.equal(clampSpawnAnchor(HUB + 1500, HUB), HUB + 1500);
    assert.equal(clampSpawnAnchor(HUB - 2000, HUB), HUB - 2000, 'exactly at bound passes');
    assert.equal(clampSpawnAnchor(HUB + 2000, HUB), HUB + 2000, 'exactly at bound passes');
    // Out of bounds: fall back.
    assert.equal(clampSpawnAnchor(HUB - 2001, HUB), HUB);
    assert.equal(clampSpawnAnchor(HUB + 10_000, HUB), HUB);
    // Null: fall back.
    assert.equal(clampSpawnAnchor(null, HUB), HUB);
});

// ── Fractional-stamp regression (MessagePack long? deserialization) ─────
//
// RemoteObjects.serverNowMs() returns Date.now() + offsetMs where offsetMs
// is a fractional EMA value. If we send the raw fractional Number to the
// server's ReplaceObject(long? clientSpawnServerTime), MessagePack-JS
// encodes it as float64 and the server's long? deserializer THROWS — the
// entire ReplaceObject call fails, the asteroid never gets deleted from the
// sync map, and the user observes "asteroids aren't destructible (but
// score still increments)" because score-award is local-immediate while
// asteroid removal depends on the OnObjectReplaced echo.
//
// Fix: round in object-sync.js before sending. This pure-logic test mirrors
// that contract.
test('phase 2: clientSpawnServerTime must be an integer for MessagePack long? compatibility', () => {
    // Mirror of object-sync.js replaceObject's stamping logic.
    function stampClientSpawnServerTime(clockSource) {
        const ready = clockSource && clockSource.initialized && clockSource.initialized();
        return ready ? Math.round(clockSource.nowMs()) : null;
    }

    // Realistic fractional offset (EMA of 237ms target, alpha=0.3, target=240): 237.9
    const fractionalOffset = 237.9;
    const baseDateNow = 1778054297698;
    const clockSource = {
        nowMs: () => baseDateNow + fractionalOffset,    // 1778054297935.9
        initialized: () => true,
    };

    const stamp = stampClientSpawnServerTime(clockSource);
    assert.notEqual(stamp, null, 'stamp returned because clock is initialized');
    assert.equal(Number.isInteger(stamp), true,
        'stamp must be an integer so MessagePack-JS encodes as int64, not float64');
    assert.equal(stamp, Math.round(baseDateNow + fractionalOffset),
        'stamp matches rounded value');

    // Null fallback when clock not initialized.
    const uninit = { nowMs: () => 1778054297935.9, initialized: () => false };
    assert.equal(stampClientSpawnServerTime(uninit), null);

    // Null fallback when clockSource not configured.
    assert.equal(stampClientSpawnServerTime(null), null);
});
