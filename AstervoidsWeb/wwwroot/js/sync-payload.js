/**
 * SyncPayload Envelope Adapter (Phase 3 wireopt)
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
 * `Dictionary<string, object?>` produced/consumed by `MsgpackCodec`. This is
 * the only schema implemented in Phase 3.
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

    function isWrappedPayload(v) {
        return Array.isArray(v)
            && v.length === 2
            && typeof v[0] === 'number'
            && (v[1] instanceof Uint8Array || v[1] == null);
    }

    /**
     * Wrap a game data dict (or null) into the SyncPayload wire envelope.
     * Outbound side: applied to every per-object data field before invoke.
     * Returns a 2-element array [schemaId, Uint8Array] which signalr-protocol-
     * msgpack will encode as a fixarray(2) — matching the server's
     * `[Key(0)/(1)]` SyncPayload record layout.
     */
    function wrap(data) {
        if (data == null) {
            return [LEGACY_DICT_SCHEMA_ID, MsgpackCodec.encode({})];
        }
        if (isWrappedPayload(data)) {
            return data;
        }
        return [LEGACY_DICT_SCHEMA_ID, MsgpackCodec.encode(data)];
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
        if (schemaId !== LEGACY_DICT_SCHEMA_ID) {
            throw new Error(
                `SyncPayload schemaId=${schemaId} not supported by Phase 3 client; ` +
                `Phase 4 will register additional schemas via session metadata.`);
        }
        if (bytes == null || bytes.length === 0) return {};
        return MsgpackCodec.decode(bytes);
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
