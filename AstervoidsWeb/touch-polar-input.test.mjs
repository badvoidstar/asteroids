// Unit tests for the polar-anchor touch scheme helpers
// (shortestAngleDelta + computePolarStickInput). Extracts the live functions
// from index.html so the test is always pinned to the production source —
// mirrors touch-stick-input.test.mjs.
//
// Run with: node --test AstervoidsWeb/touch-polar-input.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'wwwroot/index.html'), 'utf8');

function extractFn(signaturePrefix) {
    // Match `function NAME(args) { … }` greedily up to the next 4-space-indented
    // closing brace (the same convention used by the other test files).
    const re = new RegExp(
        `function ${signaturePrefix}\\([^)]*\\) \\{[\\s\\S]*?\\n {4}\\}`
    );
    const m = html.match(re);
    assert.ok(m, `${signaturePrefix} must be defined in index.html`);
    // eslint-disable-next-line no-eval
    return eval(`(${m[0].replace(`function ${signaturePrefix}`, 'function')})`);
}

const shortestAngleDelta = extractFn('shortestAngleDelta');
const computePolarStickInput = extractFn('computePolarStickInput');
const attainableTurnTarget = extractFn('attainableTurnTarget');

// Reference parameter set: 100 px stick radius (drives p2 / thrust scale),
// 10 px dead-zone, 50 px threshold, unit gains and unit clamps. Choices keep
// the arithmetic readable:
//   • r ≤ 10  → no input.
//   • 10 < r ≤ 50  → p1 = (r-10) / 40   (so r=30 → p1=0.5, r=50 → p1=1).
//   • r > 50  → p1=1; p2 = (r-50)/100  (so r=150 → p2=1, r=100 → p2=0.5).
const BASE_PARAMS = Object.freeze({
    radiusPx: 100,
    deadZonePx: 10,
    thresholdPx: 50,
    turnGain: 1.0,
    turnMax: 1.0,
    thrustGain: 1.0,
    thrustMax: 1.0,
    brakeGain: 1.0,
    brakeMax: 1.0,
});

// ─── shortestAngleDelta ────────────────────────────────────────────────────

test('shortestAngleDelta: identical angles → 0', () => {
    assert.equal(shortestAngleDelta(0, 0), 0);
    assert.equal(shortestAngleDelta(Math.PI / 3, Math.PI / 3), 0);
});

test('shortestAngleDelta: small positive delta', () => {
    const d = shortestAngleDelta(0.1, 0);
    assert.ok(Math.abs(d - 0.1) < 1e-12, `got ${d}`);
});

test('shortestAngleDelta: small negative delta', () => {
    const d = shortestAngleDelta(-0.1, 0);
    assert.ok(Math.abs(d + 0.1) < 1e-12, `got ${d}`);
});

test('shortestAngleDelta: wraps across ±π — prefer the short way', () => {
    // current = +3π/4 (≈135°), target = -3π/4 (≈-135°). Naive subtraction
    // gives -3π/2; the shortest signed delta is +π/2 (turn clockwise).
    const d = shortestAngleDelta(-3 * Math.PI / 4, 3 * Math.PI / 4);
    assert.ok(Math.abs(d - Math.PI / 2) < 1e-12, `got ${d}`);
});

test('shortestAngleDelta: result is always in (−π, +π]', () => {
    // Sweep target through ±10 full rotations; the wrapped result must stay
    // bounded regardless of the input's absolute magnitude.
    for (let k = -10; k <= 10; k++) {
        const targetAngle = 1.0 + 2 * Math.PI * k;
        const d = shortestAngleDelta(targetAngle, 1.0);
        assert.ok(Math.abs(d) <= Math.PI + 1e-9,
            `k=${k}, d=${d} outside (−π, +π]`);
        assert.ok(Math.abs(d) < 1e-9,
            `k=${k}: equivalent angles should produce ~0, got ${d}`);
    }
});

test('shortestAngleDelta: opposite headings → +π (signed convention)', () => {
    // Math.atan2(sin(π), cos(π)) returns +π exactly; the helper inherits
    // that convention. Code that uses Math.sign(delta) treats this as
    // “turn in the +angle direction” which is consistent on the boundary.
    const d = shortestAngleDelta(Math.PI, 0);
    assert.ok(Math.abs(Math.abs(d) - Math.PI) < 1e-9, `got ${d}`);
});

// ─── computePolarStickInput ────────────────────────────────────────────────

test('zero displacement → inactive turn/thrust, but brake is FULL (radius 0 = full brake)', () => {
    const out = computePolarStickInput(0, 0, BASE_PARAMS);
    assert.equal(out.active, false);
    assert.equal(out.radius, 0);
    assert.equal(out.turnMagnitude, 0);
    assert.equal(out.thrust, 0);
    // Brake = clamp01(1 − 0/50) * brakeGain = 1.0 * 1.0 = 1.0.
    assert.ok(Math.abs(out.brake - 1.0) < 1e-12, `brake ${out.brake}`);
});

test('within dead-zone (r ≤ DEADZONE) → inactive for turn/thrust, but brake still flows', () => {
    // dz=10 → (6, -8) gives r=10 exactly → still inactive (boundary inclusive).
    // Brake = 1 − 10/50 = 0.8 (dead-zone is the "high brake" region now).
    const out = computePolarStickInput(6, -8, BASE_PARAMS);
    assert.equal(out.active, false);
    assert.equal(out.turnMagnitude, 0);
    assert.equal(out.thrust, 0);
    assert.ok(Math.abs(out.brake - 0.8) < 1e-12, `brake ${out.brake}`);
});

test('mid-band (deadzone < r ≤ threshold): p1 ramps, brake = 1 − r/threshold, no thrust', () => {
    // r=30 → p1=(30-10)/(50-10) = 0.5; turnMagnitude = 0.5.
    // Brake decouples from p1: brake = 1 − 30/50 = 0.4.
    const out = computePolarStickInput(30, 0, BASE_PARAMS);
    assert.equal(out.active, true);
    assert.ok(Math.abs(out.radius - 30) < 1e-12);
    assert.ok(Math.abs(out.turnMagnitude - 0.5) < 1e-12, `turn ${out.turnMagnitude}`);
    assert.ok(Math.abs(out.brake - 0.4) < 1e-12, `brake ${out.brake}`);
    assert.equal(out.thrust, 0);
});

test('threshold boundary (r = threshold): p1 = 1, brake = 0, thrust still 0', () => {
    const out = computePolarStickInput(50, 0, BASE_PARAMS);
    assert.equal(out.active, true);
    assert.ok(Math.abs(out.turnMagnitude - 1.0) < 1e-12);
    assert.ok(Math.abs(out.brake - 0.0) < 1e-12);
    assert.equal(out.thrust, 0);
});

test('beyond threshold: p1 clamped at 1, p2 ramps from 0', () => {
    // r=100 → p2 = (100-50)/100 = 0.5.
    const out = computePolarStickInput(100, 0, BASE_PARAMS);
    assert.equal(out.active, true);
    assert.ok(Math.abs(out.turnMagnitude - 1.0) < 1e-12);
    assert.ok(Math.abs(out.thrust - 0.5) < 1e-12, `thrust ${out.thrust}`);
    assert.equal(out.brake, 0);
});

test('far beyond threshold: thrust clamps at thrustMax', () => {
    // r=10000 → p2 huge → clamped to thrustMax (1.0 here).
    const out = computePolarStickInput(10000, 0, BASE_PARAMS);
    assert.equal(out.thrust, BASE_PARAMS.thrustMax);
    assert.equal(out.turnMagnitude, BASE_PARAMS.turnMax);
    assert.equal(out.brake, 0);
});

test('targetAngle matches atan2(dy, dx) (screen-coord convention: +y = down)', () => {
    // Above anchor (dy<0) → angle = -π/2 (ship "up" heading convention).
    const up = computePolarStickInput(0, -30, BASE_PARAMS);
    assert.ok(Math.abs(up.targetAngle + Math.PI / 2) < 1e-12, `got ${up.targetAngle}`);
    // Right of anchor → angle = 0.
    const right = computePolarStickInput(30, 0, BASE_PARAMS);
    assert.equal(right.targetAngle, 0);
    // Below anchor (dy>0) → +π/2.
    const down = computePolarStickInput(0, 30, BASE_PARAMS);
    assert.ok(Math.abs(down.targetAngle - Math.PI / 2) < 1e-12, `got ${down.targetAngle}`);
});

test('turnGain scales p1 before the turnMax clamp', () => {
    // r=20 → p1 = (20-10)/(50-10) = 0.25, *gain 2 = 0.5.
    const out = computePolarStickInput(20, 0, { ...BASE_PARAMS, turnGain: 2.0 });
    assert.ok(Math.abs(out.turnMagnitude - 0.5) < 1e-12, `got ${out.turnMagnitude}`);
});

test('turnMax clamp is honored even after gain push', () => {
    // p1 = 0.5; gain 10 → would be 5.0, clamped to turnMax 0.4.
    const out = computePolarStickInput(30, 0,
        { ...BASE_PARAMS, turnGain: 10.0, turnMax: 0.4 });
    assert.equal(out.turnMagnitude, 0.4);
});

test('thrustGain / thrustMax follow the same clamp pattern as the rectilinear helper', () => {
    // r=100 → p2=0.5; gain 4 → 2.0; clamp to thrustMax 0.25.
    const out = computePolarStickInput(100, 0,
        { ...BASE_PARAMS, thrustGain: 4.0, thrustMax: 0.25 });
    assert.equal(out.thrust, 0.25);
});

test('brake uses (1 − r/threshold) scaled by brakeGain then clamped to brakeMax', () => {
    // r=20, threshold=50 → 1 − 20/50 = 0.6; brakeGain=1 → 0.6.
    const out = computePolarStickInput(20, 0, BASE_PARAMS);
    assert.ok(Math.abs(out.brake - 0.6) < 1e-12, `got ${out.brake}`);

    // Same r, gain 2 → 1.2, clamped to brakeMax 0.5.
    const out2 = computePolarStickInput(20, 0,
        { ...BASE_PARAMS, brakeGain: 2.0, brakeMax: 0.5 });
    assert.equal(out2.brake, 0.5);
});

test('disabling brake via brakeMax=0 zeroes brake at any radius (including dead-zone)', () => {
    const params = { ...BASE_PARAMS, brakeMax: 0 };
    for (const r of [0, 1, 8, 10, 12, 30, 49.999, 50, 80]) {
        const out = computePolarStickInput(r, 0, params);
        assert.equal(out.brake, 0, `r=${r} brake=${out.brake}`);
    }
});

test('brake is exactly zero at and beyond the threshold (by clamp on (1 − r/threshold))', () => {
    for (const r of [50, 60, 100, 1e6]) {
        const out = computePolarStickInput(r, 0, BASE_PARAMS);
        assert.equal(out.brake, 0, `r=${r} brake=${out.brake}`);
    }
});

test('brake is linear in radius across 0..threshold (dead-zone INCLUSIVE)', () => {
    // Verify the spec: r=0 → 1, r=threshold → 0, linear between, including
    // through the dead-zone (no discontinuity at r=deadZonePx).
    const threshold = BASE_PARAMS.thresholdPx;
    for (const r of [0, 1, 5, 9.999, 10, 10.001, 20, 30, 40, 49.999, 50]) {
        const out = computePolarStickInput(r, 0, BASE_PARAMS);
        const expected = Math.max(0, 1 - r / threshold);
        assert.ok(Math.abs(out.brake - expected) < 1e-9,
            `r=${r} brake=${out.brake} expected=${expected}`);
    }
});

test('brake is continuous across the dead-zone / mid-band boundary', () => {
    // The old (1 − p1) formula made brake jump from 0 (at r=deadZonePx,
    // since active was false) to 1.0 just past it. The new formulation
    // must be smooth: a tiny step in r produces a tiny step in brake.
    const r1 = BASE_PARAMS.deadZonePx;          // 10
    const r2 = BASE_PARAMS.deadZonePx + 1e-6;   // 10 + epsilon
    const b1 = computePolarStickInput(r1, 0, BASE_PARAMS).brake;
    const b2 = computePolarStickInput(r2, 0, BASE_PARAMS).brake;
    assert.ok(Math.abs(b1 - b2) < 1e-6, `b1=${b1} b2=${b2}`);
});

test('isotropy: same radius at different angles produces same magnitudes', () => {
    const r = 30;
    const samples = [];
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 2 * Math.PI;
        samples.push(computePolarStickInput(r * Math.cos(a), r * Math.sin(a), BASE_PARAMS));
    }
    const first = samples[0];
    for (const s of samples) {
        assert.ok(Math.abs(s.radius - first.radius) < 1e-9);
        assert.ok(Math.abs(s.turnMagnitude - first.turnMagnitude) < 1e-9);
        assert.ok(Math.abs(s.thrust - first.thrust) < 1e-9);
        assert.ok(Math.abs(s.brake - first.brake) < 1e-9);
    }
});

test('degenerate threshold ≤ deadzone: p1 jumps to 1 immediately past dead-zone', () => {
    // The helper enforces threshold > deadzone with a 1e-6 epsilon so the
    // ramp never divides by zero. With threshold misconfigured ≤ deadzone,
    // any r > deadzone effectively saturates p1 at 1 (so turn = turnMax,
    // brake = 0). Thrust uses (r − thresholdEpsilon)/radiusPx, which is
    // tiny here.
    const params = { ...BASE_PARAMS, thresholdPx: 5 }; // < deadZonePx (10)
    const out = computePolarStickInput(20, 0, params);
    assert.equal(out.active, true);
    assert.ok(Math.abs(out.turnMagnitude - 1.0) < 1e-6);
    assert.equal(out.brake, 0);
});

test('graceful with zero radiusPx (no NaN / no infinity)', () => {
    const params = { ...BASE_PARAMS, radiusPx: 0 };
    const out = computePolarStickInput(60, 0, params);
    assert.ok(Number.isFinite(out.turnMagnitude));
    assert.ok(Number.isFinite(out.thrust));
    assert.ok(Number.isFinite(out.brake));
    // p1 saturates → turnMagnitude = turnMax; p2 is huge → thrust clamps to thrustMax.
    assert.equal(out.turnMagnitude, params.turnMax);
    assert.equal(out.thrust, params.thrustMax);
});

// ─── attainableTurnTarget ──────────────────────────────────────────────────
//
// Reference physics for these tests:
//   rate (SHIP_TURN_SPEED default) = 0.12 rad/frame
//   dt = 1 (one 60fps frame)
//   At maxMagnitude = 1.0 the ship sweeps 0.12 rad in one frame.
//   At maxMagnitude = 0.5 the ship sweeps 0.06 rad in one frame.
const TURN_RATE = 0.12;

test('attainableTurnTarget: delta=0 → returns 0 (idle)', () => {
    assert.equal(attainableTurnTarget(0, 1.0, TURN_RATE, 1), 0);
});

test('attainableTurnTarget: maxMagnitude=0 → returns 0 regardless of delta', () => {
    assert.equal(attainableTurnTarget(0.5, 0, TURN_RATE, 1), 0);
    assert.equal(attainableTurnTarget(-0.5, 0, TURN_RATE, 1), 0);
});

test('attainableTurnTarget: large delta → returns ±maxMagnitude (full magnitude)', () => {
    // |delta|=0.5 ≫ 0.12 → command full 1.0.
    assert.equal(attainableTurnTarget(0.5, 1.0, TURN_RATE, 1), 1.0);
    assert.equal(attainableTurnTarget(-0.5, 1.0, TURN_RATE, 1), -1.0);
});

test('attainableTurnTarget: delta exactly at attainable-step → returns ±maxMagnitude', () => {
    // |delta| = rate · mag · dt → exactly attainable at full mag.
    const delta = TURN_RATE * 1.0 * 1; // 0.12
    assert.equal(attainableTurnTarget(delta, 1.0, TURN_RATE, 1), 1.0);
    assert.equal(attainableTurnTarget(-delta, 1.0, TURN_RATE, 1), -1.0);
});

test('attainableTurnTarget: small delta → returns delta/(rate·dt), lands exactly on target', () => {
    // |delta|=0.06 with rate 0.12, dt 1 → command 0.5 (half magnitude).
    // Verify by simulating one Ship.update step: angle += rate · turnInput · dt.
    const delta = 0.06;
    const cmd = attainableTurnTarget(delta, 1.0, TURN_RATE, 1);
    assert.ok(Math.abs(cmd - 0.5) < 1e-12, `cmd=${cmd}`);
    const stepped = TURN_RATE * cmd * 1; // angle advanced by this much
    assert.ok(Math.abs(stepped - delta) < 1e-12,
        `stepped=${stepped} should land exactly on delta=${delta}`);
});

test('attainableTurnTarget: negative small delta lands exactly (preserves sign)', () => {
    const delta = -0.06;
    const cmd = attainableTurnTarget(delta, 1.0, TURN_RATE, 1);
    assert.ok(Math.abs(cmd + 0.5) < 1e-12, `cmd=${cmd}`);
    const stepped = TURN_RATE * cmd * 1;
    assert.ok(Math.abs(stepped - delta) < 1e-12);
});

test('attainableTurnTarget: respects maxMagnitude cap even when |delta| would justify more', () => {
    // p1=0.5 cap. Even with a large delta we never command more than 0.5.
    assert.equal(attainableTurnTarget(0.5, 0.5, TURN_RATE, 1), 0.5);
    assert.equal(attainableTurnTarget(-0.5, 0.5, TURN_RATE, 1), -0.5);
});

test('attainableTurnTarget: cap scales with maxMagnitude (the saturation knee moves)', () => {
    // With maxMagnitude=0.5 the per-frame reach is 0.06 rad. A delta of 0.03
    // is below that, so command = 0.03 / (0.12 · 1) = 0.25.
    const cmd = attainableTurnTarget(0.03, 0.5, TURN_RATE, 1);
    assert.ok(Math.abs(cmd - 0.25) < 1e-12, `cmd=${cmd}`);
    // Verify exact landing.
    assert.ok(Math.abs(TURN_RATE * cmd * 1 - 0.03) < 1e-12);
});

test('attainableTurnTarget: dt scaling — half-step frame allows half the angular reach', () => {
    // dt=0.5 → per-frame reach at full mag = 0.06. delta=0.06 attains full mag.
    assert.equal(attainableTurnTarget(0.06, 1.0, TURN_RATE, 0.5), 1.0);
    // delta=0.03 → command 0.5 (because 0.03 / (0.12 · 0.5) = 0.5).
    const cmd = attainableTurnTarget(0.03, 1.0, TURN_RATE, 0.5);
    assert.ok(Math.abs(cmd - 0.5) < 1e-12, `cmd=${cmd}`);
    assert.ok(Math.abs(TURN_RATE * cmd * 0.5 - 0.03) < 1e-12);
});

test('attainableTurnTarget: zero or negative dt/rate → 0 (no physical step prescribable)', () => {
    assert.equal(attainableTurnTarget(0.5, 1.0, TURN_RATE, 0), 0);
    assert.equal(attainableTurnTarget(0.5, 1.0, 0, 1), 0);
    assert.equal(attainableTurnTarget(0.5, 1.0, -1, 1), 0);
    assert.equal(attainableTurnTarget(0.5, 1.0, TURN_RATE, -1), 0);
});

test('attainableTurnTarget: simulated overshoot scenario settles in one step (no oscillation)', () => {
    // Setup: ship at angle 0, target angle = 0.05 rad. Full-magnitude bang-
    // bang would command 1.0 → step 0.12, overshoot to 0.12 - 0.05 = 0.07
    // past the target. Next frame |delta|=0.07, sign flips, repeat → wobble.
    // With the attainable clamp the controller commands |cmd| = 0.05/0.12 =
    // 0.4166…, the ship advances by exactly 0.05 rad, and |delta| → 0.
    let shipAngle = 0;
    const target = 0.05;
    const delta = shortestAngleDelta(target, shipAngle);
    const cmd = attainableTurnTarget(delta, 1.0, TURN_RATE, 1);
    shipAngle += TURN_RATE * cmd * 1;
    assert.ok(Math.abs(shipAngle - target) < 1e-12,
        `ship landed at ${shipAngle}, expected ${target}`);
    const nextDelta = shortestAngleDelta(target, shipAngle);
    assert.ok(Math.abs(nextDelta) < 1e-12, `residual delta ${nextDelta}`);
});

test('attainableTurnTarget: works across the ±π wrap boundary', () => {
    // Ship at +3π/4, target at -3π/4: shortest delta = +π/2 (turn +).
    // π/2 ≫ 0.12 → full magnitude.
    const delta = shortestAngleDelta(-3 * Math.PI / 4, 3 * Math.PI / 4);
    const cmd = attainableTurnTarget(delta, 1.0, TURN_RATE, 1);
    assert.equal(cmd, 1.0);
});
