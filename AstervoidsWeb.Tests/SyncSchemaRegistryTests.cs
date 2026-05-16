using AstervoidsWeb.Hubs;
using FluentAssertions;
using Xunit;

namespace AstervoidsWeb.Tests;

public class SyncSchemaRegistryTests
{
    [Fact]
    public void GetSchema_UnknownSession_ReturnsNull()
    {
        var registry = new SyncSchemaRegistry();
        registry.GetSchema(Guid.NewGuid(), 1).Should().BeNull();
    }

    [Fact]
    public void GetSchema_SchemaId0_AlwaysReturnsNull()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        registry.SetSessionSchemas(sessionId, new[]
        {
            new PositionalSchemaCodec.Schema(1, new[] { new PositionalSchemaCodec.FieldSpec("x", "f64") })
        });
        registry.GetSchema(sessionId, 0).Should().BeNull();
    }

    [Fact]
    public void SetSessionSchemas_StoresAndRetrieves()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        var schema = new PositionalSchemaCodec.Schema(3, new[]
        {
            new PositionalSchemaCodec.FieldSpec("x", "f64"),
            new PositionalSchemaCodec.FieldSpec("y", "f64"),
        });
        registry.SetSessionSchemas(sessionId, new[] { schema });

        var got = registry.GetSchema(sessionId, 3);
        got.Should().NotBeNull();
        got!.Fields.Should().HaveCount(2);
        registry.HasAnySchemas(sessionId).Should().BeTrue();
    }

    [Fact]
    public void SetSessionSchemas_OverwritesPreviousSet()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        var s1 = new PositionalSchemaCodec.Schema(1, new[] { new PositionalSchemaCodec.FieldSpec("a", "u8") });
        var s2 = new PositionalSchemaCodec.Schema(2, new[] { new PositionalSchemaCodec.FieldSpec("b", "u16") });
        registry.SetSessionSchemas(sessionId, new[] { s1 });
        registry.GetSchema(sessionId, 1).Should().NotBeNull();

        registry.SetSessionSchemas(sessionId, new[] { s2 });
        registry.GetSchema(sessionId, 1).Should().BeNull();
        registry.GetSchema(sessionId, 2).Should().NotBeNull();
    }

    [Fact]
    public void ClearSession_RemovesAll()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        registry.SetSessionSchemas(sessionId, new[]
        {
            new PositionalSchemaCodec.Schema(1, new[] { new PositionalSchemaCodec.FieldSpec("x", "f64") })
        });
        registry.ClearSession(sessionId);
        registry.HasAnySchemas(sessionId).Should().BeFalse();
        registry.GetSchema(sessionId, 1).Should().BeNull();
    }

    [Fact]
    public void GetAllSchemas_ReturnsAllRegistered()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        registry.SetSessionSchemas(sessionId, new[]
        {
            new PositionalSchemaCodec.Schema(1, new[] { new PositionalSchemaCodec.FieldSpec("x", "f64") }),
            new PositionalSchemaCodec.Schema(2, new[] { new PositionalSchemaCodec.FieldSpec("y", "f64") }),
            new PositionalSchemaCodec.Schema(7, new[] { new PositionalSchemaCodec.FieldSpec("z", "f64") }),
        });
        var all = registry.GetAllSchemas(sessionId);
        all.Should().HaveCount(3);
        all.Select(s => s.Id).Should().BeEquivalentTo(new byte[] { 1, 2, 7 });
    }

    [Fact]
    public void ParseFromMetadata_NullMetadata_ReturnsEmpty()
    {
        SyncSchemaRegistry.ParseFromMetadata(null).Should().BeEmpty();
    }

    [Fact]
    public void ParseFromMetadata_NoSchemasKey_ReturnsEmpty()
    {
        var meta = new Dictionary<string, object?> { ["other"] = 1 };
        SyncSchemaRegistry.ParseFromMetadata(meta).Should().BeEmpty();
    }

    [Fact]
    public void ParseFromMetadata_StringMapEntries_BuildsSchemas()
    {
        var meta = new Dictionary<string, object?>
        {
            ["schemas"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["id"] = (byte)3,
                    ["fields"] = new object[]
                    {
                        new object[] { "x", "f64" },
                        new object[] { "y", "f64" },
                        new object[] { "angle", "f64" },
                    }
                }
            }
        };
        var schemas = SyncSchemaRegistry.ParseFromMetadata(meta);
        schemas.Should().HaveCount(1);
        schemas[0].Id.Should().Be(3);
        schemas[0].Fields.Should().HaveCount(3);
        schemas[0].Fields[2].Name.Should().Be("angle");
        schemas[0].Fields[2].Type.Should().Be("f64");
    }

    [Fact]
    public void ParseFromMetadata_RoundTripsThroughSetSessionSchemas()
    {
        var meta = new Dictionary<string, object?>
        {
            ["schemas"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["id"] = (byte)1,
                    ["fields"] = new object[] { new object[] { "value", "u32" } }
                }
            }
        };
        var schemas = SyncSchemaRegistry.ParseFromMetadata(meta);
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        registry.SetSessionSchemas(sessionId, schemas);
        var fetched = registry.GetSchema(sessionId, 1);
        fetched.Should().NotBeNull();
        fetched!.Fields[0].Name.Should().Be("value");
    }
}
