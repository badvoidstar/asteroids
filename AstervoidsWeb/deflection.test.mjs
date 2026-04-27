/**
 * Tests for computeDeflectionImpulse — the post-split shooter-deflection helper
 * that bends a surviving asteroid fragment off a direct collision course with
 * the ship that fired the destroying shot.
 *
 * Run with:  node --test AstervoidsWeb/deflection.test.mjs
 *
 * The pure math is mirrored here so tests don't need a browser environment.
 * Keep this in sync with the function of the same name in
 * AstervoidsWeb/wwwroot/index.html.
 *
 * Properties verified:
 *   1. Receding / no-relative-motion fragments get zero impulse.
 *   2. Fragments already missing by ≥ scale·R_sum get zero impulse.
 *   3. scale = 0 → zero impulse (feature disabled).
 *   4. Returned Δv is purely perpendicular to the relative velocity.
 *   5. scale = 1 → after-impulse closest-approach distance equals R_sum
 *      (just barely misses) when t_close >= T.
 *   6. scale > 1 → after-impulse closest-approach distance equals scale·R_sum.
 *   7. T acts as a cap: for an imminent collision (t_close < T), the magnitude
 *      is bounded by (target_miss − d_close)/T; for distant collisions
 *      (t_close > T), magnitude is (target_miss − d_close)/t_close.
 *   8. Head-on collision (d_close ≈ 0) still produces a valid perpendicular
 *      impulse (no NaN/Infinity).
 *   9. Direction always pushes the trajectory AWAY from the ship (new
 *      closest-approach distance ≥ original).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mirror of computeDeflectionImpulse ─────────────────────────────────────
function computeDeflectionImpulse(rx, ry, vx, vy, R_sum, T, scale) {
    if (!(scale > 0) || !(T > 0) || !(R_sum > 0)) return { dvx: 0, dvy: 0 };
    const v2 = vx * vx + vy * vy;
    if (v2 < 1e-18) return { dvx: 0, dvy: 0 };
    const tClose = -(rx * vx + ry * vy) / v2;
    if (tClose <= 0) return { dvx: 0, dvy: 0 };
    const cx = rx + vx * tClose;
    const cy = ry + vy * tClose;
    const dClose = Math.hypot(cx, cy);
    const targetMiss = scale * R_sum;
    if (dClose >= targetMiss) return { dvx: 0, dvy: 0 };
    let nx, ny;
    if (dClose > 1e-12) {
        nx = cx / dClose;
        ny = cy / dClose;
    } else {
        const vMag = Math.sqrt(v2);
        nx = -vy / vMag;
        ny =  vx / vMag;
    }
    const tEff = Math.max(tClose, T);
    const dvMag = (targetMiss - dClose) / tEff;
    return { dvx: dvMag * nx, dvy: dvMag * ny };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
/** Closest-approach distance between fragment (rx,ry,vx,vy) and ship at origin. */
function closestApproach(rx, ry, vx, vy) {
    const v2 = vx * vx + vy * vy;
    if (v2 < 1e-18) return { t: 0, d: Math.hypot(rx, ry) };
    const t = -(rx * vx + ry * vy) / v2;
    if (t <= 0) return { t: 0, d: Math.hypot(rx, ry) };
    return { t, d: Math.hypot(rx + vx * t, ry + vy * t) };
}

const R = 0.05;   // SHIP_SIZE-ish
const T = 0.5;

// ─── 1. Receding / no relative motion ───────────────────────────────────────
test('receding fragment gets zero impulse', () => {
    // Fragment is "in front" of the ship and moving further away.
    const out = computeDeflectionImpulse(1.0, 0, +1.0, 0, R, T, 1.0);
    assert.equal(out.dvx, 0);
    assert.equal(out.dvy, 0);
});

test('zero relative velocity gets zero impulse', () => {
    const out = computeDeflectionImpulse(0.5, 0.0, 0, 0, R, T, 1.0);
    assert.equal(out.dvx, 0);
    assert.equal(out.dvy, 0);
});

// ─── 2. Already missing ────────────────────────────────────────────────────
test('already missing by enough → zero impulse', () => {
    // Fragment will pass at d_close = 0.5 (>> R_sum); not on collision course.
    const out = computeDeflectionImpulse(1.0, 0.5, -1.0, 0, R, T, 1.0);
    assert.equal(out.dvx, 0);
    assert.equal(out.dvy, 0);
});

// ─── 3. scale = 0 disables the feature ─────────────────────────────────────
test('scale=0 → zero impulse even on direct collision course', () => {
    const out = computeDeflectionImpulse(1.0, 0.0, -1.0, 0, R, T, 0.0);
    assert.equal(out.dvx, 0);
    assert.equal(out.dvy, 0);
});

// ─── 4. Δv is perpendicular to relative velocity ──────────────────────────
test('returned Δv is perpendicular to relative velocity', () => {
    // Collision course: at closest approach, fragment is just inside R from ship.
    const rx = 1.0, ry = 0.02, vx = -2.0, vy = 0.04;
    // Sanity: closestApproach distance is < R.
    const before = closestApproach(rx, ry, vx, vy).d;
    assert.ok(before < R, `precondition: collision course, got d_close=${before}`);
    const { dvx, dvy } = computeDeflectionImpulse(rx, ry, vx, vy, R, T, 1.0);
    assert.ok(Math.hypot(dvx, dvy) > 0, 'expected non-zero impulse on collision course');
    const dot = dvx * vx + dvy * vy;
    assert.ok(Math.abs(dot) < 1e-12, `Δv · v should be 0, got ${dot}`);
});

// ─── 5. scale = 1 with t_close >= T → exactly grazes R_sum ─────────────────
test('scale=1, t_close >= T → new closest-approach ≈ R_sum', () => {
    // Use a long-range scenario so Δv is small relative to v0; the formula's
    // perpendicular linearization is then accurate to ≤ 0.1% of R_sum.
    const rx = -10.0, ry = 0.01, vx = +1.0, vy = 0;
    const { t: tClose, d: dClose } = closestApproach(rx, ry, vx, vy);
    assert.ok(tClose > T, 'precondition: t_close should exceed T');
    assert.ok(dClose < R, 'precondition: collision course');
    const { dvx, dvy } = computeDeflectionImpulse(rx, ry, vx, vy, R, T, 1.0);
    const newDClose = closestApproach(rx, ry, vx + dvx, vy + dvy).d;
    assert.ok(Math.abs(newDClose - R) < 1e-3 * R,
        `expected new d_close ≈ R_sum (${R}), got ${newDClose}`);
});

// ─── 6. scale > 1 → exact extra margin ─────────────────────────────────────
test('scale=2.0, t_close >= T → new closest-approach ≈ 2·R_sum', () => {
    const rx = -10.0, ry = 0.01, vx = +1.0, vy = 0;
    const { dvx, dvy } = computeDeflectionImpulse(rx, ry, vx, vy, R, T, 2.0);
    const newDClose = closestApproach(rx, ry, vx + dvx, vy + dvy).d;
    assert.ok(Math.abs(newDClose - 2 * R) < 1e-3 * (2 * R),
        `expected new d_close ≈ 2·R_sum (${2 * R}), got ${newDClose}`);
});

// ─── 7. T as impulse cap ────────────────────────────────────────────────────
test('T caps impulse for imminent collisions (t_close < T)', () => {
    // Head-on imminent: t_close = 0.1s < T = 0.5s.
    const rx = -0.1, ry = 0.005, vx = +1.0, vy = 0;
    const { t: tClose, d: dClose } = closestApproach(rx, ry, vx, vy);
    assert.ok(tClose < T, 'precondition: t_close < T');
    const scale = 1.0;
    const { dvx, dvy } = computeDeflectionImpulse(rx, ry, vx, vy, R, T, scale);
    const dvMag = Math.hypot(dvx, dvy);
    const expected = (scale * R - dClose) / T;
    assert.ok(Math.abs(dvMag - expected) < 1e-12,
        `imminent-collision Δv should be capped at (target − d_close)/T = ${expected}, got ${dvMag}`);
    // Because the cap under-deflects, the new closest-approach is below the target.
    const newDClose = closestApproach(rx, ry, vx + dvx, vy + dvy).d;
    assert.ok(newDClose < scale * R,
        `under-deflection: new d_close (${newDClose}) should be < target (${scale * R})`);
});

test('distant collisions use natural t_close, not T', () => {
    const rx = -10.0, ry = 0.02, vx = +1.0, vy = 0;        // t_close = 10s
    const { t: tClose, d: dClose } = closestApproach(rx, ry, vx, vy);
    assert.ok(tClose > T);
    const scale = 1.0;
    const { dvx, dvy } = computeDeflectionImpulse(rx, ry, vx, vy, R, T, scale);
    const dvMag = Math.hypot(dvx, dvy);
    const expected = (scale * R - dClose) / tClose;
    assert.ok(Math.abs(dvMag - expected) < 1e-12,
        `distant-collision Δv should be (target − d_close)/t_close = ${expected}, got ${dvMag}`);
});

// ─── 8. Head-on collision (d_close = 0) ────────────────────────────────────
test('perfectly head-on collision (d_close=0) still produces valid impulse', () => {
    // Long-range head-on so the linearization is accurate.
    const rx = -10.0, ry = 0, vx = +1.0, vy = 0;
    const { dvx, dvy } = computeDeflectionImpulse(rx, ry, vx, vy, R, T, 1.0);
    assert.ok(Number.isFinite(dvx) && Number.isFinite(dvy));
    assert.ok(Math.hypot(dvx, dvy) > 0);
    // Perpendicular to v.
    assert.ok(Math.abs(dvx * vx + dvy * vy) < 1e-12);
    // After-impulse closest approach reaches approximately R_sum.
    const newDClose = closestApproach(rx, ry, vx + dvx, vy + dvy).d;
    assert.ok(Math.abs(newDClose - R) < 1e-3 * R);
});

// ─── 9. Direction pushes AWAY from the ship ─────────────────────────────────
test('deflection always increases the closest-approach distance', () => {
    // Try a handful of scenarios with both signs of ry.
    const cases = [
        { rx: -1.0, ry:  0.005, vx: +2.0, vy:  0 },
        { rx: -1.0, ry: -0.005, vx: +2.0, vy:  0 },
        { rx: -1.0, ry:  0.01,  vx: +1.5, vy:  0.4 },
        { rx: -1.0, ry: -0.02,  vx: +0.7, vy: -0.1 },
    ];
    for (const { rx, ry, vx, vy } of cases) {
        const { d: before } = closestApproach(rx, ry, vx, vy);
        const { dvx, dvy } = computeDeflectionImpulse(rx, ry, vx, vy, R, T, 1.0);
        const after = closestApproach(rx, ry, vx + dvx, vy + dvy).d;
        assert.ok(after >= before - 1e-12,
            `deflection moved fragment closer (before=${before}, after=${after})`);
    }
});

// ─── 10. Disabled paths ────────────────────────────────────────────────────
test('non-positive T → zero impulse', () => {
    assert.deepEqual(computeDeflectionImpulse(-1, 0.01, 1, 0, R, 0,    1.0), { dvx: 0, dvy: 0 });
    assert.deepEqual(computeDeflectionImpulse(-1, 0.01, 1, 0, R, -0.5, 1.0), { dvx: 0, dvy: 0 });
});

test('non-positive R_sum → zero impulse', () => {
    assert.deepEqual(computeDeflectionImpulse(-1, 0.01, 1, 0, 0,    T, 1.0), { dvx: 0, dvy: 0 });
    assert.deepEqual(computeDeflectionImpulse(-1, 0.01, 1, 0, -0.1, T, 1.0), { dvx: 0, dvy: 0 });
});
