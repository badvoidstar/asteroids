/**
 * Tests for Phase B lag-based adaptive interpolation delay.
 *
 * Mirrors RemoteObjects.recordObjectSample / recomputeAdaptiveDelay so the
 * test exercises the same arithmetic the renderer uses without dragging in
 * the entire game module. The mirror IS the contract: any change to the
 * production code must be reflected here too.
 *
 * Run with:  node --test AstervoidsWeb/adaptive-delay.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const CONFIG = {
    ADAPTIVE_DELAY_MIN: 1000 / 60,
    ADAPTIVE_DELAY_JITTER_MULT: 2,
    ADAPTIVE_DELAY_SMOOTHING: 0.1,
    ADAPTIVE_DELAY_SAMPLES: 30,
    ADAPTIVE_DELAY_MIN_SAMPLES: 5,
    ADAPTIVE_DELAY_NET_FLOOR: 0.5,
    ADAPTIVE_DELAY_NET_SCALE: 4,
    INTERPOLATION_DELAY: 100
};

function createMemberDelay() {
    return {
        packetIntervals: [],
        lagSamples: [],
        computedDelay: CONFIG.INTERPOLATION_DELAY,
        lastServerTimestamp: 0,
        lastValidAt: 0,
        remoteSendInterval: 0
    };
}

function recomputeAdaptiveDelay(ad, rttMs = 0) {
    const minSamples = CONFIG.ADAPTIVE_DELAY_MIN_SAMPLES;
    const useLagBased = ad.lagSamples.length >= minSamples;

    if (useLagBased) {
        const lagMean = ad.lagSamples.reduce((s, v) => s + v, 0) / ad.lagSamples.length;
        const lagVar = ad.lagSamples.reduce((s, v) => s + (v - lagMean) ** 2, 0) / ad.lagSamples.length;
        const lagStddev = Math.sqrt(lagVar);
        let intervalStddev = 0;
        if (ad.packetIntervals.length >= minSamples) {
            const iMean = ad.packetIntervals.reduce((s, v) => s + v, 0) / ad.packetIntervals.length;
            const iVar = ad.packetIntervals.reduce((s, v) => s + (v - iMean) ** 2, 0) / ad.packetIntervals.length;
            intervalStddev = Math.sqrt(iVar);
        }
        const rawDelay = Math.max(CONFIG.ADAPTIVE_DELAY_MIN,
            lagMean + CONFIG.ADAPTIVE_DELAY_JITTER_MULT * lagStddev + intervalStddev);
        ad.computedDelay += CONFIG.ADAPTIVE_DELAY_SMOOTHING * (rawDelay - ad.computedDelay);
        return;
    }

    if (ad.packetIntervals.length >= minSamples) {
        const observedMean = ad.packetIntervals.reduce((s, v) => s + v, 0) / ad.packetIntervals.length;
        const variance = ad.packetIntervals.reduce((s, v) => s + (v - observedMean) ** 2, 0) / ad.packetIntervals.length;
        const stddev = Math.sqrt(variance);

        const mean = ad.remoteSendInterval > 0 ? ad.remoteSendInterval : observedMean;
        const networkFactor = Math.min(1.0,
            CONFIG.ADAPTIVE_DELAY_NET_FLOOR + rttMs / (CONFIG.ADAPTIVE_DELAY_NET_SCALE * mean));
        const rawDelay = Math.max(CONFIG.ADAPTIVE_DELAY_MIN,
            mean * networkFactor + CONFIG.ADAPTIVE_DELAY_JITTER_MULT * stddev);
        ad.computedDelay += CONFIG.ADAPTIVE_DELAY_SMOOTHING * (rawDelay - ad.computedDelay);
    }
}

function recordObjectSample(ad, validAt, arrivalServerTime) {
    if (validAt == null || arrivalServerTime == null) return;
    const lag = arrivalServerTime - validAt;
    if (!Number.isFinite(lag) || lag < 0 || lag > 5000) return;
    ad.lagSamples.push(lag);
    if (ad.lagSamples.length > CONFIG.ADAPTIVE_DELAY_SAMPLES) {
        ad.lagSamples.shift();
    }
    if (ad.lastValidAt > 0) {
        const interval = validAt - ad.lastValidAt;
        if (interval > 0 && interval < 5000) {
            ad.packetIntervals.push(interval);
            if (ad.packetIntervals.length > CONFIG.ADAPTIVE_DELAY_SAMPLES) {
                ad.packetIntervals.shift();
            }
        }
    }
    ad.lastValidAt = validAt;
    recomputeAdaptiveDelay(ad);
}

test('recordObjectSample: warm-up window does not drive lag-based delay', () => {
    const ad = createMemberDelay();
    // Below MIN_SAMPLES (5): computedDelay stays at INTERPOLATION_DELAY default.
    for (let i = 0; i < 4; i++) {
        recordObjectSample(ad, 1000 + i * 50, 1000 + i * 50 + 30);
    }
    assert.equal(ad.computedDelay, CONFIG.INTERPOLATION_DELAY);
});

test('recordObjectSample: zero-jitter LAN converges to lagMean', () => {
    const ad = createMemberDelay();
    // 30 samples, all with lag = 20ms. lagStddev = 0, intervalStddev = 0,
    // so rawDelay = 20 (above ADAPTIVE_DELAY_MIN ≈ 16.67).
    for (let i = 0; i < 30; i++) {
        recordObjectSample(ad, 1000 + i * 50, 1000 + i * 50 + 20);
    }
    // EMA with alpha=0.1 over 30 samples from 100ms toward 20ms.
    // After 30 samples: 100 * (0.9)^25 + 20 * (1 - 0.9^25) ≈ 25.9
    // (first 5 samples don't update because lag-based path requires ≥ 5
    // samples after the push; at sample 5 we have 5 lag samples → 25 updates).
    assert.ok(ad.computedDelay > 20 && ad.computedDelay < 30,
        `computed=${ad.computedDelay} should converge toward 20`);
});

test('recordObjectSample: high jitter raises delay above mean by jitter cushion', () => {
    const ad = createMemberDelay();
    // Alternate lag 10ms and 50ms → mean 30, stddev ≈ 20.
    // rawDelay = 30 + 2*20 + intervalStddev ≈ 70 + small.
    for (let i = 0; i < 30; i++) {
        const lag = (i % 2 === 0) ? 10 : 50;
        recordObjectSample(ad, 1000 + i * 50, 1000 + i * 50 + lag);
    }
    // After convergence the EMA approaches rawDelay ≈ 70+. Min asserts
    // that the cushion is doing work (above bare mean of 30).
    assert.ok(ad.computedDelay > 35,
        `computed=${ad.computedDelay} must reflect jitter cushion (>35)`);
});

test('recordObjectSample: out-of-bounds lag is rejected', () => {
    const ad = createMemberDelay();
    recordObjectSample(ad, 1000, 999);    // negative lag
    recordObjectSample(ad, 1000, 8000);   // > 5000ms ceiling
    recordObjectSample(ad, 1000, null);   // missing arrival
    recordObjectSample(ad, null, 1000);   // missing validAt
    assert.equal(ad.lagSamples.length, 0);
});

test('recordObjectSample: ring buffer caps at ADAPTIVE_DELAY_SAMPLES', () => {
    const ad = createMemberDelay();
    for (let i = 0; i < 100; i++) {
        recordObjectSample(ad, 1000 + i * 50, 1000 + i * 50 + 25);
    }
    assert.equal(ad.lagSamples.length, CONFIG.ADAPTIVE_DELAY_SAMPLES);
    assert.equal(ad.packetIntervals.length, CONFIG.ADAPTIVE_DELAY_SAMPLES);
});

test('recordObjectSample: out-of-order validAt does not record negative interval', () => {
    const ad = createMemberDelay();
    recordObjectSample(ad, 2000, 2030);
    recordObjectSample(ad, 1900, 1930);   // older sample (jitter or NTP slew)
    // lagSample was still recorded (lag = 30, in range)
    assert.equal(ad.lagSamples.length, 2);
    // But packetIntervals only got the first record's "no prior" path.
    assert.equal(ad.packetIntervals.length, 0);
});

test('recordObjectSample: lag-based path beats interval-based once ≥ MIN_SAMPLES', () => {
    const adLag = createMemberDelay();
    const adInterval = createMemberDelay();

    // Same dominant lag signal (80ms server-side queue) into both. The
    // lag-based estimate sees it directly; interval-based only sees the
    // packet spacing (50ms) and is starved of the queue-depth signal.
    for (let i = 0; i < 30; i++) {
        recordObjectSample(adLag, 1000 + i * 50, 1000 + i * 50 + 80);
        adInterval.packetIntervals.push(50);
        recomputeAdaptiveDelay(adInterval, /*rttMs*/ 0);
    }

    // Lag-based converges toward 80; interval-based converges toward 25.
    assert.ok(adLag.computedDelay > adInterval.computedDelay,
        `lag-based (${adLag.computedDelay}) should exceed interval-based (${adInterval.computedDelay}) when lag is the dominant signal`);
});

test('createMemberDelay: starts with empty lagSamples and INTERPOLATION_DELAY default', () => {
    const ad = createMemberDelay();
    assert.deepEqual(ad.lagSamples, []);
    assert.deepEqual(ad.packetIntervals, []);
    assert.equal(ad.computedDelay, CONFIG.INTERPOLATION_DELAY);
    assert.equal(ad.lastValidAt, 0);
});

// ── recordSample gate: synthetic spawn-bridge snapshots must not pollute lag ──

/**
 * Mirror of RemoteObjects.updateState's recordSample gate. Real callers pass
 * `recordSample=false` for bridge snapshots whose validAt is back-projected
 * (`serverNowMs - delay`) — feeding those into recordObjectSample would
 * create a positive feedback loop (lag = delay → raises delay → raises lag).
 */
function updateStateAdaptive(ad, validAt, arrivalServerTime, recordSample = true) {
    if (!recordSample) return;
    recordObjectSample(ad, validAt, arrivalServerTime);
}

test('updateState: recordSample=false skips lag sample (bridge exclusion)', () => {
    const ad = createMemberDelay();
    // Push 10 synthetic bridge snapshots with lag=200 (high jitter pretend)
    for (let i = 0; i < 10; i++) {
        updateStateAdaptive(ad, 1000 + i * 50, 1000 + i * 50 + 200, /*recordSample=*/false);
    }
    assert.equal(ad.lagSamples.length, 0,
        'bridge snapshots must not enter lagSamples');
    assert.equal(ad.computedDelay, CONFIG.INTERPOLATION_DELAY,
        'computedDelay must remain at default with only bridge snapshots');
});

test('updateState: real authority snapshots after bridge still drive convergence', () => {
    const ad = createMemberDelay();
    // 5 bridge snapshots with phantom 500ms lag (excluded)
    for (let i = 0; i < 5; i++) {
        updateStateAdaptive(ad, 1000 + i * 50, 1000 + i * 50 + 500, /*recordSample=*/false);
    }
    // Then 30 real samples with actual lag=15ms
    for (let i = 0; i < 30; i++) {
        updateStateAdaptive(ad, 2000 + i * 50, 2000 + i * 50 + 15, /*recordSample=*/true);
    }
    // Convergence should reflect the REAL 15ms lag, not the synthetic 500ms.
    assert.ok(ad.computedDelay < 50,
        `computedDelay=${ad.computedDelay} must reflect real lag (15), not bridge synthetic (500)`);
});

test('updateState: positive feedback prevented (bridge with delay-derived lag does not inflate delay)', () => {
    const ad = createMemberDelay();
    // Establish baseline: 30 real samples at lag=20.
    for (let i = 0; i < 30; i++) {
        updateStateAdaptive(ad, 1000 + i * 50, 1000 + i * 50 + 20, /*recordSample=*/true);
    }
    const baselineDelay = ad.computedDelay;
    // Simulate 50 spawn-bridge events: each would have stamped lag = current delay.
    for (let i = 0; i < 50; i++) {
        const syntheticLag = ad.computedDelay; // bridgeValidAt = serverNowMs - delay → lag = delay
        updateStateAdaptive(ad, 2000 + i * 50, 2000 + i * 50 + syntheticLag, /*recordSample=*/false);
    }
    assert.equal(ad.computedDelay, baselineDelay,
        'bridge events must not nudge computedDelay (positive feedback prevention)');
});

// ── arrivalServerTime gate: handler-captured time vs game-loop processing time ──

test('arrivalServerTime: handler-captured arrival yields lower lag than game-loop time', () => {
    // Simulate two scenarios:
    //  (a) arrival captured at SignalR event boundary (handler time) — pure network delay
    //  (b) arrival captured in game-loop dispatch — adds frame-pacing jitter
    //
    // Both scenarios send the SAME real network samples (validAt=T, true arrival=T+30).
    // Scenario (b) adds a uniform 8ms game-loop processing delay to every sample.
    const adHandler = createMemberDelay();
    const adGameLoop = createMemberDelay();

    for (let i = 0; i < 30; i++) {
        const validAt = 1000 + i * 50;
        const handlerArrival = validAt + 30;       // true network delay
        const gameLoopArrival = handlerArrival + 8; // +8ms raf jitter
        updateStateAdaptive(adHandler, validAt, handlerArrival, true);
        updateStateAdaptive(adGameLoop, validAt, gameLoopArrival, true);
    }

    // Both converge toward their respective lag means; handler should be ~30,
    // gameLoop should be ~38. The handler-based estimate is consistently lower.
    assert.ok(adHandler.computedDelay < adGameLoop.computedDelay,
        `handler (${adHandler.computedDelay}) must be < gameLoop (${adGameLoop.computedDelay}) — game-loop time inflates the estimate`);
});
