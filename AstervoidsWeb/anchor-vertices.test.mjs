// Unit tests for the anchor 8-vertex polygon helper.
// Run with: node --test AstervoidsWeb/anchor-vertices.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Extract computeAnchorVertices from the live index.html (same regex-extract
// pattern used by ship-input-ramp.test.mjs and touch-stick-input.test.mjs).
const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'wwwroot/index.html'), 'utf8');
const fnMatch = html.match(
    /function computeAnchorVertices\(dx, dy, halfWidth, halfHeight\) \{[\s\S]*?\n {4}\}/
);
assert.ok(fnMatch, 'computeAnchorVertices must be defined in index.html');
// eslint-disable-next-line no-eval
const computeAnchorVertices = eval(`(${fnMatch[0].replace('function computeAnchorVertices', 'function')})`);

const H = 100; // square half-extent used in most tests for readable arithmetic.

// Canonical basis polygon for a rectangle with the given half-extents.
// Indices: 0 TL, 1 TM, 2 TR, 3 RM, 4 BR, 5 BM, 6 BL, 7 LM.
function basis(hx, hy = hx) {
    return [
        { x: -hx, y: -hy }, // 0 top-left
        { x:  0,  y: -hy }, // 1 top-mid
        { x: +hx, y: -hy }, // 2 top-right
        { x: +hx, y:  0  }, // 3 right-mid
        { x: +hx, y: +hy }, // 4 bottom-right
        { x:  0,  y: +hy }, // 5 bottom-mid
        { x: -hx, y: +hy }, // 6 bottom-left
        { x: -hx, y:  0  }, // 7 left-mid
    ];
}

function assertBasis(verts, hx, hy = hx, msg = '') {
    const b = basis(hx, hy);
    assert.equal(verts.length, 8, `${msg}: expected 8 vertices`);
    for (let i = 0; i < 8; i++) {
        assert.equal(verts[i].x, b[i].x, `${msg}: vertex[${i}].x`);
        assert.equal(verts[i].y, b[i].y, `${msg}: vertex[${i}].y`);
    }
}

function assertOneMoved(verts, movedIdx, dx, dy, hx, hy = hx) {
    const b = basis(hx, hy);
    assert.equal(verts.length, 8, 'expected 8 vertices');
    for (let i = 0; i < 8; i++) {
        if (i === movedIdx) {
            assert.equal(verts[i].x, dx, `moved vertex[${i}].x`);
            assert.equal(verts[i].y, dy, `moved vertex[${i}].y`);
        } else {
            assert.equal(verts[i].x, b[i].x, `unchanged vertex[${i}].x (idx ${i})`);
            assert.equal(verts[i].y, b[i].y, `unchanged vertex[${i}].y (idx ${i})`);
        }
    }
}

// ───── Basis / inside-box (symmetric square) ──────────────────────────────

test('origin (dx=0, dy=0) returns basis polygon unchanged', () => {
    assertBasis(computeAnchorVertices(0, 0, H, H), H, H, 'origin');
});

test('near-zero displacement returns basis', () => {
    assertBasis(computeAnchorVertices(0.1, -0.1, H, H), H, H, 'near-zero');
});

test('boundary case |dx|==H, |dy|==H counts as inside (inclusive)', () => {
    assertBasis(computeAnchorVertices( H,  H, H, H), H, H, 'br corner');
    assertBasis(computeAnchorVertices( H, -H, H, H), H, H, 'tr corner');
    assertBasis(computeAnchorVertices(-H,  H, H, H), H, H, 'bl corner');
    assertBasis(computeAnchorVertices(-H, -H, H, H), H, H, 'tl corner');
});

test('boundary case axis-aligned (|dx|==H, dy=0) is inside', () => {
    assertBasis(computeAnchorVertices( H, 0, H, H), H, H, 'right edge mid');
    assertBasis(computeAnchorVertices(-H, 0, H, H), H, H, 'left edge mid');
    assertBasis(computeAnchorVertices(0,  H, H, H), H, H, 'bottom edge mid');
    assertBasis(computeAnchorVertices(0, -H, H, H), H, H, 'top edge mid');
});

// ───── 4 edge zones (one axis exceeds extent, other within) ───────────────

test('left only → left-mid vertex (index 7) moves to (dx, dy)', () => {
    const dx = -150, dy = 30;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 7, dx, dy, H);
});

test('right only → right-mid vertex (index 3) moves to (dx, dy)', () => {
    const dx = 200, dy = -50;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 3, dx, dy, H);
});

test('above only → top-mid vertex (index 1) moves to (dx, dy)', () => {
    const dx = 25, dy = -180;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 1, dx, dy, H);
});

test('below only → bottom-mid vertex (index 5) moves to (dx, dy)', () => {
    const dx = -75, dy = 250;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 5, dx, dy, H);
});

// ───── 4 corner zones (both axes exceed their extents) ────────────────────

test('left + above → top-left corner (index 0)', () => {
    const dx = -300, dy = -120;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 0, dx, dy, H);
});

test('right + above → top-right corner (index 2)', () => {
    const dx = 175, dy = -101;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 2, dx, dy, H);
});

test('right + below → bottom-right corner (index 4)', () => {
    const dx = 500, dy = 500;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 4, dx, dy, H);
});

test('left + below → bottom-left corner (index 6)', () => {
    const dx = -101, dy = 999;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 6, dx, dy, H);
});

// ───── Edge-vs-corner crossover ───────────────────────────────────────────

test('dx just past +H with dy exactly at +H is "right only" (not corner)', () => {
    const dx = H + 1, dy = H;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 3, dx, dy, H);
});

test('dy just past -H with dx exactly at -H is "above only" (not corner)', () => {
    const dx = -H, dy = -(H + 1);
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 1, dx, dy, H);
});

// ───── Large displacement preserves "vertex tracks finger" contract ───────

test('huge drag: vertex literally tracks finger, other 7 unchanged', () => {
    const dx = 10 * H, dy = -10 * H;
    assertOneMoved(computeAnchorVertices(dx, dy, H, H), 2, dx, dy, H);
});

// ───── Half-extent scaling ────────────────────────────────────────────────

test('half-extents scale the basis polygon uniformly', () => {
    const small = computeAnchorVertices(0, 0, 25, 25);
    const big   = computeAnchorVertices(0, 0, 400, 400);
    for (let i = 0; i < 8; i++) {
        assert.equal(big[i].x, small[i].x * 16);
        assert.equal(big[i].y, small[i].y * 16);
    }
});

test('zero half-extents collapse basis to origin, exterior drag still tracks', () => {
    const verts = computeAnchorVertices(50, 50, 0, 0);
    assert.equal(verts[4].x, 50);
    assert.equal(verts[4].y, 50);
    for (let i = 0; i < 8; i++) {
        if (i === 4) continue;
        assert.ok(verts[i].x === 0, `vertex[${i}].x = ${verts[i].x}`);
        assert.ok(verts[i].y === 0, `vertex[${i}].y = ${verts[i].y}`);
    }
});

test('negative half-extents are clamped to 0 (defensive)', () => {
    const a = computeAnchorVertices(20, -20, -10, -10);
    const b = computeAnchorVertices(20, -20, 0, 0);
    for (let i = 0; i < 8; i++) {
        assert.ok(a[i].x === b[i].x, `vertex[${i}].x: ${a[i].x} vs ${b[i].x}`);
        assert.ok(a[i].y === b[i].y, `vertex[${i}].y: ${a[i].y} vs ${b[i].y}`);
    }
});

// ───── Asymmetric rectangle (independent turn vs thrust dead-zones) ───────

test('asymmetric rectangle: basis adopts halfWidth × halfHeight directly', () => {
    const hx = 30, hy = 80;
    assertBasis(computeAnchorVertices(0, 0, hx, hy), hx, hy, 'asymmetric');
});

test('asymmetric rectangle: zone classification uses per-axis extents', () => {
    // hx=30 (narrow turn dz), hy=80 (wide thrust dz). Drag (40, 50):
    //   |dx|=40 > hx=30 → outside on X
    //   |dy|=50 ≤ hy=80 → inside on Y
    //   → "right only" → right-mid (index 3) moves to (40, 50).
    const hx = 30, hy = 80;
    assertOneMoved(computeAnchorVertices(40, 50, hx, hy), 3, 40, 50, hx, hy);

    // Same drag against symmetric small dz: would be a corner case.
    const verts2 = computeAnchorVertices(40, 50, 30, 30);
    // |dx|=40>30 AND |dy|=50>30 → right+below → bottom-right corner (index 4).
    assertOneMoved(verts2, 4, 40, 50, 30);
});

// ───── Winding / vertex ordering stability ────────────────────────────────

test('vertex order is stable clockwise across all cases', () => {
    const b = basis(H, H);
    const expectedIdxByZone = { TL:0, TM:1, TR:2, RM:3, BR:4, BM:5, BL:6, LM:7 };
    assert.equal(b[expectedIdxByZone.TL].x, -H);
    assert.equal(b[expectedIdxByZone.TL].y, -H);
    assert.equal(b[expectedIdxByZone.TM].x, 0);
    assert.equal(b[expectedIdxByZone.TM].y, -H);
    assert.equal(b[expectedIdxByZone.TR].x, +H);
    assert.equal(b[expectedIdxByZone.TR].y, -H);
    assert.equal(b[expectedIdxByZone.RM].x, +H);
    assert.equal(b[expectedIdxByZone.RM].y, 0);
    assert.equal(b[expectedIdxByZone.BR].x, +H);
    assert.equal(b[expectedIdxByZone.BR].y, +H);
    assert.equal(b[expectedIdxByZone.BM].x, 0);
    assert.equal(b[expectedIdxByZone.BM].y, +H);
    assert.equal(b[expectedIdxByZone.BL].x, -H);
    assert.equal(b[expectedIdxByZone.BL].y, +H);
    assert.equal(b[expectedIdxByZone.LM].x, -H);
    assert.equal(b[expectedIdxByZone.LM].y, 0);
});
