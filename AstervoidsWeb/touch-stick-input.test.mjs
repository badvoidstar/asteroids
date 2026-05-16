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
    /function computeStickInput\(dx, dy, refPx, params\) \{[\s\S]*?\n {4}\}/
);
assert.ok(fnMatch, 'computeStickInput must be defined in index.html');
// eslint-disable-next-line no-eval
const computeStickInput = eval(`(${fnMatch[0].replace('function computeStickInput', 'function')})`);

// Reference parameter set: refPx=1000 px, radius=10% (=100 px), deadzone=1% (=10 px),
// unit gain, unit clamps. Keeps the arithmetic readable: 100 px displacement past
// the dead-zone → input magnitude 1.0.
const REF_PX = 1000;
const BASE_PARAMS = Object.freeze({
    radiusFrac: 0.10,
    deadzoneFrac: 0.01,
    turnGain: 1.0,
    turnMax: 1.0,
    thrustGain: 1.0,
    thrustMax: 1.0,
    brakeGain: 1.0,
    brakeMax: 1.0,
});

test('zero displacement → no input', () => {
    const out = computeStickInput(0, 0, REF_PX, BASE_PARAMS);
    assert.equal(out.turn, 0);
    assert.equal(out.thrust, 0);
    assert.equal(out.brake, 0);
});

test('within dead-zone → no input', () => {
    // deadzone = 10 px in this setup; ±5 px on each axis must be ignored.
    const out = computeStickInput(5, -5, REF_PX, BASE_PARAMS);
    assert.equal(out.turn, 0);
    assert.equal(out.thrust, 0);
    assert.equal(out.brake, 0);
});

test('dead-zone boundary maps to zero (inclusive)', () => {
    // |dx| == deadzonePx → xMag == 0 → input stays at 0.
    const out = computeStickInput(10, 10, REF_PX, BASE_PARAMS);
    assert.equal(out.turn, 0);
    assert.equal(out.brake, 0);
});

test('lateral right → positive turn proportional past dead-zone', () => {
    // dx = 60 px, deadzone 10, radius 100 → xMag=50 → xNorm=0.5 → turn=0.5
    const out = computeStickInput(60, 0, REF_PX, BASE_PARAMS);
    assert.ok(Math.abs(out.turn - 0.5) < 1e-12, `got ${out.turn}`);
    assert.equal(out.thrust, 0);
    assert.equal(out.brake, 0);
});

test('lateral left → negative turn, symmetric', () => {
    const out = computeStickInput(-60, 0, REF_PX, BASE_PARAMS);
    assert.ok(Math.abs(out.turn + 0.5) < 1e-12, `got ${out.turn}`);
});

test('turn clamps at ±turnMax even when displacement exceeds radius', () => {
    const out = computeStickInput(500, 0, REF_PX, BASE_PARAMS);
    assert.equal(out.turn, 1.0);
    const out2 = computeStickInput(-500, 0, REF_PX, BASE_PARAMS);
    assert.equal(out2.turn, -1.0);
});

test('turnGain scales the linear slope before the clamp', () => {
    // gain=2: 30 px (xMag=20) → xNorm=0.2 → turn=0.4 (still under clamp).
    const out = computeStickInput(30, 0, REF_PX, { ...BASE_PARAMS, turnGain: 2.0 });
    assert.ok(Math.abs(out.turn - 0.4) < 1e-12, `got ${out.turn}`);
});

test('turnMax clamp is honored after gain', () => {
    // gain=4 + dx=60 (xNorm=0.5) → raw turn=2.0 → clamps to turnMax=0.5
    const out = computeStickInput(60, 0, REF_PX, { ...BASE_PARAMS, turnGain: 4.0, turnMax: 0.5 });
    assert.equal(out.turn, 0.5);
});

test('upward displacement → thrust only, no brake', () => {
    // dy = -60 (finger above anchor): yMag=50 → yNorm=0.5 → thrust=0.5
    const out = computeStickInput(0, -60, REF_PX, BASE_PARAMS);
    assert.ok(Math.abs(out.thrust - 0.5) < 1e-12, `got ${out.thrust}`);
    assert.equal(out.brake, 0);
});

test('downward displacement → brake only, no thrust (no reverse-thrust path)', () => {
    // dy = +60: brake=0.5, thrust=0 — this is the key requirement of the new scheme.
    const out = computeStickInput(0, 60, REF_PX, BASE_PARAMS);
    assert.equal(out.thrust, 0);
    assert.ok(Math.abs(out.brake - 0.5) < 1e-12, `got ${out.brake}`);
});

test('thrust and brake have independent gain/max knobs', () => {
    // thrustGain=1, thrustMax=0.25 → thrust clamps at 0.25 well below brake max.
    // brakeGain=2, brakeMax=1.0   → brake doubles the slope.
    const params = { ...BASE_PARAMS, thrustGain: 1.0, thrustMax: 0.25, brakeGain: 2.0, brakeMax: 1.0 };
    // dy=-60 → yNorm=0.5 → raw thrust=0.5 → clamps to 0.25.
    const up = computeStickInput(0, -60, REF_PX, params);
    assert.equal(up.thrust, 0.25);
    assert.equal(up.brake, 0);
    // dy=+30 → yMag=20 → yNorm=0.2 → raw brake=0.4.
    const down = computeStickInput(0, 30, REF_PX, params);
    assert.equal(down.thrust, 0);
    assert.ok(Math.abs(down.brake - 0.4) < 1e-12, `got ${down.brake}`);
});

test('disabling brake via brakeMax=0 zeroes brake regardless of input', () => {
    const params = { ...BASE_PARAMS, brakeMax: 0 };
    const out = computeStickInput(0, 200, REF_PX, params);
    assert.equal(out.brake, 0);
});

test('refPx scales the displacement-to-input mapping (device-rotation-safe)', () => {
    // Halving refPx halves both radius and deadzone (in px), so the same dx
    // produces double the normalized input. Same gain knobs, smaller screen.
    const big = computeStickInput(60, 0, 1000, BASE_PARAMS);
    const small = computeStickInput(30, 0, 500, BASE_PARAMS);
    assert.ok(Math.abs(big.turn - small.turn) < 1e-12,
        `expected equal mapping after halving both refPx and dx; got ${big.turn} vs ${small.turn}`);
});

test('combined diagonal: turn + thrust simultaneously', () => {
    // dx=60 (turn=+0.5), dy=-60 (thrust=+0.5)
    const out = computeStickInput(60, -60, REF_PX, BASE_PARAMS);
    assert.ok(Math.abs(out.turn - 0.5) < 1e-12);
    assert.ok(Math.abs(out.thrust - 0.5) < 1e-12);
    assert.equal(out.brake, 0);
});

test('combined diagonal: turn + brake simultaneously', () => {
    // dx=-60 (turn=-0.5), dy=+60 (brake=+0.5)
    const out = computeStickInput(-60, 60, REF_PX, BASE_PARAMS);
    assert.ok(Math.abs(out.turn + 0.5) < 1e-12);
    assert.equal(out.thrust, 0);
    assert.ok(Math.abs(out.brake - 0.5) < 1e-12);
});

test('zero-gain on an axis yields zero on that axis regardless of input', () => {
    const params = { ...BASE_PARAMS, turnGain: 0, thrustGain: 0, brakeGain: 0 };
    const out = computeStickInput(200, -200, REF_PX, params);
    assert.equal(out.turn, 0);
    assert.equal(out.thrust, 0);
    const out2 = computeStickInput(200, 200, REF_PX, params);
    assert.equal(out2.brake, 0);
});

test('graceful with zero radius (no NaN / no infinity)', () => {
    // radiusFrac=0 collapses to the minimum-radius epsilon inside the helper.
    // Result should still saturate at the clamp without producing NaN. Use a
    // displacement that clears the dead-zone (deadzonePx=10 at refPx=1000).
    const params = { ...BASE_PARAMS, radiusFrac: 0 };
    const out = computeStickInput(20, -20, REF_PX, params);
    assert.ok(Number.isFinite(out.turn));
    assert.ok(Number.isFinite(out.thrust));
    assert.ok(Number.isFinite(out.brake));
    assert.equal(out.turn, params.turnMax);
    assert.equal(out.thrust, params.thrustMax);
});
