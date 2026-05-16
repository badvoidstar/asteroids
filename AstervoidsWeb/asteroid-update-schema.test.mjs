/**
 * Regression: asteroid update schema must carry velocityX/velocityY/rotationSpeed
 * end-to-end through the wire codec so the receiver's interpolator can extrapolate
 * between snapshots.
 *
 * Bug history (Phase 4D):
 *   The asteroid update positional schema was minimised to {x, y, angle} on the
 *   theory that asteroid kinematics are constant in steady state and the
 *   receiver could just lerp positions between snapshots. That theory ignored
 *   `_baseInterpolated`'s extrapolation arm (line ~2168 of index.html), which
 *   advances `latest.x + latest.velocity.x * dt` whenever the render frame's
 *   target time falls past the newest snapshot. With velocity stripped on the
 *   wire it defaulted to 0 in `RemoteObjects.updateState`, so remote asteroids
 *   FROZE for whatever fraction of each send interval the adaptive delay buffer
 *   left in the extrapolation zone — visible as a 30 Hz / sendRate-aligned
 *   stutter on a low-jitter LAN.
 *
 * The wire-size bench measured bytes; nothing exercised the interpolator with
 * codec-decoded data to assert the velocity actually survived the round trip.
 * This test plugs that gap by simulating the production updateState →
 * extrapolation pipeline using bytes the codec actually emits.
 *
 * Run with:  node --test AstervoidsWeb/asteroid-update-schema.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SchemaCodec = require('./wwwroot/js/schema-codec.js');

// Mirror of the production WIREOPT_SCHEMAS id=3 entry (asteroid update).
// Keep this in lock-step with index.html — if the wire shape changes here
// without the production schema also changing, that's the bug being repinned.
const ASTEROID_UPDATE_SCHEMA_FIELDS = [
    ['x', 'q16w'], ['y', 'q16w'], ['angle', 'q16_2pi'],
    ['velocityX', 'q16s'], ['velocityY', 'q16s'],
    ['rotationSpeed', 'q16s'],
];

function freshSchema() {
    SchemaCodec.clear();
    return SchemaCodec.register(3, ASTEROID_UPDATE_SCHEMA_FIELDS);
}

// Mirror of the production updateState snapshot construction (index.html
// ~line 1592). The two-line `velocity:` initialiser is the exact site where
// missing velocity fields silently became zero.
function pushSnapshot(state, data, validAt) {
    state.snapshots.push({
        data: { ...data },
        time: validAt,
        velocity: { x: data.velocityX || 0, y: data.velocityY || 0 },
        rotationSpeed: data.rotationSpeed || 0,
    });
}

// Mirror of the extrapolation arm of `_baseInterpolated` (index.html ~line
// 2168). Returns the extrapolated x for renderTime past the latest snapshot.
// We isolate the arm so the test failure points squarely at "velocity is
// zero" without dragging in Hermite tangent math.
function extrapolatedX(state, renderTime) {
    const latest = state.snapshots[state.snapshots.length - 1];
    const dtSec = (renderTime - latest.time) / 1000;
    return latest.data.x + latest.velocity.x * dtSec;
}

test('asteroid update schema carries velocity through encode/decode round trip', () => {
    const schema = freshSchema();
    const sent = {
        x: 0.5, y: 0.5, angle: 1.0,
        velocityX: 0.3, velocityY: -0.2,
        rotationSpeed: 0.05,
    };
    const bytes = SchemaCodec.encode(schema, sent);
    const decoded = SchemaCodec.decode(schema, bytes);

    // The ship-update schema id=1 already had these fields; the regression
    // was that schema id=3 was minimised to {x, y, angle}. Pin that the
    // current schema preserves velocity — both the keys and the values
    // (within q16s ~3e-5 quantization).
    assert.ok('velocityX' in decoded, 'velocityX must survive decode (Phase 4D regression)');
    assert.ok('velocityY' in decoded, 'velocityY must survive decode (Phase 4D regression)');
    assert.ok('rotationSpeed' in decoded, 'rotationSpeed must survive decode (Phase 4D regression)');
    assert.ok(Math.abs(decoded.velocityX - 0.3) < 1e-4, `velocityX preserved: got ${decoded.velocityX}`);
    assert.ok(Math.abs(decoded.velocityY - -0.2) < 1e-4, `velocityY preserved: got ${decoded.velocityY}`);
    assert.ok(Math.abs(decoded.rotationSpeed - 0.05) < 1e-4, `rotationSpeed preserved: got ${decoded.rotationSpeed}`);
});

test('extrapolation past latest snapshot advances by velocity (no freeze on LAN)', () => {
    // Reproduce the production scenario that exposed the bug: a moving
    // remote asteroid, one snapshot in the buffer, render frame falls past
    // the snapshot's time (typical when adaptive delay < send interval).
    const schema = freshSchema();
    const wireBytes = SchemaCodec.encode(schema, {
        x: 0.5, y: 0.5, angle: 0,
        velocityX: 0.4, velocityY: 0,
        rotationSpeed: 0,
    });
    const decoded = SchemaCodec.decode(schema, wireBytes);

    const state = { snapshots: [] };
    pushSnapshot(state, decoded, 1000);

    // Render frame falls 16.7 ms past the snapshot's validAt. At
    // velocityX=0.4 normalized/s, expected forward motion is 0.4 * 0.0167
    // ≈ 6.68e-3 in normalized x. Pre-fix: velocity zeroed → motion 0.
    const x = extrapolatedX(state, 1016.7);
    assert.ok(x > 0.5, `asteroid must move forward in extrapolation, got x=${x} (frozen at 0.5 = the bug)`);
    assert.ok(Math.abs(x - (0.5 + 0.4 * 0.0167)) < 1e-4,
        `extrapolation step ~0.4*0.0167; got dx=${x - 0.5}`);
});

test('extrapolation across a full send interval covers the full bracket-to-next-snap gap', () => {
    // The visible "30 Hz feel" was the rendered position alternating between
    // bracket motion and freeze across the ~33 ms gap between snapshots.
    // With velocity carried, extrapolation across the full gap matches
    // what bracket interpolation would have produced if the next snap had
    // already arrived.
    const schema = freshSchema();
    const decoded = SchemaCodec.decode(schema, SchemaCodec.encode(schema, {
        x: 0.0, y: 0.0, angle: 0,
        velocityX: 0.6, velocityY: 0,
        rotationSpeed: 0,
    }));

    const state = { snapshots: [] };
    pushSnapshot(state, decoded, 0);

    const xAt33ms = extrapolatedX(state, 33);
    const xAt66ms = extrapolatedX(state, 66);
    // Position must advance monotonically and at the rate set by velocity,
    // not snap-step at 30 Hz.
    assert.ok(xAt66ms > xAt33ms, 'extrapolation must keep advancing across send intervals');
    const expectedDelta = 0.6 * 0.033;
    assert.ok(Math.abs((xAt66ms - xAt33ms) - expectedDelta) < 1e-4,
        `per-interval delta ~${expectedDelta}; got ${xAt66ms - xAt33ms}`);
});
