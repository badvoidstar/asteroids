// Unit tests for non-isotropy invariants in the math that mixes per-axis
// normalized coordinates. The game stores positions in normalized units —
// x is a fraction of game width, y is a fraction of height — so any code
// that combines dx and dy (Math.sqrt(dx² + dy²) compared to a scalar) MUST
// first convert to reference-dimension units, otherwise behaviour changes
// with viewport aspect ratio.
//
// Run with: node --test AstervoidsWeb/isotropy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors the shouldSnap math at index.html:2114-2138 (the isotropy-correct
// version). dx/dy are in normalized-X/normalized-Y; gameWidth/Height are in
// pixels; refDim is min(width, height); threshold is in ref-dim units.
function shouldSnapMath(dx, dy, gameWidth, gameHeight, threshold) {
    const refDim = Math.min(gameWidth, gameHeight);
    const dxRef = dx * gameWidth / refDim;
    const dyRef = dy * gameHeight / refDim;
    return Math.sqrt(dxRef * dxRef + dyRef * dyRef) > threshold;
}

test('shouldSnap: isotropic — equal-pixel jumps trigger identically regardless of direction', () => {
    const W = 1600, H = 900; // 16:9
    const threshold = 0.25;
    // 200-px horizontal jump
    const dx_h = 200 / W; // 0.125
    const dy_h = 0;
    // 200-px vertical jump
    const dx_v = 0;
    const dy_v = 200 / H; // 0.222
    // After conversion both should map to the same ref-dim distance:
    // 200 px / refDim (= 900 px) ≈ 0.222 ref-dim
    const horizontalSnap = shouldSnapMath(dx_h, dy_h, W, H, threshold);
    const verticalSnap = shouldSnapMath(dx_v, dy_v, W, H, threshold);
    assert.equal(horizontalSnap, verticalSnap,
        'a 200-pixel horizontal jump and a 200-pixel vertical jump must produce the same snap decision');
});

test('shouldSnap: isotropic — same threshold triggers at the same pixel distance in any direction', () => {
    const W = 1920, H = 1080; // 16:9
    const refDim = Math.min(W, H); // 1080
    const threshold = 0.25; // ref-dim → 270 px
    // Just-below threshold (269 px) should NOT snap in either direction
    const justBelowDx = 269 / W;
    const justBelowDy = 269 / H;
    assert.equal(shouldSnapMath(justBelowDx, 0, W, H, threshold), false, '269-px horizontal must not snap');
    assert.equal(shouldSnapMath(0, justBelowDy, W, H, threshold), false, '269-px vertical must not snap');
    // Just-above threshold (271 px) SHOULD snap in either direction
    const justAboveDx = 271 / W;
    const justAboveDy = 271 / H;
    assert.equal(shouldSnapMath(justAboveDx, 0, W, H, threshold), true, '271-px horizontal must snap');
    assert.equal(shouldSnapMath(0, justAboveDy, W, H, threshold), true, '271-px vertical must snap');
});

test('shouldSnap: square viewport — behaviour identical to legacy (no conversion needed)', () => {
    // On a square viewport refDim = width = height, so the conversion is
    // identity and behaviour matches the pre-fix scalar-magnitude code.
    const W = 1000, H = 1000;
    const threshold = 0.25;
    // dx² + dy² = 0.05² + 0.05² = 0.005 → √ ≈ 0.0707, well under 0.25
    assert.equal(shouldSnapMath(0.05, 0.05, W, H, threshold), false);
    // dx² + dy² = 0.2² + 0.2² = 0.08 → √ ≈ 0.283, just over 0.25
    assert.equal(shouldSnapMath(0.2, 0.2, W, H, threshold), true);
});

test('shouldSnap: legacy formula was non-isotropic on 16:9 (regression evidence)', () => {
    // The pre-fix formula combined dx and dy directly without conversion,
    // so a 200-px horizontal jump (dx=0.125) and a 200-px vertical jump
    // (dy=0.222) compared to the SAME threshold gave different results.
    function legacyShouldSnap(dx, dy, threshold) {
        return Math.sqrt(dx * dx + dy * dy) > threshold;
    }
    const W = 1600, H = 900;
    const threshold = 0.2; // chosen so the two directions disagree
    const horizontalSnap = legacyShouldSnap(200 / W, 0, threshold); // 0.125 → false
    const verticalSnap = legacyShouldSnap(0, 200 / H, threshold);   // 0.222 → true
    assert.notEqual(horizontalSnap, verticalSnap,
        'pre-fix formula produced different snap decisions for equal-pixel jumps; if this passes, the legacy bug is real and the fix above is the right shape');
});
