using AstervoidsWeb.Formatters;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using FluentAssertions;
using MessagePack;
using MessagePack.Resolvers;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Wire-size baseline tests for the wireopt roadmap. Locks in current MessagePack
/// byte counts for representative payloads so subsequent phases can measure their
/// savings (and so any phase that regresses byte counts fails CI).
///
/// IMPORTANT: when a wireopt phase intentionally shrinks a payload, update the
/// constant in this file *as part of the same commit* and reference the phase id.
/// Each constant doubles as both a baseline assertion and a docstring of the
/// expected after-state for future phases.
/// </summary>
public class WireSizeBenchTests
{
    private static readonly MessagePackSerializerOptions Options =
        MessagePackSerializerOptions.Standard
            .WithResolver(CompositeResolver.Create(
                BinaryGuidResolver.Instance,
                ContractlessStandardResolver.Instance))
            .WithSecurity(MessagePackSecurity.UntrustedData);

    private static int Size<T>(T value) => MessagePackSerializer.Serialize(value, Options).Length;

    // ── Representative payloads ────────────────────────────────────────────────

    private static ObjectInfo SampleAsteroidInfo() => new(
        Id: Guid.NewGuid(),
        CreatorMemberId: Guid.NewGuid(),
        OwnerMemberId: Guid.NewGuid(),
        Scope: ObjectScope.Session,
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.5,
            ["y"] = 0.5,
            ["radius"] = 0.05,
            ["velocityX"] = 0.1,
            ["velocityY"] = -0.05,
            ["angle"] = 1.234,
            ["rotationSpeed"] = 0.02,
            ["seed"] = 12345
        }),
        Version: 1L);

    private static ObjectInfo SampleShipInfo() => new(
        Id: Guid.NewGuid(),
        CreatorMemberId: Guid.NewGuid(),
        OwnerMemberId: Guid.NewGuid(),
        Scope: ObjectScope.Member,
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["type"] = "ship",
            ["x"] = 0.5,
            ["y"] = 0.5,
            ["angle"] = 0.0,
            ["velocityX"] = 0.0,
            ["velocityY"] = 0.0,
            ["rotationSpeed"] = 0.0,
            ["thrusting"] = false,
            ["invulnerable"] = false,
            ["colorIndex"] = 0,
            ["memberId"] = Guid.NewGuid().ToString(),
            ["score"] = 0,
            ["hitCount"] = 0
        }),
        Version: 1L);

    private static ObjectUpdateInfo SampleAsteroidUpdate() => new(
        Id: Guid.NewGuid(),
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234
        }),
        Version: 42L);

    private static ObjectUpdateInfo SampleShipUpdate() => new(
        Id: Guid.NewGuid(),
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234,
            ["velocityX"] = 0.05,
            ["velocityY"] = -0.03,
            ["rotationSpeed"] = 0.01,
            ["thrusting"] = true,
            ["invulnerable"] = false
            // Phase 2.3 (A4): score and hitCount no longer ride on per-frame
            // updates; pushed via OnObjectEvent instead. Snapshot reconciliation
            // (toSyncData / SampleShipInfo) still includes them.
        }),
        Version: 42L);

    private static ObjectUpdateInfo SampleBulletUpdate() => new(
        Id: Guid.NewGuid(),
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["lifetime"] = 0.8,
            ["pendingHit"] = true,
            ["hitTargetId"] = Guid.NewGuid().ToString(),
            ["hitImpactTorque"] = 0.05,
            ["hitBulletAngle"] = 1.57,
            ["hitOffsetN"] = 0.3
        }),
        Version: 17L);

    // ── Phase 4 positional-encoded variants ────────────────────────────────────
    // These mirror the schemas registered by the game in index.html (WIREOPT_SCHEMAS).
    // Used by the Phase4_* bench tests to lock the wire savings into CI.

    private static readonly PositionalSchemaCodec.Schema AsteroidUpdateSchema =
        new(3, new[] {
            new PositionalSchemaCodec.FieldSpec("x", "f64"),
            new PositionalSchemaCodec.FieldSpec("y", "f64"),
            new PositionalSchemaCodec.FieldSpec("angle", "f64"),
        });

    private static readonly PositionalSchemaCodec.Schema ShipUpdateSchema =
        new(1, new[] {
            new PositionalSchemaCodec.FieldSpec("x", "f64"),
            new PositionalSchemaCodec.FieldSpec("y", "f64"),
            new PositionalSchemaCodec.FieldSpec("angle", "f64"),
            new PositionalSchemaCodec.FieldSpec("velocityX", "f64"),
            new PositionalSchemaCodec.FieldSpec("velocityY", "f64"),
            new PositionalSchemaCodec.FieldSpec("rotationSpeed", "f64"),
            new PositionalSchemaCodec.FieldSpec("thrusting", "bool"),
            new PositionalSchemaCodec.FieldSpec("invulnerable", "bool"),
        });

    // ── Phase 5 quantized variants ─────────────────────────────────────────
    // Mirror the live game schemas registered in index.html WIREOPT_SCHEMAS.
    private static readonly PositionalSchemaCodec.Schema AsteroidUpdateSchemaQ =
        new(3, new[] {
            new PositionalSchemaCodec.FieldSpec("x", "q16"),
            new PositionalSchemaCodec.FieldSpec("y", "q16"),
            new PositionalSchemaCodec.FieldSpec("angle", "q16_2pi"),
        });

    private static readonly PositionalSchemaCodec.Schema ShipUpdateSchemaQ =
        new(1, new[] {
            new PositionalSchemaCodec.FieldSpec("x", "q16"),
            new PositionalSchemaCodec.FieldSpec("y", "q16"),
            new PositionalSchemaCodec.FieldSpec("angle", "q16_2pi"),
            new PositionalSchemaCodec.FieldSpec("velocityX", "q16s"),
            new PositionalSchemaCodec.FieldSpec("velocityY", "q16s"),
            new PositionalSchemaCodec.FieldSpec("rotationSpeed", "q16s"),
            new PositionalSchemaCodec.FieldSpec("thrusting", "bool"),
            new PositionalSchemaCodec.FieldSpec("invulnerable", "bool"),
        });

    private static ObjectUpdateInfo SampleAsteroidUpdatePositional() => new(
        Id: Guid.NewGuid(),
        Data: new SyncPayload(3, PositionalSchemaCodec.Encode(AsteroidUpdateSchema, new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234,
        })),
        Version: 42L);

    private static ObjectUpdateInfo SampleShipUpdatePositional() => new(
        Id: Guid.NewGuid(),
        Data: new SyncPayload(1, PositionalSchemaCodec.Encode(ShipUpdateSchema, new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234,
            ["velocityX"] = 0.05,
            ["velocityY"] = -0.03,
            ["rotationSpeed"] = 0.01,
            ["thrusting"] = true,
            ["invulnerable"] = false,
        })),
        Version: 42L);

    // ── Per-payload baselines (current main, as of wireopt phase 0) ────────────

    [Fact]
    public void Baseline_AsteroidInfo_FullCreate()
    {
        // 9 data fields including string GUIDs for member ids embedded as keys/values.
        // Expected ranges accommodate slight variation per Guid (binary GUIDs are fixed 18 B).
        var size = Size(SampleAsteroidInfo());
        // Phase 3 envelope (measured: 252 B). Wire shape now includes
        // SyncPayload(fixarray2 + schemaId byte + bin8 length header) ≈ +4 B vs
        // the pre-envelope dict-in-place encoding.
        size.Should().BeInRange(240, 270, "asteroid full-create payload (Phase 3 envelope)");
    }

    [Fact]
    public void Baseline_ShipInfo_FullCreate()
    {
        var size = Size(SampleShipInfo());
        // Phase 3 envelope (measured: 335 B). +~4 B envelope absorbed in range.
        size.Should().BeInRange(320, 355, "ship full-create payload (Phase 3 envelope)");
    }

    [Fact]
    public void Baseline_AsteroidUpdate_PerFrame()
    {
        var size = Size(SampleAsteroidUpdate());
        // Phase 3 envelope (measured: 78 B). Pre-Phase-3 baseline was ~75 B.
        // Goal in Phase 4 (typed schema): ~22 B. Goal in Phase 5 (quantized): ~10 B.
        size.Should().BeInRange(65, 85, "asteroid per-frame update (Phase 3 envelope)");
    }

    [Fact]
    public void Baseline_ShipUpdate_PerFrame()
    {
        var size = Size(SampleShipUpdate());
        // Phase 3 envelope (measured: 164 B). Pre-Phase-3 baseline post-Phase-2.3 was ~165 B.
        // Phase 4 typed schema reduces further; Phase 5 quantization further still.
        size.Should().BeInRange(150, 180, "ship per-frame update (Phase 3 envelope, post-Phase-2.3)");
    }

    [Fact]
    public void Baseline_BulletUpdate_PerFrame_WithPendingHit()
    {
        var size = Size(SampleBulletUpdate());
        // Phase 3 envelope (measured: 212 B). Pre-Phase-3 baseline was ~208 B.
        // Phase 2 (A5) deferred: still carries all 5 hit-related fields per frame.
        size.Should().BeInRange(195, 225, "bullet per-frame update (Phase 3 envelope, A5 deferred)");
    }

    // ── Batch-level baselines (one OnObjectsUpdated broadcast) ────────────────

    [Fact]
    public void Baseline_OnObjectsUpdated_3Asteroids()
    {
        // The hot-path broadcast carries List<ObjectUpdateInfo>; this is a typical
        // multi-asteroid frame. Used as the single most-impactful regression gate.
        var batch = new List<ObjectUpdateInfo>
        {
            SampleAsteroidUpdate(),
            SampleAsteroidUpdate(),
            SampleAsteroidUpdate()
        };
        var size = Size(batch);
        // Phase 3 envelope (measured: 235 B). Pre-Phase-3 baseline was ~225 B (+~3 B/object).
        size.Should().BeInRange(200, 250, "OnObjectsUpdated with 3 asteroids (Phase 3 envelope)");
    }

    [Fact]
    public void Baseline_OnObjectsUpdated_MixedSession()
    {
        // Realistic steady-state: 4 asteroids + 1 ship + 2 bullets = 7-object batch.
        var batch = new List<ObjectUpdateInfo>
        {
            SampleAsteroidUpdate(), SampleAsteroidUpdate(),
            SampleAsteroidUpdate(), SampleAsteroidUpdate(),
            SampleShipUpdate(),
            SampleBulletUpdate(), SampleBulletUpdate()
        };
        var size = Size(batch);
        // Phase 3 envelope (measured: 901 B). Pre-Phase-3 baseline post-Phase-2.3
        // was ~878 B; +23 B = ~+3 B per object × 7 objects.
        size.Should().BeInRange(850, 910, "mixed steady-state OnObjectsUpdated (Phase 3 envelope)");
    }

    // ── Snapshot baselines (rare path; one-shot per join) ─────────────────────

    [Fact]
    public void Baseline_JoinSessionResponse_4Asteroids_2Ships()
    {
        var validAtsList = new List<GuidLongPair>();
        var objects = new List<ObjectInfo>();
        for (int i = 0; i < 4; i++)
        {
            var o = SampleAsteroidInfo();
            objects.Add(o);
            validAtsList.Add(new GuidLongPair(o.Id, 1_700_000_000_000L + i));
        }
        for (int i = 0; i < 2; i++)
        {
            var o = SampleShipInfo();
            objects.Add(o);
            validAtsList.Add(new GuidLongPair(o.Id, 1_700_000_000_500L + i));
        }
        var members = new[]
        {
            new MemberInfo(Guid.NewGuid(), MemberRole.Server, DateTime.UtcNow),
            new MemberInfo(Guid.NewGuid(), MemberRole.Client, DateTime.UtcNow)
        };
        var dto = new JoinSessionResponse(
            SessionId: Guid.NewGuid(),
            SessionName: "Banana",
            MemberId: Guid.NewGuid(),
            Role: MemberRole.Client,
            Members: members,
            Objects: objects,
            ValidAts: validAtsList.ToArray(),
            Metadata: new Dictionary<string, object?> { ["aspectRatio"] = 1.78 });

        var size = Size(dto);
        // Phase 3 envelope: ObjectInfo×6 each gains ~+4 B (fixarray2 + schemaId
        // + bin8 length header). Roughly +24 B vs the post-Phase-1 baseline of
        // 2056 B (range had ~24 B headroom). Phase 4 typed schemas will then
        // shrink each ObjectInfo's data slot considerably.
        size.Should().BeInRange(2030, 2090, "JoinSessionResponse with 4 asteroids + 2 ships (Phase 3 envelope)");
    }

    [Fact]
    public void Baseline_UpdateObjectsResponse_3Versions()
    {
        var versions = new[]
        {
            new GuidLongPair(Guid.NewGuid(), 10),
            new GuidLongPair(Guid.NewGuid(), 11),
            new GuidLongPair(Guid.NewGuid(), 12)
        };
        var dto = new UpdateObjectsResponse(versions, 42L, 1_700_000_000_000L);
        var size = Size(dto);
        // Phase 1 measured (was 184 B baseline, now 112 B): -72 B / -39%.
        // B3: versions Dict<string,long>(N=3) → GuidLongPair[N=3]. ~24 B per entry vs ~47 B per entry.
        size.Should().BeInRange(95, 130, "UpdateObjectsResponse 3-versions post-Phase-1");
    }

    // ── Phase 2.1 — generic OnObjectEvent broadcast ────────────────────────────

    [Fact]
    public void Baseline_ObjectEvent_ShipStateChanged()
    {
        // Phase 2.3: replaces per-frame score+hitCount on the ship update.
        // Sent only when score/hitCount changes (1 per asteroid kill, 1 per
        // ship hit) — far rarer than per-frame.
        var dto = new ObjectEventInfo(
            ObjectId: Guid.NewGuid(),
            EventKind: 1, // SHIP_STATE_CHANGED
            Payload: new Dictionary<string, object?>
            {
                ["score"] = 100,
                ["hitCount"] = 2
            });
        var size = Size(dto);
        // Measured: 73 B. Composition: ObjectId binary GUID (~18 B) + EventKind
        // (1 B) + payload dict (~50 B for 2 keys + 2 small ints) + envelope.
        // The break-even vs leaving fields in per-frame updates depends on
        // event-rate vs send-rate. At 10 Hz send-rate and ~1 score change per
        // second per ship, A4 saves ~150 B/s/ship.
        size.Should().BeInRange(60, 90, "ObjectEvent ship-state-changed payload");
    }

    // ── Phase 4 positional schema baselines ────────────────────────────────────

    [Fact]
    public void Phase4_AsteroidUpdate_PerFrame_Positional()
    {
        var size = Size(SampleAsteroidUpdatePositional());
        // Measured: 65 B (down from 78 B Phase 3 dict path; ~17% reduction).
        // Composition: id GUID(18) + version(varint) + SyncPayload.SchemaId(1) +
        // bin8 length header(2) + bitmask(1) + 3×f64(24) + array/wrap overhead.
        // Goal in Phase 5 (q16 quantization): asteroid update body shrinks from
        // 25 B to 7 B (1 B mask + 3×u16(6) = 7 B), reducing total to ~47 B.
        size.Should().BeInRange(55, 75, "asteroid per-frame update (Phase 4 positional)");
    }

    [Fact]
    public void Phase4_ShipUpdate_PerFrame_Positional()
    {
        var size = Size(SampleShipUpdatePositional());
        // Measured: 91 B (down from 164 B Phase 3 dict path; ~45% reduction).
        // Body: bitmask(1) + 6×f64(48) + 2×bool(2) = 51 B. Wins are bigger here
        // because dict keys ("velocityX", "rotationSpeed", etc.) were costly.
        size.Should().BeInRange(80, 105, "ship per-frame update (Phase 4 positional)");
    }

    [Fact]
    public void Phase4_OnObjectsUpdated_3Asteroids_Positional()
    {
        var batch = new List<ObjectUpdateInfo>
        {
            SampleAsteroidUpdatePositional(),
            SampleAsteroidUpdatePositional(),
            SampleAsteroidUpdatePositional()
        };
        var size = Size(batch);
        // Measured: 196 B (down from 235 B Phase 3 dict path; ~17% reduction).
        size.Should().BeInRange(180, 215, "OnObjectsUpdated 3 asteroids (Phase 4 positional)");
    }

    [Fact]
    public void Phase4_AsteroidUpdate_DeltaOnly_Positional()
    {
        // Delta-encoder sends only changed slots — say only x changed this frame.
        // Bitmask = 0b001 (1 B) + 1×f64(8) = 9 B body.
        var data = PositionalSchemaCodec.Encode(AsteroidUpdateSchema, new Dictionary<string, object?>
        {
            ["x"] = 0.523
        });
        var update = new ObjectUpdateInfo(
            Id: Guid.NewGuid(),
            Data: new SyncPayload(3, data),
            Version: 42L);
        var size = Size(update);
        // Measured: 49 B (down from 78 B full Phase 3 dict path).
        size.Should().BeInRange(40, 60, "asteroid delta update with only x present (Phase 4 positional)");
    }

    // ── Phase 5 quantized schema baselines ─────────────────────────────────────

    private static ObjectUpdateInfo SampleAsteroidUpdateQuantized() => new(
        Id: Guid.NewGuid(),
        Data: new SyncPayload(3, PositionalSchemaCodec.Encode(AsteroidUpdateSchemaQ, new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234,
        })),
        Version: 42L);

    private static ObjectUpdateInfo SampleShipUpdateQuantized() => new(
        Id: Guid.NewGuid(),
        Data: new SyncPayload(1, PositionalSchemaCodec.Encode(ShipUpdateSchemaQ, new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234,
            ["velocityX"] = 0.05,
            ["velocityY"] = -0.03,
            ["rotationSpeed"] = 0.01,
            ["thrusting"] = true,
            ["invulnerable"] = false,
        })),
        Version: 42L);

    [Fact]
    public void Phase5_AsteroidUpdate_PerFrame_Quantized()
    {
        var size = Size(SampleAsteroidUpdateQuantized());
        // Measured: 47 B (down from 65 B Phase 4 f64 = -18 B; -28% just from Phase 5).
        // Body: bitmask(1) + 3×u16(6) = 7 B (vs 25 B for Phase 4 f64).
        // Wrapper dominates: id GUID(18) + version(varint) + SyncPayload header(3) ≈ 22 B.
        size.Should().BeInRange(40, 55, "asteroid per-frame update (Phase 5 quantized)");
    }

    [Fact]
    public void Phase5_ShipUpdate_PerFrame_Quantized()
    {
        var size = Size(SampleShipUpdateQuantized());
        // Body: bitmask(1) + 6×i/u16(12) + 2×bool(2) = 15 B (vs 51 B Phase 4 f64 = -36 B).
        // Wrapped ObjectUpdateInfo: ~40-50 B (vs 91 B Phase 4 f64; ~50% reduction).
        size.Should().BeInRange(35, 55, "ship per-frame update (Phase 5 quantized)");
    }

    [Fact]
    public void Phase5_OnObjectsUpdated_3Asteroids_Quantized()
    {
        var batch = new List<ObjectUpdateInfo>
        {
            SampleAsteroidUpdateQuantized(),
            SampleAsteroidUpdateQuantized(),
            SampleAsteroidUpdateQuantized()
        };
        var size = Size(batch);
        // Measured: 142 B (3 × ~47 B + array header). Vs 196 B Phase 4 (-28%); vs 235 B Phase 3 (-40%).
        size.Should().BeInRange(125, 165, "OnObjectsUpdated 3 asteroids (Phase 5 quantized)");
    }

    [Fact]
    public void Phase5_OnObjectsUpdated_MixedSession_Quantized()
    {
        // Realistic steady-state with quantized schemas in flight.
        // 4 quantized asteroids + 1 quantized ship + 2 legacy bullet updates.
        var batch = new List<ObjectUpdateInfo>
        {
            SampleAsteroidUpdateQuantized(), SampleAsteroidUpdateQuantized(),
            SampleAsteroidUpdateQuantized(), SampleAsteroidUpdateQuantized(),
            SampleShipUpdateQuantized(),
            SampleBulletUpdate(), SampleBulletUpdate()
        };
        var size = Size(batch);
        // Ships and asteroids dominate the savings; bullets stay on the legacy
        // dict path until the pendingHit handshake (Phase 2.2) is converted.
        // Phase 3 baseline: 901 B. Expected Phase 5: ~600-650 B (~30% further reduction).
        size.Should().BeInRange(550, 700, "mixed steady-state OnObjectsUpdated (Phase 5 quantized)");
    }
}
