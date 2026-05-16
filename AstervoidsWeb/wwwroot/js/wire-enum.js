/**
 * Wire Enum Translation Module
 *
 * The server sends MemberRole and ObjectScope as 1-byte enum values (Phase 1 wire-opt)
 * instead of strings. JS game code historically compared these against 'Server'/'Client'
 * and 'Member'/'Session' string literals (e.g. `member.role === 'Server'`).
 *
 * This module funnels the byte → string translation through a single boundary so all
 * downstream code keeps working. Translation is idempotent (already-string values pass
 * through unchanged) so tests using string literals still work.
 *
 * Order MUST match the server-side `MemberRole` and `ObjectScope` enum declarations:
 *   MemberRole:  Server=0, Client=1   (AstervoidsWeb/Models/MemberRole.cs)
 *   ObjectScope: Member=0, Session=1  (AstervoidsWeb/Models/ObjectScope.cs)
 *
 * Wire savings: 1 byte for the enum + 1 byte msgpack uint header = ~2 bytes per occurrence,
 * vs 8-9 bytes for the corresponding string ("Server"/"Client", "Member"/"Session").
 */
const WireEnum = (function() {
    const MEMBER_ROLE_NAMES = ['Server', 'Client'];
    const OBJECT_SCOPE_NAMES = ['Member', 'Session'];

    /**
     * Convert a wire MemberRole (0/1) to its string form ('Server'/'Client').
     * Pass-through for strings (idempotent) and null/undefined.
     */
    function roleFromWire(v) {
        if (typeof v === 'number') return MEMBER_ROLE_NAMES[v] ?? null;
        return v;
    }

    /**
     * Convert a wire ObjectScope (0/1) to its string form ('Member'/'Session').
     * Pass-through for strings (idempotent) and null/undefined.
     */
    function scopeFromWire(v) {
        if (typeof v === 'number') return OBJECT_SCOPE_NAMES[v] ?? null;
        return v;
    }

    /**
     * Translate the role field on a MemberInfo in place. Safe on null/undefined.
     */
    function translateMember(member) {
        if (member && member.role !== undefined) member.role = roleFromWire(member.role);
        return member;
    }

    /**
     * Translate the scope field on an ObjectInfo in place. Safe on null/undefined.
     */
    function translateObject(obj) {
        if (obj && obj.scope !== undefined) obj.scope = scopeFromWire(obj.scope);
        return obj;
    }

    /**
     * Convert a GuidLongPair[] (each entry deserialized as a 2-element array
     * [guidString, long] after GuidUtils.transformBinaryGuids) into a
     * string-keyed object { [guidString]: long } so legacy game code that
     * indexes by id keeps working.
     *
     * Idempotent: if the value is already a plain object (e.g. from a
     * legacy server or test fixture), returns it as-is.
     */
    function pairsToObject(pairs) {
        if (pairs == null) return {};
        if (Array.isArray(pairs)) {
            const out = {};
            for (let i = 0; i < pairs.length; i++) {
                const p = pairs[i];
                if (Array.isArray(p) && p.length >= 2) {
                    out[p[0]] = p[1];
                }
            }
            return out;
        }
        return pairs;
    }

    return {
        roleFromWire,
        scopeFromWire,
        translateMember,
        translateObject,
        pairsToObject,
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = WireEnum;
}
