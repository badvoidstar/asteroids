/**
 * Tests for the physics-correct asteroid fragmentation model in splitAsteroid().
 *
 * Run with:  node --test AstervoidsWeb/split-physics.test.mjs
 *
 * The pure math from splitAsteroid() is mirrored here so the tests are
 * independent of the browser environment. Each test operates on randomized
 * or targeted impact geometries.
 *
 * Model: two **independent** knobs (no shared bullet-energy budget).
 *   • DEFLECTION_KICK    — head-on parent COM Δv (refdim/s); J = M·v_kick·d̂
 *   • SEPARATION_ENERGY  — energy released into fragment separation (refdim²/s²)
 *
 * Conservation / behavioural laws verified:
 *   1. Linear momentum:   Σ m_i v_i  = M v + J,  J = M·v_kick·d̂   (~1e-10)
 *   2. Angular momentum:  Σ (m_i r_i×v_i + I_i ω_i) = I ω + r×J   (~1e-10)
 *   3. Energy decomposition (rest frame):
 *        Σ ½(m_i|v_i|²+I_i ω_i²) = ½·M·v_kick²·(1+2b²/R²) + E_sep   (~1e-10)
 *   4. Head-on hit  (offsetN = 0)   → f_small = f_large = 0.5
 *   5. Grazing hit  (|offsetN| = 1) → f_small = MIN_SPLIT_RATIO
 *   6. One-child branch: rSmall < MIN_RADIUS → exactly one child, carrying v', ω'
 *   7. Density scaling: deflection & spin are density-INDEPENDENT (velocity kick),
 *      separation alone scales as 1/√density.
 *   8. SEPARATION_ENERGY_SIZE_BLEND=0 → effective E_sep = SEPARATION_ENERGY (legacy)
 *   9. SEPARATION_ENERGY_SIZE_BLEND=1 → separation speed is generation-independent
 *  10. SEPARATION_ENERGY_SIZE_BLEND=0 → separation speed compounds as 1/R (regression)
 *  11. MASS_SPLIT_BIAS=0 → fSmall = 0.5 for any |offsetN|; bias=1 → legacy formula
 *  12. Independence: doubling DEFLECTION_KICK leaves separation speed unchanged;
 *      doubling SEPARATION_ENERGY leaves parent post-impulse v', ω' unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mirror of splitAsteroid's pure math ────────────────────────────────────
// Keep these constants and formulas in sync with AstervoidsWeb/wwwroot/index.html.

const CONFIG = {
    DEFLECTION_KICK: 1e-3,
    SEPARATION_ENERGY: 1e-4,
    MIN_SPLIT_RATIO: 0.1,
    MIN_ASTEROID_RADIUS: 0.025,
    INITIAL_ASTEROID_RADIUS: 0.083,
    ASTEROID_DENSITY: 5.0,
    SEPARATION_ENERGY_SIZE_BLEND: 0.0,
    MASS_SPLIT_BIAS: 1.0,
};

/** Effective separation energy after the size-blend mapping. */
function effectiveEsep(R, cfg = CONFIG) {
    const blend = Math.max(0, Math.min(1, cfg.SEPARATION_ENERGY_SIZE_BLEND));
    const Rref  = cfg.INITIAL_ASTEROID_RADIUS;
    const sizeMul = (1 - blend) + blend * (R / Rref) * (R / Rref);
    return Math.max(0, cfg.SEPARATION_ENERGY) * sizeMul;
}

/**
 * Core fragmentation math, extracted from splitAsteroid().
 * Returns an array of child descriptors: { r, m, vx, vy, omega, posX, posY }
 * where posX/posY are offsets from the parent COM along the separation axis.
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

    // Bullet impulse: J = M · v_kick along d̂. Independent of E_sep.
    const vKick = Math.max(0, cfg.DEFLECTION_KICK);
    const Jmag  = M * vKick;
    const Jx = Jmag * dx, Jy = Jmag * dy;

    // Post-impulse parent state.
    const vxP    = vx + Jx / M;
    const vyP    = vy + Jy / M;
    const torque = rx * Jy - ry * Jx;
    const omegaP = omega + torque / I;

    // Separation energy (independent knob, with size blend).
    const E_sep = effectiveEsep(R, cfg);

    // Mass split.
    const minRatio = Math.max(0.01, Math.min(0.5, cfg.MIN_SPLIT_RATIO));
    const massBias = Math.max(0, Math.min(1, cfg.MASS_SPLIT_BIAS ?? 1));
    const fSmall   = Math.max(minRatio, 0.5 * (1 - massBias * Math.abs(offsetN)));
    const fLarge   = 1 - fSmall;

    const rSmall = R * Math.sqrt(fSmall);
    const rLarge = R * Math.sqrt(fLarge);
    const mSmall = fSmall * M;
    const mLarge = fLarge * M;

    // Separation axis.
    const sideSign = offsetN >= 0 ? 1 : -1;
    const sx = sideSign * nx, sy = sideSign * ny;

    if (rSmall < cfg.MIN_ASTEROID_RADIUS) {
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
function lcg(seed) {
    let s = seed;
    return () => {
        s = (1664525 * s + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0x100000000;
    };
}
const rng = lcg(42);
const rand = (lo, hi) => lo + rng() * (hi - lo);

// R_min ensures rSmall = R·√fSmall ≥ MIN_RADIUS for all |offsetN| ≤ 0.95.
const R_MIN_TWO_CHILD = CONFIG.MIN_ASTEROID_RADIUS / Math.sqrt(CONFIG.MIN_SPLIT_RATIO);

const CASES = Array.from({ length: 20 }, () => ({
    R:          rand(R_MIN_TWO_CHILD * 1.01, 0.12),
    vx:         rand(-0.3, 0.3),
    vy:         rand(-0.3, 0.3),
    omega:      rand(-0.05, 0.05),
    offsetN:    rand(-0.95, 0.95),
    bulletAngle: rand(-Math.PI, Math.PI),
}));

// Helper to compute Jmag exactly the way splitAsteroid does.
function jmagFor(R, cfg = CONFIG) {
    const M = cfg.ASTEROID_DENSITY * R * R;
    return M * Math.max(0, cfg.DEFLECTION_KICK);
}

// ─── Test 1: Linear momentum conservation ───────────────────────────────────
test('linear momentum: Σ m_i v_i = M v + J, to 1e-10', () => {
    for (const { R, vx, vy, omega, offsetN, bulletAngle } of CASES) {
        const M  = CONFIG.ASTEROID_DENSITY * R * R;
        const dx = Math.cos(bulletAngle), dy = Math.sin(bulletAngle);
        const Jmag = jmagFor(R);
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
        const Jmag = jmagFor(R);
        const Jx = Jmag * dx, Jy = Jmag * dy;
        const torqueJ = rx * Jy - ry * Jx;

        const children = fragment(R, vx, vy, omega, offsetN, bulletAngle);
        const { L } = sums(children);

        const expL = I * omega + torqueJ;
        assert.ok(Math.abs(L - expL) < 1e-10,
            `L: got ${L}, expected ${expL} (R=${R}, offsetN=${offsetN}, omega=${omega})`);
    }
});

// ─── Test 3: Energy decomposition (rest frame, two-piece) ───────────────────
// Without a single E_b budget the bullet injects two independent energy quantities:
//   ΔKE_rigid = ½·M·v_kick²·(1 + 2b²/R²)
//   E_sep     = SEPARATION_ENERGY · sizeMul
// In the parent's pre-impact rest frame, total post-split KE is exactly their sum.
test('energy (rest frame): Σ KE_children = ½·M·v_kick²·leverFactor + E_sep, to 1e-10', () => {
    const restCases = Array.from({ length: 20 }, () => ({
        R:           rand(R_MIN_TWO_CHILD * 1.01, 0.12),
        vx:          0,
        vy:          0,
        omega:       0,
        offsetN:     rand(-0.95, 0.95),
        bulletAngle: rand(-Math.PI, Math.PI),
    }));

    for (const { R, vx, vy, omega, offsetN, bulletAngle } of restCases) {
        const children = fragment(R, vx, vy, omega, offsetN, bulletAngle);
        const { KE } = sums(children);

        const M = CONFIG.ASTEROID_DENSITY * R * R;
        const b = Math.max(-1, Math.min(1, offsetN)) * R;
        const leverFactor = 1 + 2 * (b * b) / (R * R);
        const dKE_rigid = 0.5 * M * CONFIG.DEFLECTION_KICK * CONFIG.DEFLECTION_KICK * leverFactor;
        const E_sep = effectiveEsep(R);
        const expected = dKE_rigid + E_sep;

        assert.ok(Math.abs(KE - expected) < 1e-10,
            `KE: got ${KE}, expected ${expected} (R=${R}, offsetN=${offsetN})`);
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
    const expected = R * Math.sqrt(0.5);
    assert.ok(Math.abs(c0.r - expected) < 1e-12, `c0.r = ${c0.r}, expected ${expected}`);
    assert.ok(Math.abs(c1.r - expected) < 1e-12, `c1.r = ${c1.r}, expected ${expected}`);
});

// ─── Test 5: Grazing → skewed split ─────────────────────────────────────────
test('grazing hit (|offsetN|=1) → f_small = MIN_SPLIT_RATIO', () => {
    const minRatio = CONFIG.MIN_SPLIT_RATIO;

    for (const sign of [1, -1]) {
        const fSmall = Math.max(minRatio, 0.5 * (1 - Math.abs(sign)));
        assert.strictEqual(fSmall, minRatio,
            `offsetN=${sign}: expected fSmall=${minRatio}, got ${fSmall}`);
    }
});

// ─── Test 6: One-child branch ────────────────────────────────────────────────
test('one-child branch: when rSmall < MIN_RADIUS, exactly one child with v\', ω\'', () => {
    const R       = 0.07;
    const vx      = 0.1, vy = -0.05, omega0 = 0.01;
    const offsetN = 1.0;
    const angle   = Math.PI / 4;

    const children = fragment(R, vx, vy, omega0, offsetN, angle);
    assert.strictEqual(children.length, 1, `expected 1 child, got ${children.length}`);

    const M  = CONFIG.ASTEROID_DENSITY * R * R;
    const I  = 0.5 * M * R * R;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const nx = -dy, ny = dx;
    const b  = offsetN * R;
    const rxD = -Math.sqrt(Math.max(0, R * R - b * b));
    const rx  = rxD * dx + b * nx;
    const ry  = rxD * dy + b * ny;
    const Jmag = jmagFor(R);
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

// ─── Test 7: Density scaling under independent-knob model ───────────────────
// With a velocity-kick deflection and an energy-driven separation:
//   ΔvCOM = J/M = v_kick   → density-INDEPENDENT
//   Δω    = (r×J)/I = 2v_kick/R · (geometry) → density-INDEPENDENT
//   s     = √(2·E_sep·m_l/(m_s·M)) ∝ 1/√ρ → scales as 1/√k
// Increasing density by k=4 should leave deflection & spin contributions unchanged
// and shrink only the separation contribution by 1/√4 = 1/2.
test('asteroid density: 4× density → deflection & spin invariant; separation by 1/2', () => {
    const R = 0.08, vx = 0.0, vy = 0.0, omega = 0.0;
    const bulletAngle = 0.7;

    const cfg1 = { ...CONFIG, ASTEROID_DENSITY: 1.0, SEPARATION_ENERGY_SIZE_BLEND: 0 };
    const cfg4 = { ...CONFIG, ASTEROID_DENSITY: 4.0, SEPARATION_ENERGY_SIZE_BLEND: 0 };

    // (a) Off-axis impact: deflection (ΔvCOM) and induced spin (ω') must be density-invariant.
    {
        const offsetN = 0.4;
        const c1 = fragment(R, vx, vy, omega, offsetN, bulletAngle, cfg1);
        const c4 = fragment(R, vx, vy, omega, offsetN, bulletAngle, cfg4);
        assert.strictEqual(c1.length, c4.length);

        const M1 = cfg1.ASTEROID_DENSITY * R * R;
        const M4 = cfg4.ASTEROID_DENSITY * R * R;
        const comV = (cs, M) => ({
            vx: cs.reduce((a, c) => a + c.m * c.vx, 0) / M,
            vy: cs.reduce((a, c) => a + c.m * c.vy, 0) / M,
        });
        const com1 = comV(c1, M1), com4 = comV(c4, M4);
        assert.ok(Math.abs(com1.vx - com4.vx) < 1e-12,
            `COM Δvx not density-invariant: ${com1.vx} vs ${com4.vx}`);
        assert.ok(Math.abs(com1.vy - com4.vy) < 1e-12,
            `COM Δvy not density-invariant: ${com1.vy} vs ${com4.vy}`);
        for (let i = 0; i < c1.length; i++) {
            assert.ok(Math.abs(c1[i].omega - c4[i].omega) < 1e-12,
                `ω[${i}]: density-dependent: ${c1[i].omega} vs ${c4[i].omega}`);
        }
    }

    // (b) Head-on impact (offsetN=0): no induced spin, so the relative velocity between
    //     the two children equals exactly the separation impulse contribution. Its
    //     magnitude scales as 1/√ρ.
    {
        const offsetN = 0;
        const c1 = fragment(R, vx, vy, omega, offsetN, bulletAngle, cfg1);
        const c4 = fragment(R, vx, vy, omega, offsetN, bulletAngle, cfg4);
        const relSpeed = (cs) => Math.hypot(cs[0].vx - cs[1].vx, cs[0].vy - cs[1].vy);
        const r1 = relSpeed(c1), r4 = relSpeed(c4);
        assert.ok(Math.abs(r4 / r1 - 0.5) < 1e-12,
            `relative separation speed should scale 1/√4 = 0.5, got ratio ${r4 / r1}`);
    }
});

// ─── Test 8: blend=0 reproduces fixed-energy (legacy) behaviour ─────────────
test('size blend = 0 → effectiveEsep is exactly SEPARATION_ENERGY', () => {
    const cfg = { ...CONFIG, SEPARATION_ENERGY_SIZE_BLEND: 0 };
    for (const R of [0.02, 0.05, 0.083, 0.12]) {
        assert.strictEqual(effectiveEsep(R, cfg), cfg.SEPARATION_ENERGY,
            `R=${R}: expected ${cfg.SEPARATION_ENERGY}, got ${effectiveEsep(R, cfg)}`);
    }
});

// ─── Test 9: blend=1 → generation-independent separation speed ──────────────
test('size blend = 1 → separation speed is constant across parent radius (head-on)', () => {
    const cfg = { ...CONFIG, SEPARATION_ENERGY_SIZE_BLEND: 1.0, ASTEROID_DENSITY: 1.0 };
    const Rfull = cfg.INITIAL_ASTEROID_RADIUS;
    const Rhalf = Rfull * 0.5;

    // Head-on hit so children fly purely along the separation axis. To isolate the
    // separation contribution from the deflection contribution (which is also velocity-
    // invariant under R changes for a fixed kick — so doesn't perturb this test), we
    // measure the relative speed between the two children: independent of v', dependent
    // only on ±s plus inherited rigid rotation (zero head-on for symmetric mass split).
    const childrenFull = fragment(Rfull, 0, 0, 0, 0, 0, cfg);
    const childrenHalf = fragment(Rhalf, 0, 0, 0, 0, 0, cfg);

    const relFull = Math.hypot(childrenFull[0].vx - childrenFull[1].vx,
                                childrenFull[0].vy - childrenFull[1].vy);
    const relHalf = Math.hypot(childrenHalf[0].vx - childrenHalf[1].vx,
                                childrenHalf[0].vy - childrenHalf[1].vy);
    assert.ok(Math.abs(relFull - relHalf) < 1e-12,
        `relative separation speed compounds across generations: full=${relFull}, half=${relHalf}`);
});

// ─── Test 10: blend=0 → separation speed compounds as 1/R (legacy regression) ─
test('size blend = 0 → relative separation speed scales as 1/R across generations', () => {
    const cfg = { ...CONFIG, SEPARATION_ENERGY_SIZE_BLEND: 0, ASTEROID_DENSITY: 1.0 };
    const Rfull = cfg.INITIAL_ASTEROID_RADIUS;
    const Rhalf = Rfull * 0.5;

    const childrenFull = fragment(Rfull, 0, 0, 0, 0, 0, cfg);
    const childrenHalf = fragment(Rhalf, 0, 0, 0, 0, 0, cfg);
    const relFull = Math.hypot(childrenFull[0].vx - childrenFull[1].vx,
                                childrenFull[0].vy - childrenFull[1].vy);
    const relHalf = Math.hypot(childrenHalf[0].vx - childrenHalf[1].vx,
                                childrenHalf[0].vy - childrenHalf[1].vy);
    // Half radius → ~2× separation speed (legacy compounding).
    assert.ok(Math.abs(relHalf / relFull - 2.0) < 1e-9,
        `expected ~2× rel speed at half R (compounding), got ratio ${relHalf / relFull}`);
});

// ─── Test 11: mass-split bias controls offset → asymmetry ───────────────────
test('mass split bias: 0 → always 50/50; 1 → legacy offset-driven split', () => {
    const R = CONFIG.INITIAL_ASTEROID_RADIUS;
    const cfgZero = { ...CONFIG, MASS_SPLIT_BIAS: 0.0 };
    const cfgHalf = { ...CONFIG, MASS_SPLIT_BIAS: 0.5 };
    const cfgOne  = { ...CONFIG, MASS_SPLIT_BIAS: 1.0 };
    const M = CONFIG.ASTEROID_DENSITY * R * R;

    for (const offsetN of [0, 0.3, 0.7, 1.0]) {
        const c0 = fragment(R, 0, 0, 0, offsetN, 0, cfgZero);
        const cH = fragment(R, 0, 0, 0, offsetN, 0, cfgHalf);
        const c1 = fragment(R, 0, 0, 0, offsetN, 0, cfgOne);

        if (c0.length === 2) {
            assert.ok(Math.abs(c0[0].m - 0.5 * M) < 1e-12 && Math.abs(c0[1].m - 0.5 * M) < 1e-12,
                `bias=0 offsetN=${offsetN}: expected 50/50 masses, got ${c0[0].m / M}, ${c0[1].m / M}`);
        }

        const expectedFSmall1 = Math.max(CONFIG.MIN_SPLIT_RATIO, 0.5 * (1 - Math.abs(offsetN)));
        if (c1.length === 2) {
            const fSmallObs = Math.min(c1[0].m, c1[1].m) / M;
            assert.ok(Math.abs(fSmallObs - expectedFSmall1) < 1e-12,
                `bias=1 offsetN=${offsetN}: expected fSmall=${expectedFSmall1}, got ${fSmallObs}`);
        }

        const expectedFSmallH = Math.max(CONFIG.MIN_SPLIT_RATIO, 0.5 * (1 - 0.5 * Math.abs(offsetN)));
        if (cH.length === 2) {
            const fSmallObs = Math.min(cH[0].m, cH[1].m) / M;
            assert.ok(Math.abs(fSmallObs - expectedFSmallH) < 1e-12,
                `bias=0.5 offsetN=${offsetN}: expected fSmall=${expectedFSmallH}, got ${fSmallObs}`);
        }
    }
});

// ─── Test 12: independence of the two knobs ─────────────────────────────────
// Doubling DEFLECTION_KICK must leave the relative separation speed (the
// observable governed by SEPARATION_ENERGY) unchanged. Doubling SEPARATION_ENERGY
// must leave the parent post-impulse v', ω' (the observables governed by
// DEFLECTION_KICK) unchanged. This is the defining property of Option B.
test('orthogonality: deflection and separation knobs decouple', () => {
    const R = 0.08;
    const offsetN = 0.4, angle = 0.5;

    const cfgBase = { ...CONFIG };
    const cfg2Kick = { ...CONFIG, DEFLECTION_KICK: 2 * CONFIG.DEFLECTION_KICK };
    const cfg2Esep = { ...CONFIG, SEPARATION_ENERGY: 2 * CONFIG.SEPARATION_ENERGY };

    const cBase = fragment(R, 0, 0, 0, offsetN, angle, cfgBase);
    const c2K   = fragment(R, 0, 0, 0, offsetN, angle, cfg2Kick);
    const c2E   = fragment(R, 0, 0, 0, offsetN, angle, cfg2Esep);

    assert.strictEqual(cBase.length, 2);
    assert.strictEqual(c2K.length, 2);
    assert.strictEqual(c2E.length, 2);

    // (a) Doubling SEPARATION_ENERGY leaves COM Δv and ω' unchanged.
    const M = CONFIG.ASTEROID_DENSITY * R * R;
    const comV = (cs) => ({
        vx: (cs[0].m * cs[0].vx + cs[1].m * cs[1].vx) / M,
        vy: (cs[0].m * cs[0].vy + cs[1].m * cs[1].vy) / M,
    });
    const cvBase = comV(cBase), cv2E = comV(c2E);
    assert.ok(Math.abs(cvBase.vx - cv2E.vx) < 1e-12, `COM vx changed by SEPARATION_ENERGY: ${cvBase.vx} vs ${cv2E.vx}`);
    assert.ok(Math.abs(cvBase.vy - cv2E.vy) < 1e-12, `COM vy changed by SEPARATION_ENERGY: ${cvBase.vy} vs ${cv2E.vy}`);
    // ω' is the same for both children; pick either.
    assert.ok(Math.abs(cBase[0].omega - c2E[0].omega) < 1e-12,
        `ω' changed by SEPARATION_ENERGY: ${cBase[0].omega} vs ${c2E[0].omega}`);

    // (b) Doubling DEFLECTION_KICK leaves the relative separation speed unchanged
    //     after subtracting the inherited rigid-body component (which depends on v', ω').
    //     The relative separation impulse is ±s along sx,sy with magnitudes
    //     +s and -s·m_s/m_l; their relative magnitude is s·(1 + m_s/m_l) = s·M/m_l.
    //     This depends only on E_sep, m_s, m_l, M — so it must equal between cBase and c2K.
    const sepRel = (cs, vKick) => {
        // relative velocity between the two children
        const dvx = cs[0].vx - cs[1].vx;
        const dvy = cs[0].vy - cs[1].vy;
        // subtract the inherited rigid-rotation diff at the two COMs.
        // v_inherited at d_s − v_inherited at d_l = ω' × (d_s − d_l)·s_hat (perp to sep axis)
        // For a head-on (zero offset) it'd be zero; here it's nonzero. Subtract by computing
        // the "would-be no-separation" relative velocity (s=0 case): the children would just
        // sit at d_s, d_l and rotate with ω'. We re-derive that analytically.
        const massBias = Math.max(0, Math.min(1, CONFIG.MASS_SPLIT_BIAS));
        const fSmall = Math.max(CONFIG.MIN_SPLIT_RATIO, 0.5 * (1 - massBias * Math.abs(offsetN)));
        const fLarge = 1 - fSmall;
        const dSmall = +R * fLarge;
        const dLarge = -R * fSmall;
        const dx = Math.cos(angle), dy = Math.sin(angle);
        const nx = -dy, ny = dx;
        const sideSign = offsetN >= 0 ? 1 : -1;
        const sx = sideSign * nx, sy = sideSign * ny;
        // ω' = torque/I (parent at rest)
        const b = offsetN * R;
        const rxN = b;
        const rxD = -Math.sqrt(Math.max(0, R * R - b * b));
        const rx  = rxD * dx + rxN * nx;
        const ry  = rxD * dy + rxN * ny;
        const Jmag = M * vKick;
        const Jx = Jmag * dx, Jy = Jmag * dy;
        const omegaP = (rx * Jy - ry * Jx) / (0.5 * M * R * R);
        // Inherited diff: (vS - vL) for s=0 is (omegaP × (dSmall - dLarge) along sep axis)
        // ω×r in 2D: (-ω·ry, ω·rx). Here r = (d·sx, d·sy).
        const inheritedDx = (-omegaP) * ((dSmall - dLarge) * sy);
        const inheritedDy = ( omegaP) * ((dSmall - dLarge) * sx);
        return Math.hypot(dvx - inheritedDx, dvy - inheritedDy);
    };

    const sBase = sepRel(cBase, CONFIG.DEFLECTION_KICK);
    const s2K   = sepRel(c2K,   2 * CONFIG.DEFLECTION_KICK);
    assert.ok(Math.abs(sBase - s2K) < 1e-12,
        `pure separation magnitude changed by DEFLECTION_KICK: base=${sBase}, 2×kick=${s2K}`);
});
