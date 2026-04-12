/**
 * GUID Utilities Module
 * Converts between .NET binary GUIDs (16-byte Uint8Array) and string GUIDs.
 *
 * When the server serializes Guid properties via MessagePack with BinaryGuidFormatter,
 * they arrive as Uint8Array(16) on the JS side. This module converts them back to
 * standard GUID strings so all game code continues to use string comparisons,
 * Map keys, etc. without changes.
 *
 * .NET Guid.TryWriteBytes uses mixed-endian layout:
 *   bytes[0-3]:  group 1 (int32, little-endian)
 *   bytes[4-5]:  group 2 (int16, little-endian)
 *   bytes[6-7]:  group 3 (int16, little-endian)
 *   bytes[8-15]: groups 4+5 (big-endian)
 */

const GuidUtils = (function() {
    const hex = new Array(256);
    for (let i = 0; i < 256; i++) {
        hex[i] = i.toString(16).padStart(2, '0');
    }

    /**
     * Convert a 16-byte Uint8Array (.NET binary Guid) to a lowercase GUID string.
     * Returns null if the input is not a 16-byte Uint8Array.
     */
    function bytesToGuid(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length !== 16) return null;

        // .NET mixed-endian: reverse first 3 groups, big-endian for last 2
        return (
            hex[bytes[3]] + hex[bytes[2]] + hex[bytes[1]] + hex[bytes[0]] + '-' +
            hex[bytes[5]] + hex[bytes[4]] + '-' +
            hex[bytes[7]] + hex[bytes[6]] + '-' +
            hex[bytes[8]] + hex[bytes[9]] + '-' +
            hex[bytes[10]] + hex[bytes[11]] + hex[bytes[12]] + hex[bytes[13]] +
            hex[bytes[14]] + hex[bytes[15]]
        );
    }

    /**
     * Recursively walk a value and convert any 16-byte Uint8Array to a GUID string.
     * Applied at the session-client boundary so all downstream game code sees strings.
     * Mutates the object in place for efficiency (freshly deserialized from MessagePack).
     */
    function transformBinaryGuids(value) {
        if (value == null || typeof value !== 'object') return value;

        // 16-byte Uint8Array → GUID string
        if (value instanceof Uint8Array) {
            return value.length === 16 ? bytesToGuid(value) : value;
        }

        // Recurse into arrays
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                value[i] = transformBinaryGuids(value[i]);
            }
            return value;
        }

        // Recurse into plain objects (Map/Set/Date etc. are left alone)
        if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
            for (const key in value) {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    value[key] = transformBinaryGuids(value[key]);
                }
            }
        }
        return value;
    }

    return { bytesToGuid, transformBinaryGuids };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GuidUtils;
}
