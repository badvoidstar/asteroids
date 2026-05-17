// Unit tests for the virtual-stick touch scheme input helper.
// Run with: node --test AstervoidsWeb/touch-stick-input.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Extract computeStickInput from the index.html script section so the test
// always exercises the live source (mirrors ship-input-ramp.test.mjs).
const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'wwwroot/index.html'), 'utf8');
const fnMatch = html.match(
    /function computeStickInput\(dx, dy, params\) \{[\s\S]*?\n {4}\}/
);
assert.ok(fnMatch, 'computeStickInput must be defined in index.html');
// eslint-disable-next-line no-eval
const computeStickInput = eval(`(${fnMatch[0].replace('function computeStickInput', 'function')})`);

// Reference parameter set: 100 px stick radius, 10 px deadzone on both axes,
// unit gain, unit clamps. Keeps the arithmetic readable: 100 px of finger
// travel past the dead-zone → input magnitude 1.0.
const BASE_PARAMS = Object.freeze({
    radiusPx: 100,
    turnDeadzonePx: 10,
    thrustDeadzonePx: 10,
    turnGain: 1.0,
    turnMax: 1.0,
    thrustGain: 1.0,
    thrustMax: 1.0,
    brakeGain: 1.0,
    brakeMax: 1.0,
});

test('zero displacement → no input', () => {
    const out = computeStickInput(0, 0, BASE_PARAMS);
    assert.equal(out.turn, 0);
    assert.equal(out.thrust, 0);
    assert.equal(out.brake, 0);
});

test('within dead-zone → no input', () => {
    const out = computeStickInput(5, -5, BASE_PARAMS);
    assert.equal(out.turn, 0);
    assert.equal(out.thrust, 0);
    assert.equal(out.brake, 0);
});

test('dead-zone boundary maps to zero (inclusive)', () => {
    const out = computeStickInput(10, 10, BASE_PARAMS);
    assert.equal(out.turn, 0);
    assert.equal(out.brake, 0);
});

test('lateral right → positive turn proportional past dead-zone', () => {
    // dx = 60 px, turn dz 10, radius 100 → xMag=50 → xNorm=0.5 → turn=0.5
    const out = computeStickInput(60, 0, BASE_PARAMS);
    assert.ok(Math.abs(out.turn - 0.5) < 1e-12, `got ${out.turn}`);
    assert.equal(out.thrust, 0);
    assert.equal(out.brake, 0);
});

test('lateral left → negative turn, symmetric', () => {
    const out = computeStickInput(-60, 0, BASE_PARAMS);
    assert.ok(Math.abs(out.turn + 0.5) < 1e-12, `got ${out.turn}`);
});

test('turn clamps at ±turnMax even when displacement exceeds radius', () => {
    const out = computeStickInput(500, 0, BASE_PARAMS);
    assert.equal(out.turn, 1.0);
    const out2 = computeStickInput(-500, 0, BASE_PARAMS);
    assert.equal(out2.turn, -1.0);
});

test('turnGain scales the linear slope before the clamp', () => {
    const out = computeStickInput(30, 0, { ...BASE_PARAMS, turnGain: 2.0 });
    assert.ok(Math.abs(out.turn - 0.4) < 1e-12, `got ${out.turn}`);
});

test('turnMax clamp is honored after gain', () => {
    const out = computeStickInput(60, 0, { ...BASE_PARAMS, turnGain: 4.0, turnMax: 0.5 });
    assert.equal(out.turn, 0.5);
});

test('upward displacement → thrust only, no brake', () => {
    const out = computeStickInput(0, -60, BASE_PARAMS);
    assert.ok(Math.abs(out.thrust - 0.5) < 1e-12, `got ${out.thrust}`);
    assert.equal(out.brake, 0);
});

test('downward displacement → brake only, no thrust (no reverse-thrust path)', () => {
    const out = computeStickInput(0, 60, BASE_PARAMS);
    assert.equal(out.thrust, 0);
    assert.ok(Math.abs(out.brake - 0.5) < 1e-12, `got ${out.brake}`);
});

test('thrust and brake have independent gain/max knobs', () => {
    const params = { ...BASE_PARAMS, thrustGain: 1.0, thrustMax: 0.25, brakeGain: 2.0, brakeMax: 1.0 };
    const up = computeStickInput(0, -60, params);
    assert.equal(up.thrust, 0.25);
    assert.equal(up.brake, 0);
    const down = computeStickInput(0, 30, params);
    assert.equal(down.thrust, 0);
    assert.ok(Math.abs(down.brake - 0.4) < 1e-12, `got ${down.brake}`);
});

test('disabling brake via brakeMax=0 zeroes brake regardless of input', () => {
    const params = { ...BASE_PARAMS, brakeMax: 0 };
    const out = computeStickInput(0, 200, params);
    assert.equal(out.brake, 0);
});

test('turn and thrust dead-zones are independent', () => {
    // turnDz=5 px, thrustDz=50 px. A small drag (20,-30) should engage turn
    // (|dx|=20 > 5) but NOT thrust (|dy|=30 < 50). Core feature enabled by
    // splitting the dead-zone into per-axis knobs.
    const params = { ...BASE_PARAMS, turnDeadzonePx: 5, thrustDeadzonePx: 50 };
    const out = computeStickInput(20, -30, params);
    assert.ok(out.turn > 0, `expected turn > 0, got ${out.turn}`);
    assert.equal(out.thrust, 0);
    const params2 = { ...BASE_PARAMS, turnDeadzonePx: 50, thrustDeadzonePx: 5 };
    const out2 = computeStickInput(30, -60, params2);
    assert.equal(out2.turn, 0);
    assert.ok(out2.thrust > 0, `expected thrust > 0, got ${out2.thrust}`);
});

test('combined diagonal: turn + thrust simultaneously', () => {
    const out = computeStickInput(60, -60, BASE_PARAMS);
    assert.ok(Math.abs(out.turn - 0.5) < 1e-12);
    assert.ok(Math.abs(out.thrust - 0.5) < 1e-12);
    assert.equal(out.brake, 0);
});

test('combined diagonal: turn + brake simultaneously', () => {
    const out = computeStickInput(-60, 60, BASE_PARAMS);
    assert.ok(Math.abs(out.turn + 0.5) < 1e-12);
    assert.equal(out.thrust, 0);
    assert.ok(Math.abs(out.brake - 0.5) < 1e-12);
});

test('zero-gain on an axis yields zero on that axis regardless of input', () => {
    const params = { ...BASE_PARAMS, turnGain: 0, thrustGain: 0, brakeGain: 0 };
    const out = computeStickInput(200, -200, params);
    assert.equal(out.turn, 0);
    assert.equal(out.thrust, 0);
    const out2 = computeStickInput(200, 200, params);
    assert.equal(out2.brake, 0);
});

test('graceful with zero radius (no NaN / no infinity)', () => {
    // radiusPx=0 collapses to the minimum-radius epsilon inside the helper.
    const params = { ...BASE_PARAMS, radiusPx: 0 };
    const out = computeStickInput(20, -20, params);
    assert.ok(Number.isFinite(out.turn));
    assert.ok(Number.isFinite(out.thrust));
    assert.ok(Number.isFinite(out.brake));
    assert.equal(out.turn, params.turnMax);
    assert.equal(out.thrust, params.thrustMax);
});
