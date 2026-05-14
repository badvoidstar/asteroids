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
        Data: new Dictionary<string, object?>
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
        },
        Version: 1L);

    private static ObjectInfo SampleShipInfo() => new(
        Id: Guid.NewGuid(),
        CreatorMemberId: Guid.NewGuid(),
        OwnerMemberId: Guid.NewGuid(),
        Scope: ObjectScope.Member,
        Data: new Dictionary<string, object?>
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
        },
        Version: 1L);

    private static ObjectUpdateInfo SampleAsteroidUpdate() => new(
        Id: Guid.NewGuid(),
        Data: new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234
        },
        Version: 42L);

    private static ObjectUpdateInfo SampleShipUpdate() => new(
        Id: Guid.NewGuid(),
        Data: new Dictionary<string, object?>
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
        },
        Version: 42L);

    private static ObjectUpdateInfo SampleBulletUpdate() => new(
        Id: Guid.NewGuid(),
        Data: new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["lifetime"] = 0.8,
            ["pendingHit"] = true,
            ["hitTargetId"] = Guid.NewGuid().ToString(),
            ["hitImpactTorque"] = 0.05,
            ["hitBulletAngle"] = 1.57,
            ["hitOffsetN"] = 0.3
        },
        Version: 17L);

    // ── Per-payload baselines (current main, as of wireopt phase 0) ────────────

    [Fact]
    public void Baseline_AsteroidInfo_FullCreate()
    {
        // 9 data fields including string GUIDs for member ids embedded as keys/values.
        // Expected ranges accommodate slight variation per Guid (binary GUIDs are fixed 18 B).
        var size = Size(SampleAsteroidInfo());
        // Measured baseline (wireopt phase 0): 255 B
        size.Should().BeInRange(240, 270, "asteroid full-create payload baseline");
    }

    [Fact]
    public void Baseline_ShipInfo_FullCreate()
    {
        var size = Size(SampleShipInfo());
        // Measured baseline (wireopt phase 0): 337 B (ship has more fields and a
        // string-encoded memberId inside data)
        size.Should().BeInRange(320, 355, "ship full-create payload baseline");
    }

    [Fact]
    public void Baseline_AsteroidUpdate_PerFrame()
    {
        var size = Size(SampleAsteroidUpdate());
        // Measured baseline (wireopt phase 0): ~75 B (dominant hot-path cost).
        // Goal in Phase 4 (typed schema): ~22 B. Goal in Phase 5 (quantized): ~10 B.
        size.Should().BeInRange(65, 85, "asteroid per-frame update baseline");
    }

    [Fact]
    public void Baseline_ShipUpdate_PerFrame()
    {
        var size = Size(SampleShipUpdate());
        // Phase 2.3 measured (was 185 B baseline, now ~165 B): -20 B / -11%.
        // A4: score+hitCount removed (each ~10 B as msgpack int + key string).
        // Phase 4 typed schema reduces further; Phase 5 quantization further still.
        size.Should().BeInRange(150, 180, "ship per-frame update post-Phase-2.3");
    }

    [Fact]
    public void Baseline_BulletUpdate_PerFrame_WithPendingHit()
    {
        var size = Size(SampleBulletUpdate());
        // Measured baseline (wireopt phase 0): 208 B
        // Phase 2 (A5) moves all 5 hit-related fields to a one-shot OnObjectEvent.
        // Expected post-A5 reduction: ~100 B per hit-bearing bullet frame.
        size.Should().BeInRange(195, 225, "bullet per-frame update baseline (with pendingHit)");
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
        // Measured baseline (wireopt phase 0): ~225 B
        size.Should().BeInRange(200, 250, "OnObjectsUpdated with 3 asteroids baseline");
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
        // Phase 2.3 measured (was 898 B baseline, now ~878 B): -20 B from
        // SampleShipUpdate stripping score+hitCount.
        size.Should().BeInRange(850, 910, "mixed steady-state OnObjectsUpdated post-Phase-2.3");
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
        // Phase 1 measured (was 2228 B baseline, now 2056 B): -172 B / -7.7%.
        // Composition: B1 validAts → GuidLongPair[] (~13 B × 6 ≈ 78 B), C1 scope → byte
        // (~7 B × 6 = 42 B), C2 role → byte (~7 B × 3 = 21 B). Includes joiner role too.
        size.Should().BeInRange(2030, 2080, "JoinSessionResponse with 4 asteroids + 2 ships post-Phase-1");
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
}
