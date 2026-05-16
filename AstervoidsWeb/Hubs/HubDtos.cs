using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using MessagePack;

namespace AstervoidsWeb.Hubs;

// Session responses
[MessagePackObject]
public record CreateSessionResponse(
    [property: Key("sessionId")] Guid SessionId,
    [property: Key("sessionName")] string SessionName,
    [property: Key("memberId")] Guid MemberId,
    [property: Key("role")] MemberRole Role,
    [property: Key("metadata")] Dictionary<string, object?> Metadata);

[MessagePackObject]
public record JoinSessionResponse(
    [property: Key("sessionId")] Guid SessionId,
    [property: Key("sessionName")] string SessionName,
    [property: Key("memberId")] Guid MemberId,
    [property: Key("role")] MemberRole Role,
    [property: Key("members")] IEnumerable<MemberInfo> Members,
    [property: Key("objects")] IEnumerable<ObjectInfo> Objects,
    [property: Key("validAts")] GuidLongPair[] ValidAts,
    [property: Key("metadata")] Dictionary<string, object?> Metadata
);

[MessagePackObject]
public record ActiveSessionsResponse(
    [property: Key("sessions")] IEnumerable<SessionListItem> Sessions,
    [property: Key("maxSessions")] int MaxSessions,
    [property: Key("canCreateSession")] bool CanCreateSession);

[MessagePackObject]
public record SessionListItem(
    [property: Key("id")] Guid Id,
    [property: Key("name")] string Name,
    [property: Key("memberCount")] int MemberCount,
    [property: Key("maxMembers")] int MaxMembers,
    [property: Key("createdAt")] DateTime CreatedAt);

[MessagePackObject]
public record SessionStateSnapshot(
    [property: Key("members")] IEnumerable<MemberInfo> Members,
    [property: Key("objects")] IEnumerable<ObjectInfo> Objects,
    [property: Key("validAts")] GuidLongPair[] ValidAts,
    [property: Key("memberSequences")] GuidLongPair[] MemberSequences);

// Member info
[MessagePackObject]
public record MemberInfo(
    [property: Key("id")] Guid Id,
    [property: Key("role")] MemberRole Role,
    [property: Key("joinedAt")] DateTime JoinedAt);

[MessagePackObject]
public record MemberLeftInfo(
    [property: Key("memberId")] Guid MemberId,
    [property: Key("promotedMemberId")] Guid? PromotedMemberId,
    [property: Key("promotedRole")] MemberRole? PromotedRole,
    [property: Key("deletedObjectIds")] IEnumerable<Guid> DeletedObjectIds,
    [property: Key("migratedObjects")] IEnumerable<ObjectMigration> MigratedObjects
);

// Object info and operations
// ValidAt is no longer per-object on the wire. Live broadcasts (OnObjectCreated,
// OnObjectsUpdated, OnObjectReplaced) carry a single batch-level validAt trailing
// argument. Snapshot DTOs (JoinSessionResponse, SessionStateSnapshot) carry a
// parallel ValidAts array (GuidLongPair[]) so each pre-existing object keeps its
// own age. SessionObject.ValidAt remains the server-side storage.
//
// Phase 3 (wireopt envelope): the per-object Data slot is now a SyncPayload —
// a (byte SchemaId, byte[] Data) pair. SchemaId=0 means "Data bytes are a
// MessagePack-serialized Dictionary<string, object?>" (the legacy form, lossless
// round-trip with both the C# server-internal Dictionary and the JS game
// dict). Phase 4+ will assign nonzero schemaIds to positional, type-tagged
// records for individual game object types. The server treats the bytes as
// opaque; only sync-layer code (ToObjectInfo / inbound decode) ever inspects
// them. See SyncPayloadCodec for encode/decode.
[MessagePackObject]
public record ObjectInfo(
    [property: Key("id")] Guid Id,
    [property: Key("creatorMemberId")] Guid CreatorMemberId,
    [property: Key("ownerMemberId")] Guid OwnerMemberId,
    [property: Key("scope")] ObjectScope Scope,
    [property: Key("data")] SyncPayload Data,
    [property: Key("version")] long Version);

[MessagePackObject]
public record ObjectUpdateInfo(
    [property: Key("id")] Guid Id,
    [property: Key("data")] SyncPayload Data,
    [property: Key("version")] long Version);

[MessagePackObject]
public record ObjectUpdateRequest(
    [property: Key("objectId")] Guid ObjectId,
    [property: Key("data")] SyncPayload Data);

[MessagePackObject]
public record ObjectReplacedEvent(
    [property: Key("deletedObjectId")] Guid DeletedObjectId,
    [property: Key("createdObjects")] List<ObjectInfo> CreatedObjects);

// Operation responses
[MessagePackObject]
public record CreateObjectResponse(
    [property: Key("objectInfo")] ObjectInfo ObjectInfo,
    [property: Key("memberSequence")] long MemberSequence,
    [property: Key("validAt")] long ValidAt);

[MessagePackObject]
public record UpdateObjectsResponse(
    [property: Key("versions")] GuidLongPair[] Versions,
    [property: Key("memberSequence")] long MemberSequence,
    [property: Key("serverTimestamp")] long ServerTimestamp);

[MessagePackObject]
public record DeleteObjectResponse(
    [property: Key("success")] bool Success,
    [property: Key("memberSequence")] long MemberSequence);

/// <summary>
/// Wire-level (Guid, long) pair encoded as a 2-element MessagePack fixarray
/// thanks to positional <c>[Key(int)]</c> attributes. Used in place of
/// <c>Dictionary&lt;string, long&gt;</c> on snapshot/update-response wire shapes
/// where keys are GUIDs:
/// <list type="bullet">
///   <item>Dict-of-string-keyed-GUIDs costs ~37 B per key (full 36-char string).</item>
///   <item>This pair costs ~24 B per entry (fixarray header 1 B + bin8(16) GUID 18 B + small int 5 B).</item>
///   <item>Saves ~13–19 B per entry.</item>
/// </list>
/// JS clients see each pair as a 2-element array <c>[guidString, long]</c> after
/// the existing <c>GuidUtils.transformBinaryGuids</c> walk converts the 16-byte
/// binary GUID to a string. The session-client adapter folds the array back into
/// an object/Map for ergonomic game-side access.
/// </summary>
// Generic per-object event channel. Server is a relay — payload is opaque
// to the server (game-defined dictionary). EventKind is a small byte-id
// agreed between game peers (registered via ObjectSync.registerEventKind).
// Use for low-frequency state transitions that don't belong on the per-frame
// update path (score changes, one-shot impact reports, etc.).
[MessagePackObject]
public record ObjectEventInfo(
    [property: Key("objectId")] Guid ObjectId,
    [property: Key("eventKind")] byte EventKind,
    [property: Key("payload")] Dictionary<string, object?>? Payload);

[MessagePackObject]
public record GuidLongPair(
    [property: Key(0)] Guid Id,
    [property: Key(1)] long Value);

/// <summary>
/// Phase 3 wire envelope for per-object game data. The server is opaque
/// w.r.t. <c>Data</c>; <see cref="SchemaId"/> selects how clients (and the
/// hub-layer encoders/decoders) interpret the bytes:
///
/// <list type="bullet">
///   <item><b>0</b> = legacy form. Bytes are <c>MessagePackSerializer.Serialize&lt;Dictionary&lt;string, object?&gt;&gt;(...)</c>
///         using the standard contractless resolver. Lossless round-trip with
///         the JS msgpack codec at <c>wwwroot/js/msgpack-codec.js</c>.</item>
///   <item><b>1..N</b> = Phase 4+ positional schemas (registered per session
///         in <c>metadata.schemas</c>). Bytes are a packed positional
///         representation; the server still treats them as opaque.</item>
/// </list>
///
/// Wire cost vs the prior shape (raw <c>Dictionary&lt;string, object?&gt;</c>):
/// <list type="bullet">
///   <item>+2 B per object (1 B SchemaId + 1 B bin8 length header on the byte[]).</item>
///   <item>Recouped many times over by Phase 4 typed schemas + Phase 5 quantization.</item>
/// </list>
///
/// Positional <c>[Key(int)]</c> attributes serialize this as a 2-element
/// MessagePack fixarray, the most compact wrapper we can produce
/// (<c>0x92 &lt;schemaId byte&gt; &lt;bin8 ...&gt;</c>).
/// </summary>
[MessagePackObject]
public record SyncPayload(
    [property: Key(0)] byte SchemaId,
    [property: Key(1)] byte[] Data);

