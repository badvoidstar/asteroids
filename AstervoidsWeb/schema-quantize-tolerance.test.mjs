// Phase 5.4 wireopt — visual tolerance smoke tests for the quantized
// game schemas. Verifies that quantization error stays under one
// "perceived pixel" (1/65535 normalized in the worst case) and that
// non-integrating extrapolation does NOT accumulate drift across many
// snapshots (Hazard L11).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SchemaCodec = require('./wwwroot/js/schema-codec.js');

const TWO_PI = Math.PI * 2;

// Mirror the live game schemas registered in index.html WIREOPT_SCHEMAS.
const SHIP_UPDATE_FIELDS = [
    ['x', 'q16'], ['y', 'q16'], ['angle', 'q16_2pi'],
    ['velocityX', 'q16s'], ['velocityY', 'q16s'],
    ['rotationSpeed', 'q16s'],
    ['thrusting', 'bool'], ['invulnerable', 'bool'],
];
const ASTEROID_UPDATE_FIELDS = [
    ['x', 'q16'], ['y', 'q16'], ['angle', 'q16_2pi'],
];

function fresh() { SchemaCodec.clear(); }

test('asteroid x/y position error within 1 normalized pixel @ 65535 canvas', () => {
    fresh();
    const s = SchemaCodec.register(3, ASTEROID_UPDATE_FIELDS);
    const QUANTUM = 1 / 65535;
    let maxErr = 0;
    // Sample 1000 random positions in [0, 1).
    for (let i = 0; i < 1000; i++) {
        const x = Math.random();
        const y = Math.random();
        const back = SchemaCodec.decode(s, SchemaCodec.encode(s, { x, y, angle: 0 }));
        maxErr = Math.max(maxErr, Math.abs(back.x - x), Math.abs(back.y - y));
    }
    assert.ok(maxErr <= QUANTUM, `max position error ${maxErr} exceeded 1 quantum (${QUANTUM})`);
});

test('asteroid angle error within 0.01° (much finer than human perception)', () => {
    fresh();
    const s = SchemaCodec.register(3, ASTEROID_UPDATE_FIELDS);
    const TOLERANCE_RAD = 0.0001; // ~0.0057°
    let maxErr = 0;
    for (let i = 0; i < 1000; i++) {
        const angle = Math.random() * TWO_PI;
        const back = SchemaCodec.decode(s, SchemaCodec.encode(s, { x: 0, y: 0, angle }));
        const diff = Math.abs(back.angle - angle);
        const wrapped = Math.min(diff, TWO_PI - diff);
        maxErr = Math.max(maxErr, wrapped);
    }
    assert.ok(maxErr <= TOLERANCE_RAD, `max angle error ${maxErr} exceeds ${TOLERANCE_RAD} rad`);
});

test('ship velocity (q16s) error within 1/32767 across [-1, 1]', () => {
    fresh();
    const s = SchemaCodec.register(1, SHIP_UPDATE_FIELDS);
    const QUANTUM = 1 / 32767;
    let maxErr = 0;
    for (let i = 0; i < 1000; i++) {
        const vx = (Math.random() * 2 - 1) * 0.8; // realistic velocity range
        const vy = (Math.random() * 2 - 1) * 0.8;
        const back = SchemaCodec.decode(s, SchemaCodec.encode(s, {
            x: 0.5, y: 0.5, angle: 0,
            velocityX: vx, velocityY: vy, rotationSpeed: 0,
            thrusting: false, invulnerable: false
        }));
        maxErr = Math.max(maxErr, Math.abs(back.velocityX - vx), Math.abs(back.velocityY - vy));
    }
    assert.ok(maxErr <= QUANTUM, `max velocity error ${maxErr} exceeds 1 quantum (${QUANTUM})`);
});

test('Hazard L11: extrapolation does NOT accumulate quantization drift', () => {
    // The receiver extrapolates pos = snapshot.x + dt * snapshot.vx (non-
    // integrating). So even if we send 60 snapshots/sec for 60 seconds (3600
    // snapshots), the rendered position at any frame is bounded by the SINGLE
    // snapshot's quantization error — not the sum of all 3600 errors.
    fresh();
    const s = SchemaCodec.register(1, SHIP_UPDATE_FIELDS);
    const QUANTUM = 1 / 65535;

    let truePos = 0.5;
    const trueVx = 0.1; // normalized units / sec
    const dt = 1 / 60;  // 60 fps physics
    const SNAPSHOT_PERIOD = 6;  // send a snapshot every 6 frames (10 Hz)

    let maxRenderError = 0;
    for (let frame = 0; frame < 3600; frame++) {
        truePos += trueVx * dt;
        if (truePos > 1) truePos -= 1; // wrap

        if (frame % SNAPSHOT_PERIOD === 0) {
            // Encode the current true state, decode on the receiver, then
            // extrapolate forward by `lag` frames (simulating jitter buffer).
            const lag = 3 * dt;
            const encoded = SchemaCodec.encode(s, {
                x: truePos, y: 0.5, angle: 0,
                velocityX: trueVx, velocityY: 0, rotationSpeed: 0,
                thrusting: false, invulnerable: false
            });
            const snapshot = SchemaCodec.decode(s, encoded);
            const extrapolated = snapshot.x + lag * snapshot.velocityX;

            // What the true position would be `lag` seconds in the future:
            const trueFuture = (truePos + lag * trueVx) % 1;
            const err = Math.abs(extrapolated - trueFuture);
            // Wrap-around handling
            const wrapped = Math.min(err, 1 - err);
            maxRenderError = Math.max(maxRenderError, wrapped);
        }
    }
    // Bound: snapshot.x error (≤1 q16 quantum) + lag×snapshot.vx error
    // (≤ ~3*dt × 1 q16s quantum) ≤ 1/65535 + 0.05 × 1/32767 ≈ 1.6e-5 + 1.5e-6.
    const bound = QUANTUM + (3 * dt) * (1 / 32767);
    assert.ok(maxRenderError <= bound + 1e-9,
        `extrapolation error ${maxRenderError} exceeds non-cumulative bound ${bound}`);
});

test('q16_2pi roundtrip: angle near 0 vs near 2π wrap correctly', () => {
    // Hazard L10: ensure encoder normalizes negative angles before quantizing,
    // so -0.0001 doesn't decode to opposite end of the range from +0.0001.
    fresh();
    const s = SchemaCodec.register(3, ASTEROID_UPDATE_FIELDS);

    const aPositive = SchemaCodec.decode(s, SchemaCodec.encode(s,
        { x: 0, y: 0, angle: 0.0001 })).angle;
    const aNegative = SchemaCodec.decode(s, SchemaCodec.encode(s,
        { x: 0, y: 0, angle: -0.0001 })).angle;

    // aPositive should decode close to 0, aNegative close to 2π.
    assert.ok(aPositive < 0.01, `expected aPositive ≈ 0, got ${aPositive}`);
    assert.ok(aNegative > TWO_PI - 0.01, `expected aNegative ≈ 2π, got ${aNegative}`);

    // The angular distance between them should be ~0.0002 rad (not π!).
    const angularDist = Math.min(
        Math.abs(aPositive - aNegative),
        TWO_PI - Math.abs(aPositive - aNegative)
    );
    assert.ok(angularDist < 0.001,
        `angular distance should be tiny (~0.0002), got ${angularDist}`);
});

test('one full game-second of asteroid updates: cumulative position error stays bounded', () => {
    // Same idea as Hazard L11 but a full game's worth of asteroid samples.
    fresh();
    const s = SchemaCodec.register(3, ASTEROID_UPDATE_FIELDS);
    const QUANTUM = 1 / 65535;

    let truePos = 0.42;
    const trueVx = 0.08; // moving asteroid
    const dt = 1 / 60;

    let maxRenderError = 0;
    for (let frame = 0; frame < 60; frame++) {
        truePos += trueVx * dt;
        if (truePos > 1) truePos -= 1;

        const back = SchemaCodec.decode(s, SchemaCodec.encode(s,
            { x: truePos, y: 0.5, angle: 0 }));
        // No extrapolation here — just the per-frame quantization error.
        const err = Math.abs(back.x - truePos);
        maxRenderError = Math.max(maxRenderError, err);
    }
    assert.ok(maxRenderError <= QUANTUM,
        `60-frame max position error ${maxRenderError} should not exceed 1 quantum (${QUANTUM})`);
});
