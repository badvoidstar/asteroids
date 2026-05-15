/**
 * SyncPayload Envelope Adapter (Phase 3 wireopt; Phase 4 dispatch added)
 *
 * Mirror of `AstervoidsWeb/Hubs/SyncPayloadCodec.cs`. Wraps and unwraps the
 * per-object game data so the wire shape can evolve (Phase 4 typed schemas,
 * Phase 5 quantization) without re-shaping the SignalR DTOs again.
 *
 * Wire shape (server-side `SyncPayload(byte SchemaId, byte[] Data)` with
 * positional `[Key(int)]`):
 *
 *   SyncPayload  ←→ [schemaId, dataBytes]      (msgpack fixarray(2))
 *
 * SchemaId = 0 ("legacy dict"): `dataBytes` is a MessagePack-encoded
 * `Dictionary<string, object?>` produced/consumed by `MsgpackCodec`.
 * SchemaId >= 1 (Phase 4): `dataBytes` is a positional record produced by
 * `SchemaCodec` using a per-session schema registered via metadata.schemas.
 *
 * Translation funnel point: `unwrap` runs at every receive boundary in
 * `session-client.js` (OnObject* handlers, JoinSession, GetSessionState) so
 * downstream game code keeps seeing a plain JS `data` object.
 *
 * Idempotence: `unwrap` is a no-op for inputs that are already a plain object
 * (older fixtures or hypothetical legacy paths); `wrap` is idempotent for
 * inputs that are already in `[schemaId, Uint8Array]` shape. This makes the
 * adapter safe to add/remove without rippling test changes.
 */
const SyncPayload = (function () {
    const LEGACY_DICT_SCHEMA_ID = 0;

    // Resolve the SchemaCodec lazily: in browsers it's a sibling global; in
    // Node tests it's loaded via require. Either way we don't take a hard
    // dependency at module-load time.
    function getSchemaCodec() {
        if (typeof window !== 'undefined' && window.SchemaCodec) return window.SchemaCodec;
        if (typeof globalThis !== 'undefined' && globalThis.SchemaCodec) return globalThis.SchemaCodec;
        if (typeof require !== 'undefined') {
            try { return require('./schema-codec.js'); } catch (_) { /* not present */ }
        }
        return null;
    }

    function isWrappedPayload(v) {
        return Array.isArray(v)
            && v.length === 2
            && typeof v[0] === 'number'
            && (v[1] instanceof Uint8Array || v[1] == null);
    }

    /**
     * Wrap a game data dict (or null) into the SyncPayload wire envelope.
     * Outbound side: applied to every per-object data field before invoke.
     *
     * @param {*} data game-side payload (plain object)
     * @param {number} [schemaId=0] schema id; 0 → MessagePack legacy dict;
     *   >=1 → positional encoding via the local SchemaCodec registry. The
     *   schema MUST be registered before this is called or the call throws.
     */
    function wrap(data, schemaId) {
        const id = (schemaId === undefined || schemaId === null) ? LEGACY_DICT_SCHEMA_ID : schemaId;
        if (data == null) {
            return [LEGACY_DICT_SCHEMA_ID, MsgpackCodec.encode({})];
        }
        if (isWrappedPayload(data)) {
            return data;
        }
        if (id === LEGACY_DICT_SCHEMA_ID) {
            return [LEGACY_DICT_SCHEMA_ID, MsgpackCodec.encode(data)];
        }
        const codec = getSchemaCodec();
        if (!codec) throw new Error(`SyncPayload.wrap: schemaId=${id} requires SchemaCodec to be loaded`);
        const schema = codec.get(id);
        if (!schema) throw new Error(`SyncPayload.wrap: no schema registered for id=${id}`);
        return [id, codec.encode(schema, data)];
    }

    /**
     * Unwrap a SyncPayload (as received from the server) into a game data dict.
     * Idempotent for legacy / already-unwrapped inputs.
     */
    function unwrap(payload) {
        if (payload == null) return null;
        if (!isWrappedPayload(payload)) {
            // Already a dict (or unexpected shape) — pass through. Game code
            // will surface any structural issues via its own decoders.
            return payload;
        }
        const schemaId = payload[0];
        const bytes = payload[1];
        if (schemaId === LEGACY_DICT_SCHEMA_ID) {
            if (bytes == null || bytes.length === 0) return {};
            return MsgpackCodec.decode(bytes);
        }
        // Phase 4 positional schema dispatch.
        const codec = getSchemaCodec();
        if (!codec) {
            throw new Error(
                `SyncPayload.unwrap: schemaId=${schemaId} requires SchemaCodec to be loaded`);
        }
        const schema = codec.get(schemaId);
        if (!schema) {
            throw new Error(
                `SyncPayload.unwrap: schemaId=${schemaId} not registered locally; ` +
                `joiner must apply session metadata.schemas before processing object events.`);
        }
        return codec.decode(schema, bytes ?? new Uint8Array(0));
    }

    /**
     * Convenience: unwrap the `data` slot on an ObjectInfo / ObjectUpdateInfo
     * in place, leaving everything else untouched. Returns the same reference
     * so callers can chain.
     */
    function unwrapObjectData(obj) {
        if (obj && obj.data !== undefined) obj.data = unwrap(obj.data);
        return obj;
    }

    return {
        LEGACY_DICT_SCHEMA_ID,
        wrap,
        unwrap,
        unwrapObjectData,
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SyncPayload;
}
