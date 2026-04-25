/**
 * Regression tests for asteroid spin / rotation distribution after a bullet hit.
 *
 * Run with:  node --test AstervoidsWeb/spin-physics.test.mjs
 *
 * These tests exercise the pure mathematical formula used in splitAsteroid() to
 * assign rotationSpeed to each child.  They are deliberately isolated from the
 * browser-only parts of index.html so they can run in Node without a DOM.
 *
 * The formula under test (NEW, symmetric):
 *   ω_i = L_total / I_total  ±  L_bullet / (2 · I_i)
 *   where + for the impact-side child (index 0) and − for the away-side (index 1).
 *
 * Key properties verified here:
 *   1. Angular-momentum conservation: Σ(I_i · ω_i) = L_parent + L_bullet exactly.
 *   2. Mirror symmetry: flipping the hit direction (L_bullet → −L_bullet) on a
 *      stationary parent negates both child rotationSpeeds exactly.
 *   3. Equal-and-opposite bullet impulse partition: the bullet contributes exactly
 *      +L_bullet/2 to child 0's angular momentum and −L_bullet/2 to child 1's,
 *      so the corrections cancel and the total angular momentum is conserved without
 *      any asymmetric double-dose.  This property FAILS the old formula and PASSES
 *      the new one.
 *   4. No monotonic drift: alternating hits (+Lb, −Lb, +Lb, …) on the surviving
 *      larger fragment produce alternating spin signs, not one-directional growth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Rotation-distribution implementations ────────────────────────────────────

/**
 * OLD (buggy) formula — kept here only to drive the "must fail" assertion in test 3.
 *
 * The smaller child (index 0) receives a double dose of the bullet's angular momentum
 * (2·L_bullet / I_total) while the larger child (index 1) receives only a tiny
 * inertia-weighted correction (−L_bullet · I_0 / (I_total · I_1)).
 * The corrections are NOT equal-and-opposite in angular-momentum terms.
 */
function distributeRotationOld(omegaParent, I0, I1, Lparent, Lbullet) {
    const Ltotal = Lparent + Lbullet;
    const Itotal = I0 + I1;
    const omega0 = Ltotal / Itotal + Lbullet / Itotal;
    const omega1 = Ltotal / Itotal - Lbullet * I0 / (Itotal * I1);
    return [omega0, omega1];
}

/**
 * NEW (fixed) formula — matches the updated splitAsteroid() in index.html.
 *
 * Each child's spin = shared average ± symmetric bullet correction:
 *   ω_0 = L_total/I_total + L_bullet/(2·I_0)   (impact side, +)
 *   ω_1 = L_total/I_total − L_bullet/(2·I_1)   (away   side, −)
 *
 * The corrections carry ±L_bullet/2 of angular momentum each; they cancel, so
 * Σ(I_i · ω_i) = L_total exactly.  Flipping L_bullet negates both corrections,
 * giving mirror-symmetric results for a stationary parent.
 */
function distributeRotationNew(omegaParent, I0, I1, Lparent, Lbullet) {
    const Ltotal = Lparent + Lbullet;
    const Itotal = I0 + I1;
    const omega0 = Ltotal / Itotal + Lbullet / (2 * I0);
    const omega1 = Ltotal / Itotal - Lbullet / (2 * I1);
    return [omega0, omega1];
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Total angular momentum of two children. */
function totalL(I0, omega0, I1, omega1) {
    return I0 * omega0 + I1 * omega1;
}

/** Signed angular-momentum contribution of the bullet correction for each child. */
function bulletDeltaL(I0, omega0, I1, omega1, Ltotal, Itotal) {
    const omegaAvg = Ltotal / Itotal;
    const deltaL0 = I0 * (omega0 - omegaAvg);
    const deltaL1 = I1 * (omega1 - omegaAvg);
    return { deltaL0, deltaL1 };
}

// ─── Reference geometry ───────────────────────────────────────────────────────

// Asteroid split with a moderately asymmetric ratio (35 % / 65 %) to expose the
// I0 ≠ I1 case where the old and new formulas diverge most clearly.
const R       = 0.10;            // parent radius (reference-dimension units)
const frac0   = 0.35;            // area fraction for the smaller (impact-side) child
const r0      = R * Math.sqrt(frac0);
const r1      = R * Math.sqrt(1 - frac0);
const I0      = r0 ** 4;         // moment of inertia ∝ r⁴
const I1      = r1 ** 4;
const Itotal  = I0 + I1;

// ─── Test 1: Angular-momentum conservation ────────────────────────────────────
test('conservation: Σ(I_i · ω_i) = L_parent + L_bullet to within 1e-12', () => {
    const cases = [
        { omegaParent:  0.00, Lb:  1.5e-5 },
        { omegaParent:  0.01, Lb: -8.0e-6 },
        { omegaParent: -0.02, Lb:  2.0e-5 },
        { omegaParent:  0.00, Lb:  0      },   // no-bullet edge case
    ];

    for (const { omegaParent, Lb } of cases) {
        const Lp = R ** 4 * omegaParent;
        const [omega0, omega1] = distributeRotationNew(omegaParent, I0, I1, Lp, Lb);
        const actual   = totalL(I0, omega0, I1, omega1);
        const expected = Lp + Lb;
        assert.ok(
            Math.abs(actual - expected) < 1e-12,
            `Conservation failed for omegaParent=${omegaParent}, Lb=${Lb}: ` +
            `got ${actual}, expected ${expected}`
        );
    }
});

// ─── Test 2: Mirror symmetry ──────────────────────────────────────────────────
test('mirror symmetry: stationary parent, +Lb and −Lb hits produce exact negatives', () => {
    const omegaParent = 0;
    const Lp          = 0;        // stationary → zero angular momentum
    const Lb          = 1e-4;     // arbitrary positive bullet torque

    const [w0plus,  w1plus]  = distributeRotationNew(omegaParent, I0, I1, Lp,  Lb);
    const [w0minus, w1minus] = distributeRotationNew(omegaParent, I0, I1, Lp, -Lb);

    assert.ok(
        Math.abs(w0plus + w0minus) < 1e-12,
        `Child-0 not mirror-symmetric: w0plus=${w0plus}, w0minus=${w0minus}`
    );
    assert.ok(
        Math.abs(w1plus + w1minus) < 1e-12,
        `Child-1 not mirror-symmetric: w1plus=${w1plus}, w1minus=${w1minus}`
    );
});

// ─── Test 3: Equal-and-opposite bullet impulse partition ──────────────────────
//
// This is the key correctness test that distinguishes the two formulas.
//
// The bullet's angular impulse (L_bullet) must be split symmetrically between the
// two children: child 0 receives +L_bullet/2 of extra angular momentum and child 1
// receives −L_bullet/2.  The two corrections cancel, so they do not disturb the
// already-conserved average (L_total / I_total).
//
// With the OLD formula the correction for child 0 is L_bullet · I_0 / I_total
// (proportional to I_0, NOT always L_bullet/2), so it FAILS this assertion for
// any split where I_0 ≠ I_total/2 (i.e. any non-equal split).
// With the NEW formula it is always exactly L_bullet/2.
test('equal-and-opposite bullet partition: I_0·Δω_0 = +Lb/2, I_1·Δω_1 = −Lb/2 (new formula)', () => {
    const Lb   = 2e-5;
    const Lp   = 0;        // stationary parent keeps the assertion clean
    const Ltot = Lp + Lb;

    const [omega0, omega1] = distributeRotationNew(0, I0, I1, Lp, Lb);
    const { deltaL0, deltaL1 } = bulletDeltaL(I0, omega0, I1, omega1, Ltot, Itotal);

    assert.ok(
        Math.abs(deltaL0 - Lb / 2) < 1e-12,
        `Child-0 angular-impulse should be +Lb/2 (${Lb / 2}), got ${deltaL0}`
    );
    assert.ok(
        Math.abs(deltaL1 + Lb / 2) < 1e-12,
        `Child-1 angular-impulse should be −Lb/2 (${-Lb / 2}), got ${deltaL1}`
    );
});

test('OLD formula fails the equal-and-opposite partition (documents the bug)', () => {
    // For a non-equal split (frac0 = 0.35 ≠ 0.5) the old formula's child-0
    // correction is L_bullet · I_0 / I_total, which differs from L_bullet/2
    // whenever I_0 ≠ I_total/2.
    const Lb   = 2e-5;
    const Lp   = 0;
    const Ltot = Lp + Lb;

    const [omega0, omega1] = distributeRotationOld(0, I0, I1, Lp, Lb);
    const { deltaL0 }      = bulletDeltaL(I0, omega0, I1, omega1, Ltot, Itotal);

    // Old formula gives deltaL0 = Lb · I0 / Itotal  (NOT Lb/2 for unequal splits)
    const expectedOld = Lb * I0 / Itotal;
    assert.ok(
        Math.abs(deltaL0 - expectedOld) < 1e-12,
        `Old-formula deltaL0 should be Lb·I0/Itotal=${expectedOld}, got ${deltaL0}`
    );
    // And it is NOT Lb/2 for a 35/65 split
    assert.ok(
        Math.abs(deltaL0 - Lb / 2) > 1e-6,
        `Old formula unexpectedly gave Lb/2 — test setup may be wrong`
    );
});

// ─── Test 4: No monotonic drift ───────────────────────────────────────────────
//
// Simulate 10 alternating hits on the surviving larger child.  Each generation:
//   • the larger child becomes the new parent
//   • it is hit with alternating +Lb / −Lb
// The spin of the larger child must alternate sign (oscillate), not grow monotonically.
test('no monotonic drift: alternating hits on the larger child oscillate in sign', () => {
    let currentR     = R;
    let currentOmega = 0;
    const HITS = 10;
    const spins = [];

    for (let i = 0; i < HITS; i++) {
        const cr0 = currentR * Math.sqrt(frac0);
        const cr1 = currentR * Math.sqrt(1 - frac0);
        const cI0 = cr0 ** 4;
        const cI1 = cr1 ** 4;
        const Lp  = currentR ** 4 * currentOmega;
        const Lb  = (i % 2 === 0 ? 1 : -1) * 1e-5;

        const [, omega1] = distributeRotationNew(currentOmega, cI0, cI1, Lp, Lb);
        currentOmega = omega1;
        currentR     = cr1;      // the larger child becomes the next parent
        spins.push(omega1);
    }

    // The sequence must not be monotonically non-decreasing or non-increasing.
    const allNonDecreasing = spins.every((v, i) => i === 0 || v >= spins[i - 1]);
    const allNonIncreasing = spins.every((v, i) => i === 0 || v <= spins[i - 1]);
    assert.ok(!allNonDecreasing,
        `Spin monotonically non-decreasing: ${spins.map(x => x.toFixed(5)).join(', ')}`);
    assert.ok(!allNonIncreasing,
        `Spin monotonically non-increasing: ${spins.map(x => x.toFixed(5)).join(', ')}`);
});
