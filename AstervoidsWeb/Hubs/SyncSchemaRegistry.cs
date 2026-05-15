using System.Collections.Concurrent;

namespace AstervoidsWeb.Hubs;

/// <summary>
/// Thread-safe per-session registry of <see cref="PositionalSchemaCodec.Schema"/>
/// definitions. The game registers its schemas at session-create time
/// (via <c>metadata.schemas</c>); the hub reads them and registers them here so
/// inbound positional <see cref="SyncPayload"/> bytes can be decoded back to a
/// <c>Dictionary&lt;string, object?&gt;</c> for the existing dict-merge logic in
/// <see cref="Services.ObjectService.ApplyUpdate"/>.
///
/// The server treats schemas as opaque field-list specs: it knows how to
/// encode/decode a positional payload but knows nothing about what the fields
/// MEAN. The game-agnostic boundary is preserved.
///
/// SchemaId 0 is reserved for the legacy MessagePack-encoded dict envelope and
/// is NOT stored here — that path goes through <see cref="SyncPayloadCodec"/>.
/// </summary>
public sealed class SyncSchemaRegistry
{
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<byte, PositionalSchemaCodec.Schema>> _bySession = new();

    /// <summary>
    /// Replace the schema set for a session in one shot. Called from the hub
    /// when processing <c>CreateSession</c>'s metadata.schemas. The replacement
    /// is atomic per call but readers see either the old set or the new set
    /// (no in-between state).
    /// </summary>
    public void SetSessionSchemas(Guid sessionId, IEnumerable<PositionalSchemaCodec.Schema>? schemas)
    {
        if (schemas is null)
        {
            _bySession.TryRemove(sessionId, out _);
            return;
        }
        var map = new ConcurrentDictionary<byte, PositionalSchemaCodec.Schema>();
        foreach (var s in schemas)
        {
            map[s.Id] = s;
        }
        _bySession[sessionId] = map;
    }

    /// <summary>
    /// Removes all schemas registered for a session (called on session end).
    /// </summary>
    public void ClearSession(Guid sessionId) => _bySession.TryRemove(sessionId, out _);

    /// <summary>
    /// Returns the schema registered for <paramref name="schemaId"/> in
    /// <paramref name="sessionId"/>, or null if not registered. The caller is
    /// expected to fall back to legacy dict decoding (SchemaId=0) when null.
    /// </summary>
    public PositionalSchemaCodec.Schema? GetSchema(Guid sessionId, byte schemaId)
    {
        if (schemaId == 0) return null;
        return _bySession.TryGetValue(sessionId, out var map)
            && map.TryGetValue(schemaId, out var schema)
            ? schema
            : null;
    }

    /// <summary>
    /// True iff at least one schema is registered for <paramref name="sessionId"/>.
    /// Used by the hub to short-circuit decode work when the session never
    /// registered any schemas (still on the legacy dict path).
    /// </summary>
    public bool HasAnySchemas(Guid sessionId)
        => _bySession.TryGetValue(sessionId, out var map) && !map.IsEmpty;

    /// <summary>
    /// Snapshot of all schemas for a session in a wire-friendly form for
    /// embedding in <c>JoinSessionResponse.metadata.schemas</c> so joiners can
    /// register the same set locally.
    /// </summary>
    public IReadOnlyList<PositionalSchemaCodec.Schema> GetAllSchemas(Guid sessionId)
    {
        if (!_bySession.TryGetValue(sessionId, out var map)) return Array.Empty<PositionalSchemaCodec.Schema>();
        return map.Values.ToArray();
    }

    // ── Helpers for parsing schemas from session metadata ──────────────────

    /// <summary>
    /// Parses a session metadata.schemas entry (as deserialized from
    /// MessagePack into a list of dictionaries) into typed Schema objects.
    /// Format expected from the JS side:
    ///   schemas = [ { "id": 3, "fields": [ ["x","f64"], ["y","f64"], ... ] }, ... ]
    /// Returns an empty list if metadata is null / does not contain "schemas".
    /// </summary>
    public static IReadOnlyList<PositionalSchemaCodec.Schema> ParseFromMetadata(IDictionary<string, object?>? metadata)
    {
        if (metadata is null || !metadata.TryGetValue("schemas", out var raw) || raw is null)
            return Array.Empty<PositionalSchemaCodec.Schema>();

        var schemas = new List<PositionalSchemaCodec.Schema>();
        if (raw is not System.Collections.IEnumerable list)
            throw new InvalidOperationException("metadata.schemas must be an array");

        foreach (var item in list)
        {
            if (item is not IDictionary<object, object?> entry && item is not IDictionary<string, object?>)
                throw new InvalidOperationException("metadata.schemas entries must be maps with 'id' and 'fields'");

            object? idVal = null;
            object? fieldsVal = null;
            if (item is IDictionary<string, object?> stringMap)
            {
                stringMap.TryGetValue("id", out idVal);
                stringMap.TryGetValue("fields", out fieldsVal);
            }
            else if (item is IDictionary<object, object?> objMap)
            {
                objMap.TryGetValue("id", out idVal);
                objMap.TryGetValue("fields", out fieldsVal);
            }

            if (idVal is null || fieldsVal is null)
                throw new InvalidOperationException("metadata.schemas entry missing 'id' or 'fields'");

            byte id = Convert.ToByte(idVal);
            var fields = new List<PositionalSchemaCodec.FieldSpec>();
            if (fieldsVal is not System.Collections.IEnumerable fieldList)
                throw new InvalidOperationException($"schema {id}: 'fields' must be an array");

            foreach (var fieldItem in fieldList)
            {
                if (fieldItem is not System.Collections.IEnumerable pair)
                    throw new InvalidOperationException($"schema {id}: each field must be a [name, type] pair");
                string? name = null;
                string? type = null;
                int idx = 0;
                foreach (var p in pair)
                {
                    if (idx == 0) name = p?.ToString();
                    else if (idx == 1) type = p?.ToString();
                    idx++;
                }
                if (name is null || type is null)
                    throw new InvalidOperationException($"schema {id}: field must be [name, type]");
                fields.Add(new PositionalSchemaCodec.FieldSpec(name, type));
            }
            schemas.Add(new PositionalSchemaCodec.Schema(id, fields));
        }
        return schemas;
    }
}
