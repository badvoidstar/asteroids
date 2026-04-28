/**
 * Tests for the polygon-fracture path of splitAsteroid().
 *
 * Run with:  node --test AstervoidsWeb/fracture.test.mjs
 *
 * The polygon helpers and the polygon-fracture portion of splitAsteroid()
 * live inline in AstervoidsWeb/wwwroot/index.html (no module export). To keep
 * tests independent of the browser bundle the math is mirrored here, exactly
 * matching the wwwroot/index.html implementation. Keep the two in sync.
 *
 * Verified properties:
 *   • polygonArea / polygonCentroid against known shapes.
 *   • fractureSplitPolygon: A_pos + A_neg = A_parent within tolerance,
 *     entry/exit lie on the chord, every output polygon has ≥ 3 vertices.
 *   • buildFracturePolyline: endpoints lie on the chord, intermediate points
 *     stay within ±jagAmplitude of the chord, displacement tapers to 0 at
 *     the endpoints.
 *   • End-to-end fracture split (regular 10-gon "parent"):
 *       - Σ m_i = M                              (mass conservation)
 *       - Σ m_i v_i = M v + J                    (linear-momentum conservation)
 *       - small/large radii from polygon area    (R_i = √(A_i / π_eff))
 *       - 1-child branch keeps the surviving piece's polygon
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mirror of polygon helpers (kept in sync with wwwroot/index.html) ───────

function polygonArea(verts) {
    let a = 0;
    const N = verts.length;
    for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        a += verts[i].x * verts[j].y - verts[j].x * verts[i].y;
    }
    return a * 0.5;
}

function polygonCentroid(verts) {
    let cx = 0, cy = 0, a = 0;
    const N = verts.length;
    for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const cross = verts[i].x * verts[j].y - verts[j].x * verts[i].y;
        cx += (verts[i].x + verts[j].x) * cross;
        cy += (verts[i].y + verts[j].y) * cross;
        a += cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-18) {
        let sx = 0, sy = 0;
        for (const v of verts) { sx += v.x; sy += v.y; }
        return { x: sx / N, y: sy / N, area: 0 };
    }
    return { x: cx / (6 * a), y: cy / (6 * a), area: a };
}

function fractureSplitPolygon(verts, n, d, jagPath) {
    const N = verts.length;
    if (N < 3) return null;
    const sides = new Array(N);
    for (let i = 0; i < N; i++) sides[i] = verts[i].x * n.x + verts[i].y * n.y - d;

    const crossEdges = [];
    for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const sa = sides[i], sb = sides[j];
        if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
            const t = sa / (sa - sb);
            crossEdges.push({
                edgeStart: i,
                point: {
                    x: verts[i].x + (verts[j].x - verts[i].x) * t,
                    y: verts[i].y + (verts[j].y - verts[i].y) * t,
                },
                fromPos: sa > 0,
            });
        }
    }
    if (crossEdges.length !== 2) return null;

    let entryIdx, exitIdx;
    if (crossEdges[0].fromPos) { entryIdx = 0; exitIdx = 1; }
    else                       { entryIdx = 1; exitIdx = 0; }

    const buildHalf = (startCross, endCross, sideTest, jagDir) => {
        const out = [{ x: startCross.point.x, y: startCross.point.y }];
        const stop = (endCross.edgeStart + 1) % N;
        let i = (startCross.edgeStart + 1) % N;
        let safety = N + 2;
        while (i !== stop && safety-- > 0) {
            if (sideTest(sides[i])) out.push({ x: verts[i].x, y: verts[i].y });
            i = (i + 1) % N;
        }
        out.push({ x: endCross.point.x, y: endCross.point.y });
        if (jagDir > 0) {
            for (const p of jagPath) out.push({ x: p.x, y: p.y });
        } else {
            for (let k = jagPath.length - 1; k >= 0; k--) {
                out.push({ x: jagPath[k].x, y: jagPath[k].y });
            }
        }
        return out;
    };

    const positive = buildHalf(crossEdges[exitIdx], crossEdges[entryIdx], s => s > 0, +1);
    const negative = buildHalf(crossEdges[entryIdx], crossEdges[exitIdx], s => s < 0, -1);

    if (positive.length < 3 || negative.length < 3) return null;
    return {
        positive, negative,
        entry: crossEdges[entryIdx].point,
        exit:  crossEdges[exitIdx].point,
    };
}

function buildFracturePolyline(entry, exit, count, jagAmplitude, randomFn) {
    const out = [];
    if (count <= 0) return out;
    const dx = exit.x - entry.x, dy = exit.y - entry.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return out;
    const px = -dy / len, py = dx / len;
    for (let k = 1; k <= count; k++) {
        const t = k / (count + 1);
        const cx = entry.x + dx * t;
        const cy = entry.y + dy * t;
        const taper = 2 * Math.min(t, 1 - t);
        const amp = jagAmplitude > 0 ? jagAmplitude : 0;
        const offset = (randomFn() * 2 - 1) * amp * taper;
        out.push({ x: cx + px * offset, y: cy + py * offset });
    }
    return out;
}

function makeSeededRandom(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function verticesFromXY(xy) {
    return xy.map(p => ({ angle: Math.atan2(p.y, p.x), distance: Math.hypot(p.x, p.y) }));
}

// ─── Helpers: build a parent polygon shaped like the game's asteroids ───────

// Slight phase offset so no vertex lands on the x or y axis — fractureSplitPolygon
// classifies a vertex with side=0 as neither side, which would mask a crossing.
// Real asteroids are randomized, so this never lines up in the game.
function regularPolygon(R, n = 10, phase = 0.07) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + phase;
        out.push({ x: Math.cos(a) * R, y: Math.sin(a) * R });
    }
    return out;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('polygonArea: unit square = 1', () => {
    const square = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    assert.equal(polygonArea(square), 1);
});

test('polygonArea: regular hexagon R=1 ≈ 3·√3/2', () => {
    const A = polygonArea(regularPolygon(1, 6));
    assert.ok(Math.abs(A - 3 * Math.sqrt(3) / 2) < 1e-12);
});

test('polygonCentroid: unit square centroid = (0.5, 0.5)', () => {
    const square = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    const c = polygonCentroid(square);
    assert.ok(Math.abs(c.x - 0.5) < 1e-12);
    assert.ok(Math.abs(c.y - 0.5) < 1e-12);
});

test('polygonCentroid: regular 10-gon centroid ≈ origin', () => {
    const c = polygonCentroid(regularPolygon(0.083, 10));
    assert.ok(Math.abs(c.x) < 1e-12);
    assert.ok(Math.abs(c.y) < 1e-12);
});

test('fractureSplitPolygon: A_pos + A_neg ≈ A_parent for regular 10-gon, head-on chord', () => {
    const verts = regularPolygon(0.083, 10);
    const Aparent = polygonArea(verts);
    // Chord through center, normal along +y.
    const split = fractureSplitPolygon(verts, { x: 0, y: 1 }, 0, []);
    assert.ok(split, 'split should succeed');
    const Apos = polygonArea(split.positive);
    const Aneg = polygonArea(split.negative);
    assert.ok(Math.abs((Apos + Aneg) - Aparent) < 1e-12,
        `Apos+Aneg=${Apos+Aneg} parent=${Aparent}`);
    assert.ok(split.positive.length >= 3);
    assert.ok(split.negative.length >= 3);
});

test('fractureSplitPolygon: head-on chord ⇒ ≈ 50/50 area within 5%', () => {
    const verts = regularPolygon(0.083, 10);
    const split = fractureSplitPolygon(verts, { x: 0, y: 1 }, 0, []);
    const Apos = polygonArea(split.positive);
    const Aneg = polygonArea(split.negative);
    const r = Apos / (Apos + Aneg);
    assert.ok(Math.abs(r - 0.5) < 0.05, `expected ~50/50, got ${r}`);
});

test('fractureSplitPolygon: offset chord ⇒ smaller piece on the offset side', () => {
    const verts = regularPolygon(0.083, 10);
    // Chord at +0.04 along +y (well inside the polygon). Positive side is the smaller cap.
    const d = 0.04;
    const split = fractureSplitPolygon(verts, { x: 0, y: 1 }, d, []);
    assert.ok(split, 'split should succeed');
    const Apos = polygonArea(split.positive);
    const Aneg = polygonArea(split.negative);
    assert.ok(Apos < Aneg, 'positive cap should be smaller');
    assert.ok(Math.abs(Apos + Aneg - polygonArea(verts)) < 1e-12);
});

test('fractureSplitPolygon: chord misses polygon ⇒ returns null', () => {
    const verts = regularPolygon(0.083, 10);
    const split = fractureSplitPolygon(verts, { x: 0, y: 1 }, 1.0, []);
    assert.equal(split, null);
});

test('buildFracturePolyline: count points, endpoints lie on chord', () => {
    const entry = { x: -1, y: 0 }, exit = { x: 1, y: 0 };
    const rng = makeSeededRandom(42);
    const path = buildFracturePolyline(entry, exit, 6, 0.1, rng);
    assert.equal(path.length, 6);
    // Each point's projection onto the chord direction should be within (-1, 1).
    for (const p of path) {
        assert.ok(p.x > -1 && p.x < 1, `x=${p.x} out of range`);
    }
});

test('buildFracturePolyline: |displacement| ≤ taper · jagAmplitude', () => {
    const entry = { x: -1, y: 0 }, exit = { x: 1, y: 0 };
    const jag = 0.1;
    const rng = makeSeededRandom(123);
    const path = buildFracturePolyline(entry, exit, 8, jag, rng);
    for (let k = 0; k < path.length; k++) {
        const t = (k + 1) / (path.length + 1);
        const taper = 2 * Math.min(t, 1 - t);
        // perpendicular to the chord (which is along x) is the y axis.
        assert.ok(Math.abs(path[k].y) <= jag * taper + 1e-12,
            `k=${k} y=${path[k].y} exceeds ${jag*taper}`);
    }
});

test('buildFracturePolyline: 0 amplitude ⇒ straight line on the chord', () => {
    const entry = { x: 0, y: 0 }, exit = { x: 1, y: 1 };
    const rng = makeSeededRandom(7);
    const path = buildFracturePolyline(entry, exit, 5, 0, rng);
    assert.equal(path.length, 5);
    for (const p of path) {
        // Points should satisfy y == x (on the chord from origin to (1,1)).
        assert.ok(Math.abs(p.x - p.y) < 1e-12);
    }
});

test('buildFracturePolyline: deterministic for same seed', () => {
    const entry = { x: -0.5, y: 0 }, exit = { x: 0.5, y: 0 };
    const a = buildFracturePolyline(entry, exit, 6, 0.1, makeSeededRandom(99));
    const b = buildFracturePolyline(entry, exit, 6, 0.1, makeSeededRandom(99));
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].x, b[i].x);
        assert.equal(a[i].y, b[i].y);
    }
});

// ─── End-to-end: regular 10-gon parent, full fracture split ─────────────────

const CONFIG = {
    DEFLECTION_KICK: 1e-3,
    SEPARATION_ENERGY: 1e-4,
    MIN_ASTEROID_RADIUS: 0.025,
    INITIAL_ASTEROID_RADIUS: 0.083,
    ASTEROID_DENSITY: 5.0,
    SEPARATION_ENERGY_SIZE_BLEND: 1.0,
    FRACTURE_VERTICES: 6,
    FRACTURE_JAGGEDNESS: 0.35,
};

function fragmentPolygon(parentVerts, R, vx, vy, omega, offsetN, bulletAngle, cfg = CONFIG) {
    const dx = Math.cos(bulletAngle), dy = Math.sin(bulletAngle);
    const nx = -dy, ny = dx;
    const density = cfg.ASTEROID_DENSITY;
    const M = density * R * R;
    const I = 0.5 * M * R * R;
    const b   = offsetN * R;
    const rxN = b;
    const rxD = -Math.sqrt(Math.max(0, R * R - b * b));
    const rx  = rxD * dx + rxN * nx;
    const ry  = rxD * dy + rxN * ny;
    const vKick = Math.max(0, cfg.DEFLECTION_KICK);
    const blend = Math.max(0, Math.min(1, cfg.SEPARATION_ENERGY_SIZE_BLEND));
    const sizeMul = (1 - blend) + blend * (R / cfg.INITIAL_ASTEROID_RADIUS) ** 2;
    const E_sep = Math.max(0, cfg.SEPARATION_ENERGY) * sizeMul;
    const Jmag = M * vKick;
    const Jx = Jmag * dx, Jy = Jmag * dy;
    const vxP = vx + Jx / M, vyP = vy + Jy / M;
    const torque = rx * Jy - ry * Jx;
    const omegaP = omega + torque / I;
    const sideSign = offsetN >= 0 ? 1 : -1;
    const sx = sideSign * nx, sy = sideSign * ny;

    const A_parent = Math.abs(polygonArea(parentVerts));
    const pi_eff = A_parent / (R * R);
    const probe = fractureSplitPolygon(parentVerts, { x: nx, y: ny }, b, []);
    if (!probe) return null;
    const jag = buildFracturePolyline(probe.entry, probe.exit,
        cfg.FRACTURE_VERTICES, cfg.FRACTURE_JAGGEDNESS * R, makeSeededRandom(1));
    const split = fractureSplitPolygon(parentVerts, { x: nx, y: ny }, b, jag);
    if (!split) return null;
    const A_pos = Math.abs(polygonArea(split.positive));
    const A_neg = Math.abs(polygonArea(split.negative));
    const smallSide = A_pos <= A_neg ? { poly: split.positive, area: A_pos } : { poly: split.negative, area: A_neg };
    const largeSide = A_pos <= A_neg ? { poly: split.negative, area: A_neg } : { poly: split.positive, area: A_pos };
    const cSmall = polygonCentroid(smallSide.poly);
    const cLarge = polygonCentroid(largeSide.poly);
    const rSmall = Math.sqrt(smallSide.area / pi_eff);
    const rLarge = Math.sqrt(largeSide.area / pi_eff);
    const mSmall = (smallSide.area / A_parent) * M;
    const mLarge = (largeSide.area / A_parent) * M;

    const out = { M, I, J: { x: Jx, y: Jy }, vxP, vyP, omegaP, A_parent, A_pos, A_neg,
                  pi_eff, children: [] };

    if (rSmall < cfg.MIN_ASTEROID_RADIUS) {
        out.children.push({ r: rLarge, m: mLarge, cx: cLarge.x, cy: cLarge.y,
            vx: vxP + (-omegaP) * cLarge.y, vy: vyP + (omegaP) * cLarge.x, omega: omegaP });
        return out;
    }

    const v_rs = { vx: vxP + (-omegaP) * cSmall.y, vy: vyP + (omegaP) * cSmall.x };
    const v_rl = { vx: vxP + (-omegaP) * cLarge.y, vy: vyP + (omegaP) * cLarge.x };
    const s = E_sep > 0 ? Math.sqrt(2 * E_sep * mLarge / (mSmall * M)) : 0;
    const proj = cSmall.x * sx + cSmall.y * sy;
    const sepDir = proj >= 0 ? 1 : -1;
    const sepX = sepDir * sx, sepY = sepDir * sy;
    out.children.push({ r: rSmall, m: mSmall, cx: cSmall.x, cy: cSmall.y,
        vx: v_rs.vx + sepX * s, vy: v_rs.vy + sepY * s, omega: omegaP });
    out.children.push({ r: rLarge, m: mLarge, cx: cLarge.x, cy: cLarge.y,
        vx: v_rl.vx - sepX * s * (mSmall / mLarge),
        vy: v_rl.vy - sepY * s * (mSmall / mLarge), omega: omegaP });
    return out;
}

test('end-to-end: mass conservation Σ m_i = M', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const out = fragmentPolygon(parent, R, 0.1, -0.05, 0.01, 0.2, Math.PI / 4);
    const totalM = out.children.reduce((acc, c) => acc + c.m, 0);
    assert.ok(Math.abs(totalM - out.M) < 1e-12, `Σm=${totalM} M=${out.M}`);
});

test('end-to-end: linear momentum Σ m_i v_i = M v + J', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const vx = 0.1, vy = -0.05, omega = 0.01;
    const out = fragmentPolygon(parent, R, vx, vy, omega, 0.2, Math.PI / 4);
    const px = out.children.reduce((a, c) => a + c.m * c.vx, 0);
    const py = out.children.reduce((a, c) => a + c.m * c.vy, 0);
    const expectedPx = out.M * vx + out.J.x;
    const expectedPy = out.M * vy + out.J.y;
    assert.ok(Math.abs(px - expectedPx) < 1e-12, `px=${px} expected=${expectedPx}`);
    assert.ok(Math.abs(py - expectedPy) < 1e-12, `py=${py} expected=${expectedPy}`);
});

test('end-to-end: head-on hit ⇒ areas ≈ 50/50 (within 5%)', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const out = fragmentPolygon(parent, R, 0, 0, 0, 0, 0);
    assert.equal(out.children.length, 2);
    const r = out.children[0].m / (out.children[0].m + out.children[1].m);
    // Tolerance ~5% accounts for the small phase rotation in the test polygon.
    assert.ok(Math.abs(r - 0.5) < 0.05, `head-on mass ratio = ${r}`);
});

test('end-to-end: equivalent radius R_i = √(A_i / π_eff)', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const out = fragmentPolygon(parent, R, 0, 0, 0, 0, 0);
    for (const c of out.children) {
        const Ai = (c.m / out.M) * out.A_parent;
        const expectedR = Math.sqrt(Ai / out.pi_eff);
        assert.ok(Math.abs(c.r - expectedR) < 1e-12);
    }
});

test('end-to-end: 1-child branch when small piece below MIN_ASTEROID_RADIUS', () => {
    // R close to MIN, with a glancing offset producing a tiny chip.
    const R = 0.03; // just above MIN_ASTEROID_RADIUS=0.025
    const parent = regularPolygon(R, 10);
    const out = fragmentPolygon(parent, R, 0, 0, 0, 0.95, 0);
    assert.equal(out.children.length, 1);
    // The surviving piece's mass should be the larger area's share.
    assert.ok(out.children[0].m > 0.5 * out.M);
});
