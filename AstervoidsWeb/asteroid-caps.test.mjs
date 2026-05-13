// Unit tests for the per-frame caps applied to locally-owned asteroids.
// Mirrors the cap formula in Asteroid.update() (wwwroot/index.html). If the
// production formula changes, update both places.
//
// Run with: node --test AstervoidsWeb/asteroid-caps.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'wwwroot/index.html'), 'utf8');

// Extract default values from CONFIG so the test stays in lock-step with the
// shipped defaults. ASTEROID_MAX_SPEED is a literal number; ASTEROID_MAX_SPIN
// is the expression Math.PI / 6.
function extractConfigLiteral(key) {
    const re = new RegExp(`${key}:\\s*([^,\\n]+)`);
    const m = html.match(re);
    assert.ok(m, `${key} must be present in CONFIG`);
    // eslint-disable-next-line no-eval
    return eval(m[1].trim());
}

const ASTEROID_MAX_SPEED = extractConfigLiteral('ASTEROID_MAX_SPEED');
const ASTEROID_MAX_SPIN = extractConfigLiteral('ASTEROID_MAX_SPIN');

// Mirror of the cap formulas from Asteroid.update().
function clampSpeed(vx, vy, maxSpeed) {
    if (!(maxSpeed > 0)) return { vx, vy };
    const speedSq = vx * vx + vy * vy;
    const maxSq = maxSpeed * maxSpeed;
    if (speedSq <= maxSq) return { vx, vy };
    const speed = Math.sqrt(speedSq);
    const k = maxSpeed / speed;
    return { vx: vx * k, vy: vy * k };
}

function clampSpin(rs, maxSpin) {
    if (!(maxSpin > 0)) return rs;
    if (Math.abs(rs) <= maxSpin) return rs;
    return rs > 0 ? maxSpin : -maxSpin;
}

test('CONFIG.ASTEROID_MAX_SPEED defaults to 0.4 (half SHIP_MAX_SPEED, same units)', () => {
    assert.equal(ASTEROID_MAX_SPEED, 0.4);
});

test('CONFIG.ASTEROID_MAX_SPIN defaults to π/6 ≈ 5 rotations per second', () => {
    assert.ok(Math.abs(ASTEROID_MAX_SPIN - Math.PI / 6) < 1e-12);
    // 5 rot/s → 5·2π rad/s ÷ 60 frames/s = π/6 rad/frame.
    const rotPerSec = ASTEROID_MAX_SPIN * 60 / (2 * Math.PI);
    assert.ok(Math.abs(rotPerSec - 5) < 1e-9, `expected 5 rot/s, got ${rotPerSec}`);
});

test('clampSpeed: under-cap velocity is unchanged', () => {
    const { vx, vy } = clampSpeed(0.3, -0.4, 0.8); // |v| = 0.5
    assert.equal(vx, 0.3);
    assert.equal(vy, -0.4);
});

test('clampSpeed: over-cap velocity is scaled to exactly the cap, direction preserved', () => {
    const vx0 = 6, vy0 = 8; // |v| = 10
    const { vx, vy } = clampSpeed(vx0, vy0, 1.0);
    const speed = Math.sqrt(vx * vx + vy * vy);
    assert.ok(Math.abs(speed - 1.0) < 1e-12, `magnitude ${speed} != 1`);
    // Direction (unit vector) preserved.
    assert.ok(Math.abs(vx / speed - vx0 / 10) < 1e-12);
    assert.ok(Math.abs(vy / speed - vy0 / 10) < 1e-12);
});

test('clampSpeed: cap of 0 disables (no clamp)', () => {
    const { vx, vy } = clampSpeed(100, -200, 0);
    assert.equal(vx, 100);
    assert.equal(vy, -200);
});

test('clampSpin: under-cap rotationSpeed is unchanged', () => {
    assert.equal(clampSpin(0.1, 0.5), 0.1);
    assert.equal(clampSpin(-0.4, 0.5), -0.4);
});

test('clampSpin: over-cap rotationSpeed is clamped, sign preserved', () => {
    assert.equal(clampSpin(2.5, 0.5), 0.5);
    assert.equal(clampSpin(-2.5, 0.5), -0.5);
});

test('clampSpin: cap of 0 disables (no clamp)', () => {
    assert.equal(clampSpin(99, 0), 99);
    assert.equal(clampSpin(-99, 0), -99);
});

test('default cap is half the ship cap (deliberate — asteroids cap tighter)', () => {
    const SHIP_MAX_SPEED = extractConfigLiteral('SHIP_MAX_SPEED');
    assert.equal(ASTEROID_MAX_SPEED, SHIP_MAX_SPEED / 2);
});

test('debug page registers the new keys', () => {
    const debugHtml = readFileSync(join(__dirname, 'wwwroot/debug/index.html'), 'utf8');
    assert.ok(/key:\s*'ASTEROID_MAX_SPEED'/.test(debugHtml), 'debug slider for ASTEROID_MAX_SPEED');
    assert.ok(/key:\s*'ASTEROID_MAX_SPIN'/.test(debugHtml), 'debug slider for ASTEROID_MAX_SPIN');
});

test('DEBUG_OVERRIDABLE_KEYS allow-lists both new caps', () => {
    // Capture the contents of the DEBUG_OVERRIDABLE_KEYS Set literal.
    const m = html.match(/DEBUG_OVERRIDABLE_KEYS = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'DEBUG_OVERRIDABLE_KEYS Set must be present');
    const body = m[1];
    assert.ok(/'ASTEROID_MAX_SPEED'/.test(body));
    assert.ok(/'ASTEROID_MAX_SPIN'/.test(body));
});
