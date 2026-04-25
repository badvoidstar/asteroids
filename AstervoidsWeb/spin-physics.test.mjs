/**
 * Regression tests for asteroid spin / rotation distribution after a bullet hit.
 *
 * Run with:  node --test AstervoidsWeb/spin-physics.test.mjs
 *
 * splitAsteroid() supports three spin-distribution models, all sharing the same
 * per-child loop and only differing in how rotationSpeed is computed:
 *
 *   'explosion' : ω_child = ω_parent ± bulletAM / I_child
 *   'merged'    : ω_child = ω_parent ± bulletAM / (2·I_child)
 *   'rigid'     : ω_child = totalAM / totalChildInertia ± bulletAM / (2·I_child)
 *
 * Properties verified across all three models:
 *   1. Mirror symmetry: flipping bullet impulse on a stationary parent negates
 *      both child rotationSpeeds exactly.
 *   2. No monotonic drift: alternating bullet impulses on the surviving larger
 *      fragment produce alternating spin signs, not one-directional growth.
 *
 * Property verified only for 'rigid':
 *   3. Strict angular-momentum conservation: Σ(I·ω) = L_parent + L_bullet exactly.
 *
 * Properties verified only for 'explosion' / 'merged':
 *   4. No inertia amplification: with zero bullet impulse, each child inherits
 *      exactly the parent's rotation rate (rather than ~2× it).
 *
 * Property verified only for 'merged' / 'rigid':
 *   5. Symmetric ±L_b/2 partition: the bullet's angular impulse splits as
 *      +L_bullet/2 on child 0 and −L_bullet/2 on child 1 (regardless of split
 *      ratio). 'explosion' uses full ±L_b magnitude, so it does NOT satisfy this.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Spin-distribution implementations ──────────────────────────────────────
// Mirror the three branches inside splitAsteroid()'s per-child loop in
// AstervoidsWeb/wwwroot/index.html. Keep these in sync with that source.

function distribute(model, omegaParent, I0, I1, Lparent, Lbullet) {
    const Ltotal = Lparent + Lbullet;
    const Itotal = I0 + I1;
    if (model === 'rigid') {
        return [
            Ltotal / Itotal + Lbullet / (2 * I0),
            Ltotal / Itotal - Lbullet / (2 * I1),
        ];
    }
    if (model === 'merged') {
        return [
            omegaParent + Lbullet / (2 * I0),
            omegaParent - Lbullet / (2 * I1),
        ];
    }
    // 'explosion'
    return [
        omegaParent + Lbullet / I0,
        omegaParent - Lbullet / I1,
    ];
}

// ─── Reference geometry ─────────────────────────────────────────────────────
// Use a deliberately asymmetric (35%/65%) split to expose I0 ≠ I1 cases where
// model differences are most visible.
const R     = 0.10;
const frac0 = 0.35;
const r0    = R * Math.sqrt(frac0);
const r1    = R * Math.sqrt(1 - frac0);
const I0    = r0 ** 4;
const I1    = r1 ** 4;
const Itot  = I0 + I1;

const MODELS = ['explosion', 'merged', 'rigid'];

// ─── Test 1: Mirror symmetry (all models) ───────────────────────────────────
for (const model of MODELS) {
    test(`[${model}] mirror symmetry: ±L_b on stationary parent gives exact negatives`, () => {
        const [w0p, w1p] = distribute(model, 0, I0, I1, 0,  1e-4);
        const [w0n, w1n] = distribute(model, 0, I0, I1, 0, -1e-4);
        assert.ok(Math.abs(w0p + w0n) < 1e-15, `child-0: w+=${w0p}, w-=${w0n}`);
        assert.ok(Math.abs(w1p + w1n) < 1e-15, `child-1: w+=${w1p}, w-=${w1n}`);
    });
}

// ─── Test 2: No monotonic drift (all models) ────────────────────────────────
for (const model of MODELS) {
    test(`[${model}] no monotonic drift: alternating hits on the larger child oscillate`, () => {
        let curR = R;
        let curW = 0;
        const HITS = 10;
        const spins = [];
        for (let i = 0; i < HITS; i++) {
            const cr0 = curR * Math.sqrt(frac0);
            const cr1 = curR * Math.sqrt(1 - frac0);
            const cI0 = cr0 ** 4;
            const cI1 = cr1 ** 4;
            const Lp  = curR ** 4 * curW;
            const Lb  = (i % 2 === 0 ? 1 : -1) * 1e-5;
            const [, w1] = distribute(model, curW, cI0, cI1, Lp, Lb);
            curW = w1;
            curR = cr1;
            spins.push(w1);
        }
        const allUp   = spins.every((v, i) => i === 0 || v >= spins[i - 1]);
        const allDown = spins.every((v, i) => i === 0 || v <= spins[i - 1]);
        assert.ok(!allUp,   `monotonically up:   ${spins.map(x => x.toExponential(2)).join(', ')}`);
        assert.ok(!allDown, `monotonically down: ${spins.map(x => x.toExponential(2)).join(', ')}`);
    });
}

// ─── Test 3: Strict AM conservation (rigid only) ────────────────────────────
test('[rigid] strict conservation: Σ(I·ω) = L_parent + L_bullet to within 1e-12', () => {
    const cases = [
        { wp:  0.00, Lb:  1.5e-5 },
        { wp:  0.01, Lb: -8.0e-6 },
        { wp: -0.02, Lb:  2.0e-5 },
        { wp:  0.00, Lb:  0      },
    ];
    for (const { wp, Lb } of cases) {
        const Lp = R ** 4 * wp;
        const [w0, w1] = distribute('rigid', wp, I0, I1, Lp, Lb);
        const actual   = I0 * w0 + I1 * w1;
        const expected = Lp + Lb;
        assert.ok(Math.abs(actual - expected) < 1e-12,
            `wp=${wp}, Lb=${Lb}: got ${actual}, expected ${expected}`);
    }
});

// ─── Test 4: No inertia amplification (explosion / merged) ──────────────────
for (const model of ['explosion', 'merged']) {
    test(`[${model}] no inertia amplification: zero bullet impulse → ω_child = ω_parent`, () => {
        const wp = 0.01;
        const Lp = R ** 4 * wp;
        const [w0, w1] = distribute(model, wp, I0, I1, Lp, 0);
        assert.ok(Math.abs(w0 - wp) < 1e-15, `child-0 expected ${wp}, got ${w0}`);
        assert.ok(Math.abs(w1 - wp) < 1e-15, `child-1 expected ${wp}, got ${w1}`);
    });
}

// ─── Test 5: Symmetric ±L_b/2 bullet partition (merged / rigid) ─────────────
//
// Statement: the two children's angular momenta, measured relative to the
// inertia-weighted average ω̄ = Σ(I·ω)/Σ(I), differ by exactly +L_b/2 and
// −L_b/2 — independent of the split ratio. ('explosion' uses ±L_b magnitude
// instead of ±L_b/2, so it does NOT satisfy this; see Test 6.)
for (const model of ['merged', 'rigid']) {
    test(`[${model}] symmetric bullet partition: I_i·(ω_i − ω̄) = ±L_b/2 regardless of split ratio`, () => {
        const Lb = 2e-5;
        const Lp = 0;
        const [w0, w1] = distribute(model, 0, I0, I1, Lp, Lb);
        const wAvg = (I0 * w0 + I1 * w1) / Itot;
        const dL0 = I0 * (w0 - wAvg);
        const dL1 = I1 * (w1 - wAvg);
        assert.ok(Math.abs(dL0 - Lb / 2) < 1e-15, `child-0: expected +Lb/2=${Lb / 2}, got ${dL0}`);
        assert.ok(Math.abs(dL1 + Lb / 2) < 1e-15, `child-1: expected −Lb/2=${-Lb / 2}, got ${dL1}`);
    });
}

// ─── Test 6: Explosion uses full ±L_b magnitude (documents intentional difference) ─
test('[explosion] bullet partition uses full ±L_b/I_child (NOT ±L_b/2)', () => {
    const Lb = 2e-5;
    const [w0, w1] = distribute('explosion', 0, I0, I1, 0, Lb);
    // Each child kick is exactly Lb/I_child in magnitude.
    assert.ok(Math.abs(w0 - Lb / I0) < 1e-15, `child-0: expected ${Lb / I0}, got ${w0}`);
    assert.ok(Math.abs(w1 + Lb / I1) < 1e-15, `child-1: expected ${-Lb / I1}, got ${w1}`);
});
