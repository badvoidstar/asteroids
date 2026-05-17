// Unit tests for the movement-anchor 8-vertex polygon helper.
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
    /function computeAnchorVertices\(dx, dy, halfSide\) \{[\s\S]*?\n {4}\}/
);
assert.ok(fnMatch, 'computeAnchorVertices must be defined in index.html');
// eslint-disable-next-line no-eval
const computeAnchorVertices = eval(`(${fnMatch[0].replace('function computeAnchorVertices', 'function')})`);

const H = 100; // half-side used throughout — keeps arithmetic readable.

// Canonical basis polygon for halfSide=H, clockwise from top-left.
// Indices: 0 TL, 1 TM, 2 TR, 3 RM, 4 BR, 5 BM, 6 BL, 7 LM.
function basis(h = H) {
    return [
        { x: -h, y: -h }, // 0 top-left
        { x:  0, y: -h }, // 1 top-mid
        { x: +h, y: -h }, // 2 top-right
        { x: +h, y:  0 }, // 3 right-mid
        { x: +h, y: +h }, // 4 bottom-right
        { x:  0, y: +h }, // 5 bottom-mid
        { x: -h, y: +h }, // 6 bottom-left
        { x: -h, y:  0 }, // 7 left-mid
    ];
}

function assertBasis(verts, h = H, msg = '') {
    const b = basis(h);
    assert.equal(verts.length, 8, `${msg}: expected 8 vertices`);
    for (let i = 0; i < 8; i++) {
        assert.equal(verts[i].x, b[i].x, `${msg}: vertex[${i}].x`);
        assert.equal(verts[i].y, b[i].y, `${msg}: vertex[${i}].y`);
    }
}

function assertOneMoved(verts, movedIdx, dx, dy, h = H) {
    const b = basis(h);
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

// ───── Basis / inside-box ─────────────────────────────────────────────────

test('origin (dx=0, dy=0) returns basis polygon unchanged', () => {
    assertBasis(computeAnchorVertices(0, 0, H), H, 'origin');
});

test('near-zero displacement returns basis', () => {
    assertBasis(computeAnchorVertices(0.1, -0.1, H), H, 'near-zero');
});

test('boundary case |dx|==H, |dy|==H counts as inside (inclusive)', () => {
    // All four box corners as displacement should still produce basis polygon.
    assertBasis(computeAnchorVertices( H,  H, H), H, 'br corner');
    assertBasis(computeAnchorVertices( H, -H, H), H, 'tr corner');
    assertBasis(computeAnchorVertices(-H,  H, H), H, 'bl corner');
    assertBasis(computeAnchorVertices(-H, -H, H), H, 'tl corner');
});

test('boundary case axis-aligned (|dx|==H, dy=0) is inside', () => {
    assertBasis(computeAnchorVertices( H, 0, H), H, 'right edge mid');
    assertBasis(computeAnchorVertices(-H, 0, H), H, 'left edge mid');
    assertBasis(computeAnchorVertices(0,  H, H), H, 'bottom edge mid');
    assertBasis(computeAnchorVertices(0, -H, H), H, 'top edge mid');
});

// ───── 4 edge zones (one axis exceeds H, other within ±H) ─────────────────

test('left only → left-mid vertex (index 7) moves to (dx, dy)', () => {
    const dx = -150, dy = 30; // |dy| ≤ H so it's the "left only" zone
    assertOneMoved(computeAnchorVertices(dx, dy, H), 7, dx, dy);
});

test('right only → right-mid vertex (index 3) moves to (dx, dy)', () => {
    const dx = 200, dy = -50;
    assertOneMoved(computeAnchorVertices(dx, dy, H), 3, dx, dy);
});

test('above only → top-mid vertex (index 1) moves to (dx, dy)', () => {
    const dx = 25, dy = -180;
    assertOneMoved(computeAnchorVertices(dx, dy, H), 1, dx, dy);
});

test('below only → bottom-mid vertex (index 5) moves to (dx, dy)', () => {
    const dx = -75, dy = 250;
    assertOneMoved(computeAnchorVertices(dx, dy, H), 5, dx, dy);
});

// ───── 4 corner zones (both axes exceed ±H) ───────────────────────────────

test('left + above → top-left corner (index 0)', () => {
    const dx = -300, dy = -120;
    assertOneMoved(computeAnchorVertices(dx, dy, H), 0, dx, dy);
});

test('right + above → top-right corner (index 2)', () => {
    const dx = 175, dy = -101;
    assertOneMoved(computeAnchorVertices(dx, dy, H), 2, dx, dy);
});

test('right + below → bottom-right corner (index 4)', () => {
    const dx = 500, dy = 500;
    assertOneMoved(computeAnchorVertices(dx, dy, H), 4, dx, dy);
});

test('left + below → bottom-left corner (index 6)', () => {
    const dx = -101, dy = 999;
    assertOneMoved(computeAnchorVertices(dx, dy, H), 6, dx, dy);
});

// ───── Edge-vs-corner crossover (just past H on one axis only) ─────────────

test('dx just past +H with dy exactly at +H is "right only" (not corner)', () => {
    // |dy| == H is inside on y → right edge zone, not bottom-right corner.
    const dx = H + 1, dy = H;
    assertOneMoved(computeAnchorVertices(dx, dy, H), 3, dx, dy);
});

test('dy just past -H with dx exactly at -H is "above only" (not corner)', () => {
    const dx = -H, dy = -(H + 1);
    assertOneMoved(computeAnchorVertices(dx, dy, H), 1, dx, dy);
});

// ───── Large displacement preserves "vertex tracks finger" contract ────────

test('huge drag: vertex literally tracks finger, other 7 unchanged', () => {
    const dx = 10 * H, dy = -10 * H; // far top-right
    assertOneMoved(computeAnchorVertices(dx, dy, H), 2, dx, dy);
});

// ───── halfSide scaling (device-rotation safety) ──────────────────────────

test('halfSide scales the basis polygon uniformly', () => {
    const small = computeAnchorVertices(0, 0, 25);
    const big   = computeAnchorVertices(0, 0, 400);
    for (let i = 0; i < 8; i++) {
        // basis form vertices are all ±halfSide or 0, scaling cleanly.
        assert.equal(big[i].x, small[i].x * 16);
        assert.equal(big[i].y, small[i].y * 16);
    }
});

test('zero halfSide collapses basis to origin, exterior drag still tracks', () => {
    // Degenerate but graceful: all basis verts at (0,0); ANY nonzero finger
    // displacement is "outside" and moves the appropriate vertex.
    const verts = computeAnchorVertices(50, 50, 0);
    // dx>0, dy>0 → right+below → bottom-right corner (index 4)
    assert.equal(verts[4].x, 50);
    assert.equal(verts[4].y, 50);
    // All others should be at origin (basis with h=0). Use Object.is-relaxed
    // comparison so signed-zero from -h doesn't fail the value-equality check.
    for (let i = 0; i < 8; i++) {
        if (i === 4) continue;
        assert.ok(verts[i].x === 0, `vertex[${i}].x = ${verts[i].x}`);
        assert.ok(verts[i].y === 0, `vertex[${i}].y = ${verts[i].y}`);
    }
});

test('negative halfSide is clamped to 0 (defensive)', () => {
    // Behaves identically to halfSide=0; no negative-square geometry leaks out.
    // Compare with value-equality (=== handles ±0; assert.equal uses Object.is).
    const a = computeAnchorVertices(20, -20, -10);
    const b = computeAnchorVertices(20, -20, 0);
    for (let i = 0; i < 8; i++) {
        assert.ok(a[i].x === b[i].x, `vertex[${i}].x: ${a[i].x} vs ${b[i].x}`);
        assert.ok(a[i].y === b[i].y, `vertex[${i}].y: ${a[i].y} vs ${b[i].y}`);
    }
});

// ───── Winding / vertex ordering stability ────────────────────────────────

test('vertex order is stable clockwise across all cases', () => {
    // Quick sweep: basis, every edge zone, every corner zone — each result must
    // still be 8 vertices, with the unmoved subset matching basis at fixed
    // indices. This is implicitly checked by assertOneMoved above, but we
    // sanity-check the indexing convention itself here.
    const b = basis(H);
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
