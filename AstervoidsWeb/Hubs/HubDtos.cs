using AstervoidsWeb.Services;
using MessagePack;

namespace AstervoidsWeb.Hubs;

// Session responses
[MessagePackObject]
public record CreateSessionResponse(
    [property: Key("sessionId")] Guid SessionId,
    [property: Key("sessionName")] string SessionName,
    [property: Key("memberId")] Guid MemberId,
    [property: Key("role")] string Role,
    [property: Key("aspectRatio")] double AspectRatio);

[MessagePackObject]
public record JoinSessionResponse(
    [property: Key("sessionId")] Guid SessionId,
    [property: Key("sessionName")] string SessionName,
    [property: Key("memberId")] Guid MemberId,
    [property: Key("role")] string Role,
    [property: Key("members")] IEnumerable<MemberInfo> Members,
    [property: Key("objects")] IEnumerable<ObjectInfo> Objects,
    [property: Key("aspectRatio")] double AspectRatio
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
    [property: Key("memberSequences")] Dictionary<string, long> MemberSequences);

// Member info
[MessagePackObject]
public record MemberInfo(
    [property: Key("id")] Guid Id,
    [property: Key("role")] string Role,
    [property: Key("joinedAt")] DateTime JoinedAt);

[MessagePackObject]
public record MemberLeftInfo(
    [property: Key("memberId")] Guid MemberId,
    [property: Key("promotedMemberId")] Guid? PromotedMemberId,
    [property: Key("promotedRole")] string? PromotedRole,
    [property: Key("deletedObjectIds")] IEnumerable<Guid> DeletedObjectIds,
    [property: Key("migratedObjects")] IEnumerable<ObjectMigration> MigratedObjects
);

// Object info and operations
[MessagePackObject]
public record ObjectInfo(
    [property: Key("id")] Guid Id,
    [property: Key("creatorMemberId")] Guid CreatorMemberId,
    [property: Key("ownerMemberId")] Guid OwnerMemberId,
    [property: Key("scope")] string Scope,
    [property: Key("data")] Dictionary<string, object?> Data,
    [property: Key("version")] long Version);

[MessagePackObject]
public record ObjectUpdateInfo(
    [property: Key("id")] Guid Id,
    [property: Key("data")] Dictionary<string, object?> Data,
    [property: Key("version")] long Version);

[MessagePackObject]
public record ObjectUpdateRequest(
    [property: Key("objectId")] Guid ObjectId,
    [property: Key("data")] Dictionary<string, object?> Data);

[MessagePackObject]
public record ObjectReplacedEvent(
    [property: Key("deletedObjectId")] Guid DeletedObjectId,
    [property: Key("createdObjects")] List<ObjectInfo> CreatedObjects);

// Operation responses
[MessagePackObject]
public record CreateObjectResponse(
    [property: Key("objectInfo")] ObjectInfo ObjectInfo,
    [property: Key("memberSequence")] long MemberSequence);

[MessagePackObject]
public record UpdateObjectsResponse(
    [property: Key("versions")] Dictionary<string, long> Versions,
    [property: Key("memberSequence")] long MemberSequence,
    [property: Key("serverTimestamp")] long ServerTimestamp);

[MessagePackObject]
public record DeleteObjectResponse(
    [property: Key("success")] bool Success,
    [property: Key("memberSequence")] long MemberSequence);
