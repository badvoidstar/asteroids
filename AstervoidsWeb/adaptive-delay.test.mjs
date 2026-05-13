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
