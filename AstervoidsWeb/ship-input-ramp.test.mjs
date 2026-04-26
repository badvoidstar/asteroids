// Unit tests for the ship input-ramping helper.
// Run with: node --test AstervoidsWeb/ship-input-ramp.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Extract the rampInputToward function from the index.html script section.
const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'wwwroot/index.html'), 'utf8');
const fnMatch = html.match(
    /function rampInputToward\(current, target, accelTime, decelTime, dtSec\) \{[\s\S]*?\n {4}\}/
);
assert.ok(fnMatch, 'rampInputToward must be defined in index.html');
// eslint-disable-next-line no-eval
const rampInputToward = eval(`(${fnMatch[0].replace('function rampInputToward', 'function')})`);

const FRAME_60 = 1 / 60; // dtSec for one frame at 60fps

test('returns target immediately when current === target', () => {
    assert.equal(rampInputToward(0, 0, 0.5, 0.5, FRAME_60), 0);
    assert.equal(rampInputToward(1, 1, 0.5, 0.5, FRAME_60), 1);
    assert.equal(rampInputToward(-1, -1, 0.5, 0.5, FRAME_60), -1);
});

test('zero accel/decel time snaps instantly (default thrust mirrors prior behavior)', () => {
    // Default thrust ramp times are 0 → behavior must be identical to a binary toggle.
    assert.equal(rampInputToward(0, 1, 0, 0, FRAME_60), 1);
    assert.equal(rampInputToward(1, 0, 0, 0, FRAME_60), 0);
    assert.equal(rampInputToward(0.4, 1, 0, 0, FRAME_60), 1);
    assert.equal(rampInputToward(0.4, 0, 0, 0, FRAME_60), 0);
});

test('ramps from 0 to 1 over accelTime seconds', () => {
    // 0.5s ramp: after 30 frames (0.5s) we should reach 1.
    let v = 0;
    for (let i = 0; i < 30; i++) {
        v = rampInputToward(v, 1, 0.5, 0.5, FRAME_60);
    }
    assert.ok(Math.abs(v - 1) < 1e-9, `expected 1, got ${v}`);

    // After only 15 frames (0.25s) we should be at ~0.5.
    v = 0;
    for (let i = 0; i < 15; i++) {
        v = rampInputToward(v, 1, 0.5, 0.5, FRAME_60);
    }
    assert.ok(Math.abs(v - 0.5) < 1e-9, `expected 0.5, got ${v}`);
});

test('ramps from 1 to 0 over decelTime seconds', () => {
    let v = 1;
    for (let i = 0; i < 30; i++) {
        v = rampInputToward(v, 0, 0.5, 0.5, FRAME_60);
    }
    assert.ok(Math.abs(v) < 1e-9, `expected 0, got ${v}`);
});

test('clamps at target and never overshoots', () => {
    // Big dtSec relative to ramp time → must clamp.
    assert.equal(rampInputToward(0, 1, 0.1, 0.1, 10), 1);
    assert.equal(rampInputToward(0.99, 1, 0.5, 0.5, FRAME_60), 1, 'should clamp to 1, not overshoot');
    assert.equal(rampInputToward(-0.99, -1, 0.5, 0.5, FRAME_60), -1);
    assert.equal(rampInputToward(0.005, 0, 0.5, 0.5, FRAME_60), 0, 'should clamp to 0');
});

test('independent accel and decel times', () => {
    // Fast accel (0.1s), slow decel (1.0s)
    // After 0.05s of acceleration from 0, should be ~0.5.
    let v = 0;
    v = rampInputToward(v, 1, 0.1, 1.0, 0.05);
    assert.ok(Math.abs(v - 0.5) < 1e-9, `expected ~0.5 after fast accel, got ${v}`);

    // After 0.5s of deceleration from 1, should be ~0.5.
    v = 1;
    v = rampInputToward(v, 0, 0.1, 1.0, 0.5);
    assert.ok(Math.abs(v - 0.5) < 1e-9, `expected ~0.5 after slow decel, got ${v}`);
});

test('direction reversal: decelerates through zero then accelerates the other way', () => {
    // accel = decel = 0.5s. Currently turning left at -1; user presses right (target +1).
    // Should take 0.5s to decel to 0, then 0.5s to accel to +1 = 1.0s total.
    let v = -1;
    for (let i = 0; i < 60; i++) {
        v = rampInputToward(v, 1, 0.5, 0.5, FRAME_60);
    }
    assert.ok(Math.abs(v - 1) < 1e-9, `expected +1 after full reversal, got ${v}`);

    // Halfway through (30 frames = 0.5s) we should be at ~0 (at the zero crossing).
    v = -1;
    for (let i = 0; i < 30; i++) {
        v = rampInputToward(v, 1, 0.5, 0.5, FRAME_60);
    }
    assert.ok(Math.abs(v) < 1e-9, `expected ~0 at midpoint of reversal, got ${v}`);
});

test('reversal in a single large frame uses leftover time for accel phase', () => {
    // current=-0.5, target=+1, accel=decel=0.5s, dtSec=1.0s.
    // Phase 1 (decel): -0.5 → 0 consumes 0.25s. Remaining 0.75s.
    // Phase 2 (accel): 0 → +1 needs 0.5s; remaining 0.75s ≥ 0.5s, so clamps to 1.
    const v = rampInputToward(-0.5, 1, 0.5, 0.5, 1.0);
    assert.ok(Math.abs(v - 1) < 1e-9, `expected 1, got ${v}`);

    // current=-0.5, target=+1, dtSec=0.4s.
    // Phase 1: 0.25s used, value=0; remaining 0.15s.
    // Phase 2: 0.15s / 0.5s = 0.3.
    const v2 = rampInputToward(-0.5, 1, 0.5, 0.5, 0.4);
    assert.ok(Math.abs(v2 - 0.3) < 1e-9, `expected 0.3, got ${v2}`);
});

test('symmetric for negative targets', () => {
    let v = 0;
    for (let i = 0; i < 30; i++) {
        v = rampInputToward(v, -1, 0.5, 0.5, FRAME_60);
    }
    assert.ok(Math.abs(v + 1) < 1e-9, `expected -1, got ${v}`);
});
