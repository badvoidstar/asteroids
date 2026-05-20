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

test('zero displacement → inactive, all zero', () => {
    const out = computePolarStickInput(0, 0, BASE_PARAMS);
    assert.equal(out.active, false);
    assert.equal(out.radius, 0);
    assert.equal(out.turnMagnitude, 0);
    assert.equal(out.thrust, 0);
    assert.equal(out.brake, 0);
});

test('within dead-zone (r ≤ DEADZONE) → inactive, no input', () => {
    // dz=10 → (6, -8) gives r=10 exactly → still inactive (boundary inclusive).
    const out = computePolarStickInput(6, -8, BASE_PARAMS);
    assert.equal(out.active, false);
    assert.equal(out.turnMagnitude, 0);
    assert.equal(out.thrust, 0);
    assert.equal(out.brake, 0);
});

test('mid-band (deadzone < r ≤ threshold): p1 ramps, brake = 1 − p1, no thrust', () => {
    // r=30 → p1=(30-10)/(50-10) = 0.5.
    // turnMagnitude = 0.5, brake = 0.5, thrust = 0.
    const out = computePolarStickInput(30, 0, BASE_PARAMS);
    assert.equal(out.active, true);
    assert.ok(Math.abs(out.radius - 30) < 1e-12);
    assert.ok(Math.abs(out.turnMagnitude - 0.5) < 1e-12, `turn ${out.turnMagnitude}`);
    assert.ok(Math.abs(out.brake - 0.5) < 1e-12, `brake ${out.brake}`);
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

test('brake uses (1 − p1) scaled by brakeGain then clamped to brakeMax', () => {
    // r=20 → p1=0.25, 1−p1 = 0.75; gain 1 → 0.75.
    const out = computePolarStickInput(20, 0, BASE_PARAMS);
    assert.ok(Math.abs(out.brake - 0.75) < 1e-12, `got ${out.brake}`);

    // Same r, gain 2 → 1.5, clamped to brakeMax 0.5.
    const out2 = computePolarStickInput(20, 0,
        { ...BASE_PARAMS, brakeGain: 2.0, brakeMax: 0.5 });
    assert.equal(out2.brake, 0.5);
});

test('disabling brake via brakeMax=0 zeroes brake at any radius', () => {
    const params = { ...BASE_PARAMS, brakeMax: 0 };
    for (const r of [12, 30, 49.999, 50, 80]) {
        const out = computePolarStickInput(r, 0, params);
        assert.equal(out.brake, 0, `r=${r} brake=${out.brake}`);
    }
});

test('brake is exactly zero at and beyond the threshold (by construction of 1 − p1)', () => {
    for (const r of [50, 60, 100, 1e6]) {
        const out = computePolarStickInput(r, 0, BASE_PARAMS);
        assert.equal(out.brake, 0, `r=${r} brake=${out.brake}`);
    }
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
