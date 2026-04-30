/**
 * Tests for the NTP-style min-offset clock estimator (Plan 2).
 *
 * Run with:  node --test AstervoidsWeb/ntp-alignment.test.mjs
 *
 * This file mirrors the NtpClock object from index.html and the
 * USE_NTP_ALIGNMENT-gated paths of RemoteObjects so the tests are
 * independent of the browser environment.
 *
 * Behaviour verified:
 *  1. Min-offset selection: feeding (rtt, offset) samples returns the
 *     offset paired with the minimum rtt (NTP "best sample" heuristic).
 *  2. Sample window: old samples are evicted once the window is full.
 *  3. Slewing: when the active sample changes by Δ, the effective offset
 *     moves linearly toward the new value over the slew window and never
 *     reverses direction mid-slew (no overshoot).
 *  4. serverToLocal mapping: converts server epoch-ms to client
 *     performance.now()-domain using the active offset.
 *  5. End-to-end with USE_NTP_ALIGNMENT=true: a freshly spawned entity
 *     whose first snapshot's senderTimestampMs is ~baseDelay ms in the
 *     past renders without the 1→2 transition discontinuity that
 *     renderError was introduced to mask.
 *  6. Fallback: when no samples have been collected, serverToLocal()
 *     returns null and arrivalTime is used unchanged.
 *  7. renderError path is inactive when USE_NTP_ALIGNMENT=true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── NtpClock mirror ──────────────────────────────────────────────────────────

const NTP_SAMPLE_WINDOW = 16;
const NTP_SLEW_WINDOW   = 200;

/**
 * Create a fresh NtpClock instance (mirrors index.html NtpClock).
 * @param {number} [timeOrigin=0] - Simulated performance.timeOrigin (epoch ms)
 * @param {() => number} [nowFn] - performance.now() source (defaults to a
 *   monotonic counter that callers advance via clock.tick()).
 */
function makeNtpClock(timeOrigin = 0, nowFn = null) {
    let _now = 0;
    const perfNow = nowFn || (() => _now);

    const clock = {
        samples: [],
        slewStart: null,
        slewFrom: null,
        slewTo: null,

        /** Advance the internal mock clock by `ms` milliseconds. */
        tick(ms) { _now += ms; },
        /** Set the internal mock clock to an absolute value. */
        setNow(t) { _now = t; },
        /** Read the mock clock. */
        now() { return perfNow(); },

        addSample(tSendPerf, tRecvPerf, serverTimeMs) {
            const rtt = tRecvPerf - tSendPerf;
            const serverPerf = serverTimeMs - timeOrigin;
            const localOffset = serverPerf - (tSendPerf + tRecvPerf) / 2;

            // Capture the current effective offset BEFORE adding the new sample,
            // so we can detect when the active best sample changes.
            const prevOffset = this.getEffectiveOffset();

            this.samples.push({ rtt, localOffset });
            if (this.samples.length > NTP_SAMPLE_WINDOW) {
                this.samples.shift();
            }

            const best = this._bestSample();
            if (prevOffset !== null && Math.abs(best.localOffset - prevOffset) > 0.5) {
                this.slewStart = tRecvPerf;
                this.slewFrom  = prevOffset;
                this.slewTo    = best.localOffset;
            }
        },

        _bestSample() {
            if (this.samples.length === 0) return null;
            return this.samples.reduce((b, s) => s.rtt < b.rtt ? s : b, this.samples[0]);
        },

        getEffectiveOffset() {
            const best = this._bestSample();
            if (!best) return null;
            if (this.slewStart === null) return best.localOffset;

            const elapsed  = perfNow() - this.slewStart;
            const progress = Math.min(1, elapsed / NTP_SLEW_WINDOW);
            if (progress >= 1) {
                this.slewStart = null;
                return best.localOffset;
            }
            return this.slewFrom + (this.slewTo - this.slewFrom) * progress;
        },

        hasSamples() { return this.samples.length > 0; },

        serverToLocal(senderTimeMs) {
            const offset = this.getEffectiveOffset();
            if (offset === null) return null;
            return (senderTimeMs - timeOrigin) - offset;
        },

        clear() {
            this.samples  = [];
            this.slewStart = null;
            this.slewFrom  = null;
            this.slewTo    = null;
        }
    };
    return clock;
}

// ── RemoteObjects/interpolator mirror ────────────────────────────────────────
// (Simplified version of RemoteObjects from index.html. Only the paths
// exercised by the NTP end-to-end tests are included.)

const CONFIG = {
    INTERPOLATION_ENABLED: true,
    MAX_EXTRAPOLATION: 1.0,
    SNAPSHOT_BUFFER_SIZE: 6,
    SPAWN_CATCHUP_DURATION: 300,
    TARGET_FPS: 60,
};

function makeStore(baseDelay, useNtp) {
    const states = new Map();
    const store = {
        states,
        baseDelay,
        useNtp: useNtp !== undefined ? useNtp : false,

        _baseInterpolated(state, renderTime) {
            const snapshots = state.snapshots;
            const latest    = snapshots[snapshots.length - 1];
            if (!CONFIG.INTERPOLATION_ENABLED) return latest.data;

            let delay;
            if (snapshots.length === 1) {
                // NTP mode: align single-snap with bracket regime to avoid
                // the spawn jump-back when snap[1] arrives.
                delay = this.useNtp ? this.baseDelay : 0;
            } else if (!this.useNtp && state.renderError) {
                const elapsed  = renderTime - state.renderError.startTime;
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

            // renderError is only active when useNtp=false
            if (!this.useNtp && state.renderError && result) {
                const elapsed  = renderTime - state.renderError.startTime;
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
                velocity:      { x: data.velocityX || 0, y: data.velocityY || 0 },
                rotationSpeed: data.rotationSpeed || 0,
            };
            const existing = states.get(id);
            if (existing) {
                const latest = existing.snapshots[existing.snapshots.length - 1];
                if (latest && snapshot.time < latest.time) snapshot.time = latest.time;

                // renderError capture only when not using NTP alignment
                if (!this.useNtp && existing.snapshots.length === 1 && existing.renderError == null) {
                    const prev = this.getInterpolated(id, snapshot.time);
                    existing.snapshots.push(snapshot);
                    if (existing.snapshots.length > CONFIG.SNAPSHOT_BUFFER_SIZE) existing.snapshots.shift();
                    existing.renderError = { x: 0, y: 0, angle: 0, startTime: snapshot.time };
                    const next = this.getInterpolated(id, snapshot.time);
                    if (prev && next && prev.x !== undefined && next.x !== undefined) {
                        const dx = prev.x - next.x;
                        const dy = (prev.y || 0) - (next.y || 0);
                        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
                            existing.renderError = { x: dx, y: dy,
                                angle: (prev.angle || 0) - (next.angle || 0),
                                startTime: snapshot.time };
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

// ── NtpClock tests ────────────────────────────────────────────────────────────

test('min-offset selection: active offset is paired with minimum rtt', () => {
    let _t = 0;
    const c = makeNtpClock(0, () => _t);

    // Add three samples at different rtts; rtt=10 has the lowest latency.
    // We advance _t so that after each sample the slew window elapses,
    // ensuring getEffectiveOffset() reflects the settled best-sample value.
    _t = 20;  c.addSample(0, 20, 15);       // rtt=20, serverPerf=15, mid=10, offset=5
    _t = 300; // advance past any slew triggered above
    _t = 310; c.addSample(300, 310, 307);   // rtt=10, serverPerf=307, mid=305, offset=2; ← min rtt
    _t = 600; // advance past any slew
    _t = 625; c.addSample(610, 625, 620);   // rtt=15, serverPerf=620, mid=617.5, offset=2.5

    // Best sample must have rtt=10
    const best = c._bestSample();
    assert.equal(best.rtt, 10, 'should select sample with minimum rtt=10');

    // Advance well past any slew window so getEffectiveOffset returns the settled value
    _t = 1000;
    assert.ok(Math.abs(c.getEffectiveOffset() - best.localOffset) < 1e-9,
        `effective offset should equal min-rtt sample's offset (${best.localOffset}), got ${c.getEffectiveOffset()}`);
});

test('min-offset selection: ties broken by first-seen order', () => {
    const c = makeNtpClock();
    c.addSample(0, 10, 0 + 10/2 + 5); // rtt=10, offset=5
    c.addSample(0, 10, 0 + 10/2 + 9); // rtt=10, offset=9 — same rtt, added later
    // reduce picks the first minimum it finds, so the first sample with rtt=10 wins
    const best = c._bestSample();
    assert.equal(best.rtt, 10);
    assert.equal(best.localOffset, 5,
        'tie-breaking: first sample with min rtt is preferred (reduce left-fold)');
});

test('sample window eviction: oldest sample is dropped when window is full', () => {
    const c = makeNtpClock();
    for (let i = 0; i < NTP_SAMPLE_WINDOW + 3; i++) {
        c.addSample(0, 10, 0 + 10/2 + i); // offset = i
    }
    assert.equal(c.samples.length, NTP_SAMPLE_WINDOW,
        'window must not exceed NTP_SAMPLE_WINDOW');
});

test('hasSamples() is false before first ping, true after', () => {
    const c = makeNtpClock();
    assert.equal(c.hasSamples(), false);
    c.addSample(0, 10, 5);
    assert.equal(c.hasSamples(), true);
});

test('serverToLocal returns null when no samples collected', () => {
    const c = makeNtpClock(1_700_000_000_000); // realistic timeOrigin
    assert.equal(c.serverToLocal(1_700_000_001_000), null);
});

test('serverToLocal: zero-offset clock maps server epoch to perf domain correctly', () => {
    // timeOrigin = 1000, server and client epoch clocks perfectly aligned (offset=0).
    // serverToLocal(sMs) = sMs - timeOrigin - 0
    const timeOrigin = 1000;
    const c = makeNtpClock(timeOrigin);
    // ping at t=100 → 200, server time = 150 (midpoint, zero offset)
    c.addSample(100, 200, timeOrigin + 150); // serverPerf=150, midpoint=150, offset=0
    assert.ok(Math.abs(c.getEffectiveOffset()) < 1e-9, 'offset should be ~0');
    // senderTimeMs = timeOrigin + 500 → serverToLocal = 500
    assert.ok(Math.abs(c.serverToLocal(timeOrigin + 500) - 500) < 1e-9);
});

test('serverToLocal: server 50ms ahead of client maps correctly', () => {
    // If server is 50ms ahead, serverPerf = clientPerf + 50.
    // offset = serverPerf - clientMid = (clientMid + 50) - clientMid = 50.
    // serverToLocal(sMs) = (sMs - timeOrigin) - offset = serverPerf - 50 = clientPerf.
    const timeOrigin = 0;
    const c = makeNtpClock(timeOrigin);
    // ping at perf 100→200 (rtt=100); server sends at the midpoint (150 client) but
    // the server's clock reads 200 at that moment (server is 50ms ahead):
    c.addSample(100, 200, 200); // serverPerf=200, midpoint=150, offset=50
    assert.ok(Math.abs(c.getEffectiveOffset() - 50) < 1e-9,
        `expected offset=50, got ${c.getEffectiveOffset()}`);
    // senderTimeMs=200 → serverPerf=200 → clientPerf=150 (200-50)
    assert.ok(Math.abs(c.serverToLocal(200) - 150) < 1e-9,
        `expected 150, got ${c.serverToLocal(200)}`);
});

// ── Slewing tests ─────────────────────────────────────────────────────────────

test('slew: no slew triggered for first sample (offset snaps directly)', () => {
    const c = makeNtpClock();
    c.setNow(0);
    c.addSample(0, 10, 0 + 10/2 + 100); // offset=100
    assert.equal(c.slewStart, null, 'no slew for first sample');
    assert.ok(Math.abs(c.getEffectiveOffset() - 100) < 1e-9);
});

test('slew: large offset change triggers slew, reaches target after slew window', () => {
    let _t = 0;
    const c = makeNtpClock(0, () => _t);

    // First sample: offset=0, rtt=10, at perf t=10
    _t = 5;
    c.addSample(0, 10, 5); // serverPerf=5, mid=5, offset=0
    assert.equal(c.slewStart, null, 'no slew for first sample');
    assert.ok(Math.abs(c.getEffectiveOffset() - 0) < 1e-9);

    // Second sample: offset=100 (large jump → slew) at perf t=110, rtt=10
    // For this to become the active sample it needs lower rtt than the first.
    _t = 105;
    c.addSample(100, 110, 5 + 100 + 100); // serverPerf=205, mid=105, offset=100; rtt=10 (tie)
    // Tie — the first sample remains active. To force the new offset to win, use a lower rtt.
    // Let's add a third sample with rtt=5 and offset=100:
    _t = 160;
    c.addSample(158, 163, 5 + 160 + 100); // serverPerf=265, mid=160.5, offset≈104.5; rtt=5
    // Now rtt=5 sample is active with offset≈104.5; previous effective was 0 → slew triggered.
    assert.ok(c.slewStart !== null, 'slew should be triggered');

    // Mid-slew (50% through)
    _t = c.slewStart + NTP_SLEW_WINDOW / 2;
    const midOffset = c.getEffectiveOffset();
    const finalOffset = c.slewTo;
    assert.ok(midOffset > 0 && midOffset < finalOffset,
        `mid-slew offset ${midOffset} should be between 0 and ${finalOffset}`);

    // After slew window
    _t = c.slewStart + NTP_SLEW_WINDOW + 1;
    const postOffset = c.getEffectiveOffset();
    assert.ok(Math.abs(postOffset - finalOffset) < 1e-9,
        `expected offset=${finalOffset} after slew, got ${postOffset}`);
    assert.equal(c.slewStart, null, 'slewStart cleared after completion');
});

test('slew: effective offset moves monotonically from old to new (no reversal)', () => {
    let _t = 0;
    const c = makeNtpClock(0, () => _t);

    // Establish initial offset=0 with rtt=10
    _t = 10; c.addSample(0, 10, 5); // offset=0

    // New best sample with rtt=5 and offset=50 (large enough to trigger slew)
    _t = 20; c.addSample(18, 23, 20.5 + 50); // serverPerf=70.5, mid=20.5, offset=50; rtt=5
    assert.ok(c.slewStart !== null, 'slew triggered');

    const slewStartTime = c.slewStart;
    const from = c.slewFrom;
    const to   = c.slewTo;

    // Sample the effective offset at every 10ms step through the window
    let prev = from;
    for (let elapsed = 0; elapsed <= NTP_SLEW_WINDOW + 10; elapsed += 10) {
        _t = slewStartTime + elapsed;
        const eff = c.getEffectiveOffset();
        const movingUp = to > from;
        if (movingUp) {
            assert.ok(eff >= prev - 1e-9,
                `offset should not decrease (t+${elapsed}): ${prev} → ${eff}`);
        } else {
            assert.ok(eff <= prev + 1e-9,
                `offset should not increase (t+${elapsed}): ${prev} → ${eff}`);
        }
        prev = eff;
    }
});

// ── End-to-end NTP alignment tests ───────────────────────────────────────────

test('e2e NTP: single-snap uses delay=baseDelay (clamped to snap[0]) — no premature extrapolation', () => {
    // With NTP, snap[0].time is anchored to the sender timestamp (in the past
    // by ~OWD). Single-snap mode now uses delay=baseDelay so its behavior is
    // continuous with the bracket regime that follows. At the moment of arrival,
    // targetTime = renderTime - baseDelay is in the past of snap[0].time, so
    // the position is clamped to snap[0].data (no premature extrapolation that
    // would later snap back when snap[1] arrives).

    const timeOrigin = 0;
    let _t = 0;
    const c = makeNtpClock(timeOrigin, () => _t);

    // Zero-offset clock
    _t = 10; c.addSample(0, 10, 5); // serverPerf=5, mid=5, offset=0
    assert.ok(Math.abs(c.getEffectiveOffset()) < 1e-9, 'offset should be ~0');

    const s = makeStore(100, /* useNtp */ true);

    // Server sends at epoch 0; snap[0].time = serverToLocal(0) = 0.
    const snapTime0 = c.serverToLocal(0); // = 0
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, snapTime0);

    // Render at perf=100 (one OWD after server sent). With the fix:
    //   delay = baseDelay = 100, targetTime = 100 - 100 = 0 = snap[0].time
    //   → returns snap[0].data (clamped). x = 0.
    const out = s.getInterpolated('a', 100);
    assert.ok(out !== null);
    assert.ok(Math.abs(out.x - 0) < 1e-9,
        `expected clamped snap[0].x=0, got ${out.x}`);
    assert.equal(s.states.get('a').renderError, null, 'renderError not installed (NTP mode)');
});

test('e2e NTP: spawn jump-back regression — single-snap → bracket transition is monotonic', () => {
    // This is the exact scenario the user reported: a freshly-spawned asteroid
    // (e.g. wave spawn or post-shot split-child) renders during single-snap mode,
    // then snap[1] arrives. Pre-fix: single-snap with delay=0 extrapolated forward
    // ~v·OWD; bracket then rendered at targetTime=renderTime−baseDelay, which
    // corresponded to a position ~v·baseDelay further back → visible JUMP-BACK.
    //
    // Setup: zero-offset clocks; OWD=50ms; sendInterval=100ms; baseDelay=100ms.
    // Server sends snap[0] at server-time 0;   client receives at perf 50.
    // Server sends snap[1] at server-time 100; client receives at perf 150.
    // Velocity 0.4 units/s → snap[1].x = 0.04.

    const timeOrigin = 0;
    let _t = 0;
    const c = makeNtpClock(timeOrigin, () => _t);

    // Zero-offset NTP sample (so serverToLocal(t)=t)
    _t = 10; c.addSample(0, 10, 5);

    const s = makeStore(100, /* useNtp */ true);

    // snap[0] arrives at perf=50; snap[0].time = serverToLocal(0) = 0
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, c.serverToLocal(0));

    // Render every frame from perf=50 (first frame after snap[0]) up to perf=200
    // (50ms after snap[1] arrives). Verify that x is non-decreasing (no jump-back).
    // snap[1] is pushed at perf=150.
    let prev = s.getInterpolated('a', 50).x;
    let snap1Pushed = false;
    for (let perf = 51; perf <= 200; perf += 1) {
        if (!snap1Pushed && perf >= 150) {
            s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, c.serverToLocal(100));
            snap1Pushed = true;
        }
        const cur = s.getInterpolated('a', perf).x;
        assert.ok(cur >= prev - 1e-9,
            `JUMP-BACK at perf=${perf} (snap1Pushed=${snap1Pushed}): ${prev} → ${cur}`);
        prev = cur;
    }
});

test('e2e NTP: 1→2 snapshot transition is continuous without renderError', () => {
    // Server sends snapshot[0] at senderTime=0, snapshot[1] at senderTime=100.
    // With zero offset and timeOrigin=0: snap[0].time=0, snap[1].time=100.
    // baseDelay=100. Render at t=200: targetTime=100 = snap[1].time → exact.
    // Render at t=200-ε: targetTime=100-ε → bracket between snap[0] and snap[1].
    // This should be smooth with no discontinuity (renderError is null).

    const c = makeNtpClock(0, () => 0);
    c.addSample(0, 0, 0); // offset=0

    const s = makeStore(100, /* useNtp */ true);

    // Snap[0]
    const t0 = c.serverToLocal(0);    // = 0
    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, t0);

    // Get position just before snap[1] arrives
    const beforeArrival = s.getInterpolated('a', 100); // single-snap extrap from snap[0]

    // Snap[1] arrives (server time 100ms later)
    const t1 = c.serverToLocal(100);  // = 100
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, t1);

    const justAfter = s.getInterpolated('a', 100);

    // NTP: renderError is NOT installed (use-ntp branch skips capture)
    assert.equal(s.states.get('a').renderError, null,
        'renderError must not be installed in NTP mode');

    // Without renderError, there CAN be a small discontinuity at the 1→2 transition.
    // With sender timestamps, both snapshots are naturally separated by sendInterval in
    // the sender's timeline. The maximum observable jump is v·baseDelay/1000 = 0.04
    // (0.4 units/s × 0.1 s). The threshold 0.1 gives a generous margin that rejects
    // only truly broken discontinuities (e.g. v·RTT-scale jumps from pure arrival-time).
    const delta = Math.abs(justAfter.x - beforeArrival.x);
    assert.ok(delta < 0.1,
        `position jump across 1→2 transition should be small (≤ v·baseDelay = 0.04); got Δx=${delta.toFixed(4)}`);
});

test('e2e NTP: position is continuous across 1→2 transition when sender times are accurate', () => {
    // When NTP offset is exactly right and sender stamps are monotone,
    // the first snapshot lands exactly at (receiveTime - baseDelay).
    // The 1→2 transition then requires NO smoothing because the bracket
    // is already in the right place — the interpolator naturally interpolates.
    //
    // Concretely: sender stamps T=0, T=100 at a 100ms cadence.
    // Client receives them at perf 100, 200 (1 baseDelay after each send).
    // NTP offset ≈ -(client_perf - server_time at midpoint) = 0 if clocks align.
    // snap[0].time = serverToLocal(0) = 0
    // snap[1].time = serverToLocal(100) = 100
    // Render at perf=200, baseDelay=100: targetTime=100=snap[1].time → snap[1].data exactly.

    const c = makeNtpClock(0, () => 0);
    c.addSample(0, 0, 0); // zero offset

    const s = makeStore(100, /* useNtp */ true);

    s.updateState('a', { x: 0, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, c.serverToLocal(0));
    s.updateState('a', { x: 0.04, y: 0, angle: 0, velocityX: 0.4, rotationSpeed: 0 }, c.serverToLocal(100));

    // Render at t=200 (baseDelay after snap[1])
    const out = s.getInterpolated('a', 200);
    // targetTime = 200 - 100 = 100 = snap[1].time → snap[1].data
    assert.ok(Math.abs(out.x - 0.04) < 1e-9,
        `expected x=0.04 (snap[1].data), got ${out.x}`);
    assert.equal(s.states.get('a').renderError, null);
});

test('e2e NTP: single-snapshot fallback (no samples yet) uses arrivalTime', () => {
    // Before any PingTime round-trips, NtpClock.hasSamples()=false.
    // The caller falls back to obj.arrivalTime (performance.now() at receipt).
    // The store should function as the fallback single-snapshot extrapolation path.
    const s = makeStore(100, /* useNtp */ true);

    const arrivalTime = 500; // simulated performance.now() at receipt
    s.updateState('a', { x: 0.1, y: 0.2, angle: 0, velocityX: 0, rotationSpeed: 0 }, arrivalTime);

    const out = s.getInterpolated('a', arrivalTime + 50); // 50ms later, still single-snap
    assert.ok(out !== null);
    assert.ok(Math.abs(out.x - 0.1) < 1e-9, 'should hold position when velocity=0');
});

test('renderError inactive in NTP mode: existing renderError is not applied', () => {
    // Even if renderError were somehow installed (e.g., legacy code path),
    // the NTP-mode getInterpolated must not apply it (useNtp guards the application).
    const s = makeStore(100, /* useNtp */ true);
    s.updateState('a', { x: 0.5, y: 0.5, angle: 0, velocityX: 0, rotationSpeed: 0 }, 0);
    s.updateState('a', { x: 0.5, y: 0.5, angle: 0, velocityX: 0, rotationSpeed: 0 }, 100);

    // Manually inject a renderError (simulating what PR #85 would install)
    const state = s.states.get('a');
    state.renderError = { x: 0.3, y: 0.3, angle: 0, startTime: 100 };

    // In NTP mode the renderError should NOT be applied
    const out = s.getInterpolated('a', 100);
    assert.ok(Math.abs(out.x - 0.5) < 1e-9,
        `NTP mode must ignore renderError; expected x=0.5, got ${out.x}`);
});
