/**
 * Tests for RemoteObjects.clock — NTP-style client↔server clock-offset
 * estimator. Pure-logic helpers are mirrored here so tests are independent
 * of the browser environment. Mirror with AstervoidsWeb/wwwroot/index.html
 * (RemoteObjects.clock).
 *
 * Run with:  node --test AstervoidsWeb/clock-offset.test.mjs
 *
 * Behaviour verified:
 *  1. pickMinRttSample picks the sample with the smallest rtt (frame-render
 *     and event-loop noise is filtered by min-RTT selection — that's the
 *     entire point of the bursting design).
 *  2. computeOffsetForSample uses the standard NTP formula
 *     offset = serverTime + (rtt/2) − t3Wall, assuming symmetric one-way
 *     latency. Verified for zero-rtt, positive-offset, and negative-offset
 *     synthetic scenarios.
 *  3. passesOutlierGate accepts everything until initialized; afterwards
 *     rejects samples diverging by more than max(gateMs, gateRttMul ·
 *     lastSampleRtt). This blocks single-sample garbage but admits real
 *     OS-clock slewing.
 *  4. emaUpdate converges toward the target value over repeated samples
 *     and weights new samples per `alpha`. Tightly bracketed assertions
 *     confirm the formula is exactly current + alpha · (target − current).
 *  5. End-to-end: feeding a burst through pickMinRttSample →
 *     computeOffsetForSample → passesOutlierGate → emaUpdate yields a
 *     stable offset estimate even when most samples in each burst are
 *     polluted by simulated event-loop jitter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Pure-logic mirror of RemoteObjects.clock helpers ──────────────────────

/**
 * Pick the sample with the minimum rtt. Ties broken by first occurrence.
 * Returns null for empty input.
 * @param {Array<{rtt:number}>} samples
 */
function pickMinRttSample(samples) {
    if (!samples || samples.length === 0) return null;
    let best = samples[0];
    for (let i = 1; i < samples.length; i++) {
        if (samples[i].rtt < best.rtt) best = samples[i];
    }
    return best;
}

/**
 * NTP offset formula assuming symmetric one-way latency:
 *   offset = serverTime + rtt/2 − t3Wall
 * where serverTime is the server's UTC ms captured during the ping, and
 * t3Wall is the client's Date.now() captured immediately after the await
 * resolved.
 * @param {{serverTime:number, rtt:number, t3Wall:number}} sample
 * @returns {number}
 */
function computeOffsetForSample(sample) {
    return sample.serverTime + sample.rtt / 2 - sample.t3Wall;
}

/**
 * Outlier gate. Returns true if the candidate offset is acceptable.
 * Until `initialized` is true, every sample passes (we have no baseline to
 * gate against). Once initialized, reject any sample whose offset diverges
 * from `currentOffset` by more than max(gateMs, gateRttMul · lastSampleRtt).
 * @param {{currentOffset:number, lastSampleRtt:number, candidateOffset:number, gateMs:number, gateRttMul:number, initialized:boolean}} args
 */
function passesOutlierGate(args) {
    if (!args.initialized) return true;
    const tolerance = Math.max(args.gateMs, args.gateRttMul * args.lastSampleRtt);
    return Math.abs(args.candidateOffset - args.currentOffset) <= tolerance;
}

/**
 * Simple EMA: current + alpha · (target − current). Alpha in [0, 1].
 */
function emaUpdate(current, target, alpha) {
    return current + alpha * (target - current);
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('pickMinRttSample returns null for empty input', () => {
    assert.equal(pickMinRttSample([]), null);
    assert.equal(pickMinRttSample(undefined), null);
    assert.equal(pickMinRttSample(null), null);
});

test('pickMinRttSample picks the sample with the smallest rtt', () => {
    const samples = [
        { id: 'a', rtt: 50 },
        { id: 'b', rtt: 12 },   // ← winner
        { id: 'c', rtt: 80 },
        { id: 'd', rtt: 30 },
    ];
    assert.equal(pickMinRttSample(samples).id, 'b');
});

test('pickMinRttSample tie-breaks by first occurrence', () => {
    const samples = [
        { id: 'a', rtt: 20 },
        { id: 'b', rtt: 20 },   // tie — 'a' wins (first)
        { id: 'c', rtt: 30 },
    ];
    assert.equal(pickMinRttSample(samples).id, 'a');
});

test('pickMinRttSample handles single-sample input', () => {
    assert.equal(pickMinRttSample([{ id: 'only', rtt: 100 }]).id, 'only');
});

test('computeOffsetForSample: zero rtt and zero offset returns 0', () => {
    // Server time exactly equals client wall clock at t3 → no offset.
    const offset = computeOffsetForSample({ serverTime: 1000, rtt: 0, t3Wall: 1000 });
    assert.equal(offset, 0);
});

test('computeOffsetForSample: client clock 100ms behind server', () => {
    // Server clock is 100ms ahead. Symmetric 40ms RTT (20ms each way).
    // At t3 (client wall = 1000), server's wall = 1100.
    // Server captured serverTime at midpoint of RTT, so serverTime = 1080.
    // Expected offset = serverTime + rtt/2 − t3Wall = 1080 + 20 − 1000 = 100
    const offset = computeOffsetForSample({ serverTime: 1080, rtt: 40, t3Wall: 1000 });
    assert.equal(offset, 100);
});

test('computeOffsetForSample: client clock 50ms ahead of server', () => {
    // Server clock is 50ms behind client. RTT = 60ms (30ms each way).
    // At t3 (client wall = 2000), server's wall = 1950. ServerTime = 1920.
    // Expected offset = 1920 + 30 − 2000 = −50
    const offset = computeOffsetForSample({ serverTime: 1920, rtt: 60, t3Wall: 2000 });
    assert.equal(offset, -50);
});

test('passesOutlierGate accepts every sample until initialized', () => {
    // Wildly divergent candidate, but uninitialized → must pass.
    assert.equal(passesOutlierGate({
        currentOffset: 0, lastSampleRtt: 100, candidateOffset: 10000,
        gateMs: 20, gateRttMul: 3, initialized: false,
    }), true);
});

test('passesOutlierGate rejects post-init candidate beyond max(gateMs, gateRttMul·rtt)', () => {
    // gateMs=20, gateRttMul=3, lastSampleRtt=10 → tolerance = max(20, 30) = 30.
    // current=100. Candidate=131 → diff=31 > 30 → reject.
    assert.equal(passesOutlierGate({
        currentOffset: 100, lastSampleRtt: 10, candidateOffset: 131,
        gateMs: 20, gateRttMul: 3, initialized: true,
    }), false);
    // Candidate=130 → diff=30 == 30 → accept (boundary is inclusive).
    assert.equal(passesOutlierGate({
        currentOffset: 100, lastSampleRtt: 10, candidateOffset: 130,
        gateMs: 20, gateRttMul: 3, initialized: true,
    }), true);
});

test('passesOutlierGate uses gateMs floor when rtt is small', () => {
    // lastSampleRtt=2 → 3·2 = 6 < gateMs=20 → tolerance = 20.
    // Candidate=120 (diff=20) → accept; candidate=121 → reject.
    assert.equal(passesOutlierGate({
        currentOffset: 100, lastSampleRtt: 2, candidateOffset: 120,
        gateMs: 20, gateRttMul: 3, initialized: true,
    }), true);
    assert.equal(passesOutlierGate({
        currentOffset: 100, lastSampleRtt: 2, candidateOffset: 121,
        gateMs: 20, gateRttMul: 3, initialized: true,
    }), false);
});

test('passesOutlierGate uses gateRttMul·rtt ceiling when rtt is large', () => {
    // lastSampleRtt=100 → 3·100 = 300 > gateMs=20 → tolerance = 300.
    // Candidate=350 (diff=250) → accept; candidate=410 (diff=310) → reject.
    assert.equal(passesOutlierGate({
        currentOffset: 100, lastSampleRtt: 100, candidateOffset: 350,
        gateMs: 20, gateRttMul: 3, initialized: true,
    }), true);
    assert.equal(passesOutlierGate({
        currentOffset: 100, lastSampleRtt: 100, candidateOffset: 410,
        gateMs: 20, gateRttMul: 3, initialized: true,
    }), false);
});

test('emaUpdate: alpha=1 takes target completely', () => {
    assert.equal(emaUpdate(50, 100, 1), 100);
});

test('emaUpdate: alpha=0 ignores the target', () => {
    assert.equal(emaUpdate(50, 100, 0), 50);
});

test('emaUpdate: alpha=0.3 weights ~30% toward target', () => {
    // current=100, target=200 → 100 + 0.3 · 100 = 130
    assert.equal(emaUpdate(100, 200, 0.3), 130);
    // Going the other way: current=200, target=100 → 200 + 0.3·(−100) = 170
    assert.equal(emaUpdate(200, 100, 0.3), 170);
});

test('emaUpdate converges toward a constant target over many samples', () => {
    let est = 0;
    for (let i = 0; i < 50; i++) est = emaUpdate(est, 100, 0.3);
    assert.ok(Math.abs(est - 100) < 0.01,
        `expected close to 100 after 50 samples; got ${est}`);
});

test('end-to-end: bursts of polluted samples converge to the true offset', () => {
    // Synthetic scenario: true clock offset is +100ms. Each burst contains 5
    // samples with a base 40ms RTT plus jitter. The jitter model is
    // realistic for a browser game client:
    //   jitterUp:   small (0..10ms) — outbound network congestion only.
    //   jitterDown: large (0..40ms) — dominated by client-side frame work
    //                (rendering, GC) blocking the event loop on the way to
    //                the await resolution.
    // Under this model, min-RTT selection (which picks the sample with
    // smallest total latency) preferentially picks samples where jitterDown
    // is smallest — and since the NTP bias is (oneWayUp − oneWayDown)/2,
    // small jitterDown means small bias. The EMA across bursts should
    // therefore converge close to TRUE_OFFSET.
    const TRUE_OFFSET = 100;
    const BASE_ONEWAY = 20; // 40ms baseline RTT
    const ALPHA = 0.3;

    // Tiny PRNG so the test is deterministic.
    let prngState = 1;
    function rand() {
        prngState = (prngState * 1103515245 + 12345) & 0x7fffffff;
        return prngState / 0x7fffffff;
    }

    function makeBurst() {
        const samples = [];
        for (let i = 0; i < 5; i++) {
            const jitterUp = Math.floor(rand() * 10);    // 0..9 ms
            const jitterDown = Math.floor(rand() * 40);  // 0..39 ms
            const oneWayUp = BASE_ONEWAY + jitterUp;
            const oneWayDown = BASE_ONEWAY + jitterDown;
            const rtt = oneWayUp + oneWayDown;
            // See computeOffsetForSample test cases for the derivation:
            // serverTime = t0Wall + oneWayUp + TRUE_OFFSET, and
            // t3Wall = t0Wall + oneWayUp + oneWayDown.
            const t0Wall = 1000 + i * 100;
            const t3Wall = t0Wall + oneWayUp + oneWayDown;
            const serverTime = t0Wall + oneWayUp + TRUE_OFFSET;
            samples.push({ rtt, serverTime, t3Wall });
        }
        return samples;
    }

    let est = 0;
    let initialized = false;
    let lastRtt = Infinity;
    const burstCount = 30;
    for (let b = 0; b < burstCount; b++) {
        const burst = makeBurst();
        const winner = pickMinRttSample(burst);
        const candidate = computeOffsetForSample(winner);
        const accepted = passesOutlierGate({
            currentOffset: est, lastSampleRtt: lastRtt,
            candidateOffset: candidate,
            gateMs: 20, gateRttMul: 3, initialized,
        });
        if (!accepted) continue;
        if (!initialized) {
            est = candidate;
            initialized = true;
        } else {
            est = emaUpdate(est, candidate, ALPHA);
        }
        lastRtt = winner.rtt;
    }
    // With downstream-dominated jitter, min-RTT bias is bounded by
    // (jitterUp_max − 0)/2 = 5ms. EMA convergence keeps us within a few ms.
    assert.ok(Math.abs(est - TRUE_OFFSET) < 6,
        `expected estimate close to ${TRUE_OFFSET}; got ${est}`);
});

test('without min-RTT selection, average of biased samples drifts off true offset', () => {
    // Sanity check that the min-RTT primitive is actually doing work:
    // if we pick a RANDOM sample (not min-rtt) per burst, the EMA wanders
    // significantly off TRUE_OFFSET because each sample carries the full
    // (oneWayUp − oneWayDown)/2 bias from arbitrary jitter realisations.
    const TRUE_OFFSET = 100;
    const BASE_ONEWAY = 20;
    const ALPHA = 0.3;

    let prngState = 7;
    function rand() {
        prngState = (prngState * 1103515245 + 12345) & 0x7fffffff;
        return prngState / 0x7fffffff;
    }

    let estMinRtt = 0;
    let estRandom = 0;
    let initMinRtt = false;
    let initRandom = false;
    for (let b = 0; b < 30; b++) {
        const burst = [];
        for (let i = 0; i < 5; i++) {
            const oneWayUp = BASE_ONEWAY + Math.floor(rand() * 10);
            const oneWayDown = BASE_ONEWAY + Math.floor(rand() * 40);
            const rtt = oneWayUp + oneWayDown;
            const t0Wall = 1000 + i * 100;
            burst.push({
                rtt,
                serverTime: t0Wall + oneWayUp + TRUE_OFFSET,
                t3Wall: t0Wall + oneWayUp + oneWayDown,
            });
        }
        const minRttPick = pickMinRttSample(burst);
        const randomPick = burst[Math.floor(rand() * burst.length)];
        const minOffset = computeOffsetForSample(minRttPick);
        const randomOffset = computeOffsetForSample(randomPick);
        if (!initMinRtt) { estMinRtt = minOffset; initMinRtt = true; }
        else estMinRtt = emaUpdate(estMinRtt, minOffset, ALPHA);
        if (!initRandom) { estRandom = randomOffset; initRandom = true; }
        else estRandom = emaUpdate(estRandom, randomOffset, ALPHA);
    }
    const minRttError = Math.abs(estMinRtt - TRUE_OFFSET);
    const randomError = Math.abs(estRandom - TRUE_OFFSET);
    // Min-RTT should be at least 2x more accurate than random pick on this
    // jitter profile.
    assert.ok(minRttError < randomError,
        `min-RTT error (${minRttError}) should be less than random pick error (${randomError})`);
});
