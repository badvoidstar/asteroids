// Run with: node --test AstervoidsWeb/msgpack-codec-cross.test.mjs
//
// Cross-side wire fixtures for the Phase 3 SyncPayload envelope.
// The hex strings here MUST match the constants in
// AstervoidsWeb.Tests/SyncPayloadCrossWireFixturesTests.cs. Together
// they prove the JS msgpack codec interops with MessagePack-CSharp on
// the wire for the SchemaId=0 (legacy dict) format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');

function fromHex(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

test('decode C# `simple` fixture (two doubles)', () => {
    const hex = '82a178cb3fe0000000000000a179cb3fd0000000000000';
    const v = MsgpackCodec.decode(fromHex(hex));
    assert.deepEqual(v, { x: 0.5, y: 0.25 });
});

test('decode C# `ship` fixture (mixed doubles + bools)', () => {
    const hex =
        '85' +
        'a178' + 'cb3fe0bc6a7ef9db23' +
        'a179' + 'cb3fda5e353f7ced91' +
        'a5616e676c65' + 'cb3ff3be76c8b43958' +
        'a9746872757374696e67' + 'c3' +
        'ac696e76756c6e657261626c65' + 'c2';
    const v = MsgpackCodec.decode(fromHex(hex));
    assert.deepEqual(v, {
        x: 0.523, y: 0.412, angle: 1.234,
        thrusting: true, invulnerable: false
    });
});

test('decode C# `with_int` fixture (int32-encoded ints)', () => {
    // C# emits int32 (5 B) for `int` literals — JS decoder accepts.
    const hex = '82' + 'a573636f7265' + 'd200000064' + 'a8686974436f756e74' + 'd200000002';
    const v = MsgpackCodec.decode(fromHex(hex));
    assert.deepEqual(v, { score: 100, hitCount: 2 });
});

test('decode C# `with_string_guid` fixture (str8 GUID)', () => {
    // 81 a8 "memberId" d9 24 "abcdef01-...-456789"
    const guid = 'abcdef01-2345-6789-abcd-ef0123456789';
    const guidHex = Array.from(guid).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    const hex = '81' + 'a8' + '6d656d6265724964' + 'd924' + guidHex;
    const v = MsgpackCodec.decode(fromHex(hex));
    assert.deepEqual(v, { memberId: guid });
});

test('decode C# `with_null` fixture (nil + false)', () => {
    const hex = '82' + 'ab' + '6869745461726765744964' + 'c0' + 'aa' + '70656e64696e67486974' + 'c2';
    const v = MsgpackCodec.decode(fromHex(hex));
    assert.deepEqual(v, { hitTargetId: null, pendingHit: false });
});

test('JS-encoded fixint (1 byte) round-trips through C#-style decode', () => {
    // Inverse direction: JS encodes 100 as 0x64 (1 byte). C# decoder
    // (PrimitiveObjectFormatter) reads it as `byte 100`. Game code
    // never observes the type difference. Verify our own decoder
    // also reads 0x64 back as 100.
    const enc = MsgpackCodec.encode({ score: 100 });
    // Expect: 81 (map1) a5 73636f7265 ("score") 64 (fixint 100)
    assert.equal(enc.length, 8); // 1 + 1 + 5 + 1 = 8
    assert.equal(enc[7], 0x64);
    assert.deepEqual(MsgpackCodec.decode(enc), { score: 100 });
});
