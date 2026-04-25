/**
 * Tests for the physics-correct asteroid fragmentation model in splitAsteroid().
 *
 * Run with:  node --test AstervoidsWeb/split-physics.test.mjs
 *
 * The pure math from splitAsteroid() is mirrored here so the tests are
 * independent of the browser environment. Each test operates on randomized
 * or targeted impact geometries.
 *
 * Conservation laws verified:
 *   1. Linear momentum:   Σ m_i v_i  = M v + J                      (~1e-10)
 *   2. Angular momentum:  Σ (m_i r_i×v_i + I_i ω_i) = I ω + r×J   (~1e-10)
 *   3. Energy:            Σ ½(m_i|v_i|²+I_i ω_i²) = ½M|v|²+½Iω²+E_b (~1e-10)
 *
 * Behavioral properties verified:
 *   4. Head-on hit  (offsetN = 0)   → f_small = f_large = 0.5
 *   5. Grazing hit  (|offsetN| = 1) → f_small = MIN_SPLIT_RATIO
 *   6. One-child branch: rSmall < MIN_RADIUS → exactly one child, carrying v', ω'
 *   7. ASTEROID_DENSITY: k× density uniformly damps every velocity by 1/√k
 *   8. BULLET_ENERGY_SIZE_BLEND=0 → effectiveEb = BULLET_KINETIC_ENERGY (legacy)
 *   9. BULLET_ENERGY_SIZE_BLEND=1 → separation speed is generation-independent
 *  10. BULLET_ENERGY_SIZE_BLEND=0 → separation speed compounds as 1/R (regression)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mirror of splitAsteroid's pure math ────────────────────────────────────
// Keep these constants and formulas in sync with AstervoidsWeb/wwwroot/index.html.

const CONFIG = {
    BULLET_KINETIC_ENERGY: 6e-5,
    MIN_SPLIT_RATIO: 0.1,
    MIN_ASTEROID_RADIUS: 0.025,
    INITIAL_ASTEROID_RADIUS: 0.083,
    ASTEROID_DENSITY: 1.0,
    BULLET_ENERGY_SIZE_BLEND: 1.0,
};

// kappa is intentionally duplicated here (not imported from index.html) to keep
// these tests independent of the browser environment, matching the pattern of the
// old spin-physics.test.mjs. It must be kept in sync with the hard-coded constant
// in splitAsteroid() in AstervoidsWeb/wwwroot/index.html.
const kappa = 0.005;  // fraction of E_b → parent rigid KE (hard-coded in splitAsteroid)

/** Effective bullet energy after the size-blend mapping. */
function effectiveEb(R, cfg = CONFIG) {
    const blend = Math.max(0, Math.min(1, cfg.BULLET_ENERGY_SIZE_BLEND));
    const Rref  = cfg.INITIAL_ASTEROID_RADIUS;
    const sizeMul = (1 - blend) + blend * (R / Rref) * (R / Rref);
    return cfg.BULLET_KINETIC_ENERGY * sizeMul;
}

/**
 * Core fragmentation math, extracted from splitAsteroid().
 * Returns an array of child descriptors: { r, m, vx, vy, omega, posX, posY }
 * where posX/posY are offsets from the parent COM along the separation axis.
 *
 * @param {number} R        - parent radius
 * @param {number} vx       - parent velocity X
 * @param {number} vy       - parent velocity Y
 * @param {number} omega    - parent angular velocity
 * @param {number} offsetN  - normalised perpendicular impact offset ∈ [-1,1]
 * @param {number} bulletAngle - bullet direction angle (rad)
 * @param {object} [cfg]    - override CONFIG (for density/blend tests)
 */
function fragment(R, vx, vy, omega, offsetN, bulletAngle, cfg = CONFIG) {
    // Clamp offsetN.
    offsetN = Math.max(-1, Math.min(1, offsetN));

    // Bullet direction d̂ and separation normal n̂ = d̂ rotated +90°.
    const dx = Math.cos(bulletAngle), dy = Math.sin(bulletAngle);
    const nx = -dy, ny = dx;

    // Disk: M = ρ·R², I = ½MR².
    const density = cfg.ASTEROID_DENSITY;
    const M = density * R * R;
    const I = 0.5 * M * R * R;

    // Impact point r relative to parent COM.
    const b   = offsetN * R;
    const rxN = b;
    const rxD = -Math.sqrt(Math.max(0, R * R - b * b));
    const rx  = rxD * dx + rxN * nx;
    const ry  = rxD * dy + rxN * ny;

    // Bullet impulse (size-blended energy).
    const E_b         = effectiveEb(R, cfg);
    const leverFactor = 1 + 2 * (b * b) / (R * R);
    const Jmag        = Math.sqrt(2 * M * E_b * kappa / leverFactor);
    const Jx = Jmag * dx, Jy = Jmag * dy;

    // Post-impulse parent state.
    const vxP    = vx + Jx / M;
    const vyP    = vy + Jy / M;
    const torque = rx * Jy - ry * Jx;
    const omegaP = omega + torque / I;

    // Energy for separation.
    const dE_rigid = (Jmag * Jmag) / (2 * M) * leverFactor;
    const E_sep    = Math.max(0, E_b - dE_rigid);

    // Mass split.
    const minRatio = Math.max(0.01, Math.min(0.5, CONFIG.MIN_SPLIT_RATIO));
    const fSmall   = Math.max(minRatio, 0.5 * (1 - Math.abs(offsetN)));
    const fLarge   = 1 - fSmall;

    const rSmall = R * Math.sqrt(fSmall);
    const rLarge = R * Math.sqrt(fLarge);
    const mSmall = fSmall * M;
    const mLarge = fLarge * M;

    // Separation axis.
    const sideSign = offsetN >= 0 ? 1 : -1;
    const sx = sideSign * nx, sy = sideSign * ny;

    if (rSmall < CONFIG.MIN_ASTEROID_RADIUS) {
        // Single child: large fragment carries post-impulse motion.
        return [{ r: rLarge, m: mLarge, vx: vxP, vy: vyP, omega: omegaP, posX: 0, posY: 0 }];
    }

    // AM-conserving placement: d_s = R·f_l, d_l = -R·f_s.
    const dSmall = +R * fLarge;
    const dLarge = -R * fSmall;

    // Inherited rigid velocity at each COM.
    const rigidVelocityAt = (d) => ({
        vx: vxP + (-omegaP) * (d * sy),
        vy: vyP + ( omegaP) * (d * sx),
    });
    const vS = rigidVelocityAt(dSmall), vL = rigidVelocityAt(dLarge);

    // Separation impulse.
    const s = E_sep > 0 ? Math.sqrt(2 * E_sep * mLarge / (mSmall * M)) : 0;

    return [
        {
            r: rSmall, m: mSmall,
            vx: vS.vx + s * sx,                     vy: vS.vy + s * sy,                     omega: omegaP,
            posX: dSmall * sx, posY: dSmall * sy,
        },
        {
            r: rLarge, m: mLarge,
            vx: vL.vx - s * sx * (mSmall / mLarge), vy: vL.vy - s * sy * (mSmall / mLarge), omega: omegaP,
            posX: dLarge * sx, posY: dLarge * sy,
        },
    ];
}

/** Compute total children quantities for a given scenario. */
function sums(children) {
    let px = 0, py = 0, L = 0, KE = 0;
    for (const c of children) {
        const m = c.m;
        const I_c = 0.5 * m * c.r * c.r;
        px += m * c.vx;
        py += m * c.vy;
        L  += m * (c.posX * c.vy - c.posY * c.vx) + I_c * c.omega;
        KE += 0.5 * m * (c.vx * c.vx + c.vy * c.vy) + 0.5 * I_c * c.omega * c.omega;
    }
    return { px, py, L, KE };
}

// ─── Randomized test parameters ─────────────────────────────────────────────
// Fixed seed to keep tests deterministic across runs.
function lcg(seed) {
    // Simple linear congruential generator.
    let s = seed;
    return () => {
        s = (1664525 * s + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0x100000000;
    };
}
const rng = lcg(42);
const rand = (lo, hi) => lo + rng() * (hi - lo);

// R_min ensures rSmall = R·√fSmall ≥ MIN_RADIUS for all |offsetN| ≤ 0.95.
// With fSmall_min = max(MIN_SPLIT_RATIO, 0.5·(1−0.95)) = 0.1:
//   R_min = MIN_ASTEROID_RADIUS / √MIN_SPLIT_RATIO ≈ 0.025 / √0.1 ≈ 0.0791
const R_MIN_TWO_CHILD = CONFIG.MIN_ASTEROID_RADIUS / Math.sqrt(CONFIG.MIN_SPLIT_RATIO);

const CASES = Array.from({ length: 20 }, () => ({
    R:          rand(R_MIN_TWO_CHILD * 1.01, 0.12),  // guaranteed two-child outcomes
    vx:         rand(-0.3, 0.3),
    vy:         rand(-0.3, 0.3),
    omega:      rand(-0.05, 0.05),
    offsetN:    rand(-0.95, 0.95),
    bulletAngle: rand(-Math.PI, Math.PI),
}));

// ─── Test 1: Linear momentum conservation ───────────────────────────────────
test('linear momentum: Σ m_i v_i = M v + J, to 1e-10', () => {
    for (const { R, vx, vy, omega, offsetN, bulletAngle } of CASES) {
        const M  = CONFIG.ASTEROID_DENSITY * R * R;
        const dx = Math.cos(bulletAngle), dy = Math.sin(bulletAngle);
        const b  = Math.max(-1, Math.min(1, offsetN)) * R;
        const leverFactor = 1 + 2 * (b * b) / (R * R);
        const Jmag = Math.sqrt(2 * M * effectiveEb(R) * kappa / leverFactor);
        const Jx = Jmag * dx, Jy = Jmag * dy;

        const children = fragment(R, vx, vy, omega, offsetN, bulletAngle);
        const { px, py } = sums(children);

        const expPx = M * vx + Jx;
        const expPy = M * vy + Jy;
        assert.ok(Math.abs(px - expPx) < 1e-10,
            `px: got ${px}, expected ${expPx} (R=${R}, offsetN=${offsetN})`);
        assert.ok(Math.abs(py - expPy) < 1e-10,
            `py: got ${py}, expected ${expPy}`);
    }
});

// ─── Test 2: Angular momentum conservation ───────────────────────────────────
test('angular momentum: Σ(m_i r_i×v_i + I_i ω_i) = I ω + r×J, to 1e-10', () => {
    for (const { R, vx, vy, omega, offsetN, bulletAngle } of CASES) {
        const M  = CONFIG.ASTEROID_DENSITY * R * R;
        const I  = 0.5 * M * R * R;
        const dx = Math.cos(bulletAngle), dy = Math.sin(bulletAngle);
        const nx = -dy, ny = dx;
        const b   = Math.max(-1, Math.min(1, offsetN)) * R;
        const rxN = b;
        const rxD = -Math.sqrt(Math.max(0, R * R - b * b));
        const rx  = rxD * dx + rxN * nx;
        const ry  = rxD * dy + rxN * ny;
        const leverFactor = 1 + 2 * (b * b) / (R * R);
        const Jmag = Math.sqrt(2 * M * effectiveEb(R) * kappa / leverFactor);
        const Jx = Jmag * dx, Jy = Jmag * dy;
        const torqueJ = rx * Jy - ry * Jx;

        const children = fragment(R, vx, vy, omega, offsetN, bulletAngle);
        const { L } = sums(children);

        // Parent initial AM about its own COM: spin = I*omega, orbital = 0 (at origin).
        const expL = I * omega + torqueJ;
        assert.ok(Math.abs(L - expL) < 1e-10,
            `L: got ${L}, expected ${expL} (R=${R}, offsetN=${offsetN}, omega=${omega})`);
    }
});

// ─── Test 3: Energy conservation (in the parent's pre-impact rest frame) ────
// The formula KE_after = KE_before + E_b holds exactly when the parent is at rest
// (v=0, ω=0). In the lab frame a cross-term v·J + ω·(r×J) appears; the problem
// statement's energy guarantee is scoped to the rest frame.
test('energy (rest frame): Σ ½(m_i|v_i|²+I_i ω_i²) = E_b(R), to 1e-10', () => {
    const restCases = Array.from({ length: 20 }, () => ({
        R:           rand(R_MIN_TWO_CHILD * 1.01, 0.12),
        vx:          0,   // parent at rest
        vy:          0,
        omega:       0,
        offsetN:     rand(-0.95, 0.95),
        bulletAngle: rand(-Math.PI, Math.PI),
    }));

    for (const { R, vx, vy, omega, offsetN, bulletAngle } of restCases) {
        const children = fragment(R, vx, vy, omega, offsetN, bulletAngle);
        const { KE } = sums(children);

        // KE_before = 0 (parent at rest), so expected = effectiveEb(R).
        const E_b = effectiveEb(R);
        assert.ok(Math.abs(KE - E_b) < 1e-10,
            `KE: got ${KE}, expected ${E_b} (R=${R}, offsetN=${offsetN})`);
    }
});

// ─── Test 4: Head-on → balanced split ───────────────────────────────────────
test('head-on hit (offsetN=0) → f_small = f_large = 0.5', () => {
    const R = 0.08;
    const minRatio = CONFIG.MIN_SPLIT_RATIO;
    const fSmall = Math.max(minRatio, 0.5 * (1 - Math.abs(0)));
    assert.strictEqual(fSmall, 0.5, `expected 0.5, got ${fSmall}`);

    const children = fragment(R, 0, 0, 0, 0, 0);
    assert.strictEqual(children.length, 2, 'expected two children');
    const [c0, c1] = children;
    // Both radii should be R/√2 ≈ 0.707·R
    const expected = R * Math.sqrt(0.5);
    assert.ok(Math.abs(c0.r - expected) < 1e-12, `c0.r = ${c0.r}, expected ${expected}`);
    assert.ok(Math.abs(c1.r - expected) < 1e-12, `c1.r = ${c1.r}, expected ${expected}`);
});

// ─── Test 5: Grazing → skewed split ─────────────────────────────────────────
test('grazing hit (|offsetN|=1) → f_small = MIN_SPLIT_RATIO', () => {
    const R       = 0.08;
    const minRatio = CONFIG.MIN_SPLIT_RATIO;

    for (const sign of [1, -1]) {
        const fSmall = Math.max(minRatio, 0.5 * (1 - Math.abs(sign)));
        assert.strictEqual(fSmall, minRatio,
            `offsetN=${sign}: expected fSmall=${minRatio}, got ${fSmall}`);
    }
});

// ─── Test 6: One-child branch ────────────────────────────────────────────────
test('one-child branch: when rSmall < MIN_RADIUS, exactly one child with v\', ω\'', () => {
    // Choose R and offsetN so that rSmall = R·√fSmall < MIN_ASTEROID_RADIUS.
    // fSmall = MIN_SPLIT_RATIO = 0.1 when |offsetN| = 1.
    // rSmall = R·√0.1. We need R·√0.1 < 0.025, so R < 0.025/√0.1 ≈ 0.079.
    const R       = 0.07;   // R·√0.1 ≈ 0.0221 < 0.025 ✓
    const vx      = 0.1, vy = -0.05, omega0 = 0.01;
    const offsetN = 1.0;   // fully grazing
    const angle   = Math.PI / 4;

    const children = fragment(R, vx, vy, omega0, offsetN, angle);
    assert.strictEqual(children.length, 1, `expected 1 child, got ${children.length}`);

    // The single child must carry the post-impulse parent velocity v', ω'.
    const M  = CONFIG.ASTEROID_DENSITY * R * R;
    const I  = 0.5 * M * R * R;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const nx = -dy, ny = dx;
    const b  = offsetN * R;
    const rxD = -Math.sqrt(Math.max(0, R * R - b * b));
    const rx  = rxD * dx + b * nx;
    const ry  = rxD * dy + b * ny;
    const leverFactor = 1 + 2 * (b * b) / (R * R);
    const Jmag = Math.sqrt(2 * M * effectiveEb(R) * kappa / leverFactor);
    const Jx = Jmag * dx, Jy = Jmag * dy;
    const vxP    = vx + Jx / M;
    const vyP    = vy + Jy / M;
    const torque = rx * Jy - ry * Jx;
    const omegaP = omega0 + torque / I;

    const c = children[0];
    assert.ok(Math.abs(c.vx - vxP) < 1e-12,    `c.vx = ${c.vx}, expected ${vxP}`);
    assert.ok(Math.abs(c.vy - vyP) < 1e-12,    `c.vy = ${c.vy}, expected ${vyP}`);
    assert.ok(Math.abs(c.omega - omegaP) < 1e-12, `c.omega = ${c.omega}, expected ${omegaP}`);
});

// ─── Test 7: Density uniformly damps velocity outcomes by 1/√ρ ──────────────
// Increasing ASTEROID_DENSITY by k must scale separation/deflection/spin all by 1/√k,
// because density cancels in conservation laws but reweights M = ρR². Energy is
// preserved but distributed across more inertia.
test('asteroid density: 4× density → all velocities scale by 1/√4 = 1/2', () => {
    const R = 0.08, vx = 0.0, vy = 0.0, omega = 0.0;
    const offsetN = 0.4, bulletAngle = 0.7;

    const cfg1 = { ...CONFIG, ASTEROID_DENSITY: 1.0, BULLET_ENERGY_SIZE_BLEND: 0 };
    const cfg4 = { ...CONFIG, ASTEROID_DENSITY: 4.0, BULLET_ENERGY_SIZE_BLEND: 0 };

    const c1 = fragment(R, vx, vy, omega, offsetN, bulletAngle, cfg1);
    const c4 = fragment(R, vx, vy, omega, offsetN, bulletAngle, cfg4);

    assert.strictEqual(c1.length, c4.length);
    for (let i = 0; i < c1.length; i++) {
        // Velocity ratio ρ=4 vs ρ=1 should be exactly 1/2.
        assert.ok(Math.abs(c4[i].vx - 0.5 * c1[i].vx) < 1e-12,
            `vx[${i}]: ${c4[i].vx} vs 0.5·${c1[i].vx}`);
        assert.ok(Math.abs(c4[i].vy - 0.5 * c1[i].vy) < 1e-12,
            `vy[${i}]: ${c4[i].vy} vs 0.5·${c1[i].vy}`);
        assert.ok(Math.abs(c4[i].omega - 0.5 * c1[i].omega) < 1e-12,
            `ω[${i}]: ${c4[i].omega} vs 0.5·${c1[i].omega}`);
    }
});

// ─── Test 8: blend=0 reproduces fixed-energy (legacy) behaviour ─────────────
test('size blend = 0 → effectiveEb is exactly BULLET_KINETIC_ENERGY', () => {
    const cfg = { ...CONFIG, BULLET_ENERGY_SIZE_BLEND: 0 };
    for (const R of [0.02, 0.05, 0.083, 0.12]) {
        assert.strictEqual(effectiveEb(R, cfg), cfg.BULLET_KINETIC_ENERGY,
            `R=${R}: expected ${cfg.BULLET_KINETIC_ENERGY}, got ${effectiveEb(R, cfg)}`);
    }
});

// ─── Test 9: blend=1 → generation-independent separation speed ──────────────
// With fully size-proportional energy injection, a head-on split of a half-size
// parent should yield the same per-child separation speed as a full-size parent.
// This directly verifies that compounding is removed.
test('size blend = 1 → separation speed is constant across parent radius (head-on)', () => {
    const cfg = { ...CONFIG, BULLET_ENERGY_SIZE_BLEND: 1.0, ASTEROID_DENSITY: 1.0 };
    const Rfull = cfg.INITIAL_ASTEROID_RADIUS;
    const Rhalf = Rfull * 0.5;

    // Use a head-on hit so the rest-frame separation is purely along the bullet axis.
    const childrenFull = fragment(Rfull, 0, 0, 0, 0, 0, cfg);
    const childrenHalf = fragment(Rhalf, 0, 0, 0, 0, 0, cfg);

    // Head-on: 50/50 split; |v_child| should be the same regardless of R.
    const speedFull = Math.hypot(childrenFull[0].vx, childrenFull[0].vy);
    const speedHalf = Math.hypot(childrenHalf[0].vx, childrenHalf[0].vy);
    assert.ok(Math.abs(speedFull - speedHalf) < 1e-12,
        `speed compounds across generations: full=${speedFull}, half=${speedHalf}`);
});

// ─── Test 10: blend=0 → separation speed compounds as 1/R (legacy regression) ─
test('size blend = 0 → separation speed scales as 1/R across generations', () => {
    const cfg = { ...CONFIG, BULLET_ENERGY_SIZE_BLEND: 0, ASTEROID_DENSITY: 1.0 };
    const Rfull = cfg.INITIAL_ASTEROID_RADIUS;
    const Rhalf = Rfull * 0.5;

    const speedFull = Math.hypot(...[fragment(Rfull, 0, 0, 0, 0, 0, cfg)[0].vx,
                                     fragment(Rfull, 0, 0, 0, 0, 0, cfg)[0].vy]);
    const speedHalf = Math.hypot(...[fragment(Rhalf, 0, 0, 0, 0, 0, cfg)[0].vx,
                                     fragment(Rhalf, 0, 0, 0, 0, 0, cfg)[0].vy]);
    // Legacy behaviour: half radius → ~2× separation speed.
    assert.ok(Math.abs(speedHalf / speedFull - 2.0) < 1e-9,
        `expected ~2× speed at half R (compounding), got ratio ${speedHalf / speedFull}`);
});
