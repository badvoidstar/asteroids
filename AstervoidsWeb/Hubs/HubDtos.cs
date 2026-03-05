using AstervoidsWeb.Services;

namespace AstervoidsWeb.Hubs;

// Session responses
public record CreateSessionResponse(Guid SessionId, string SessionName, Guid MemberId, string Role, double AspectRatio);
public record JoinSessionResponse(
    Guid SessionId,
    string SessionName,
    Guid MemberId,
    string Role,
    IEnumerable<MemberInfo> Members,
    IEnumerable<ObjectInfo> Objects,
    double AspectRatio
);
public record ActiveSessionsResponse(IEnumerable<SessionListItem> Sessions, int MaxSessions, bool CanCreateSession);
public record SessionListItem(Guid Id, string Name, int MemberCount, int MaxMembers, DateTime CreatedAt);
public record SessionStateSnapshot(IEnumerable<MemberInfo> Members, IEnumerable<ObjectInfo> Objects, Dictionary<string, long> MemberSequences);

// Member info
public record MemberInfo(Guid Id, string Role, DateTime JoinedAt);
public record MemberLeftInfo(
    Guid MemberId,
    Guid? PromotedMemberId,
    string? PromotedRole,
    IEnumerable<Guid> DeletedObjectIds,
    IEnumerable<ObjectMigration> MigratedObjects
);

// Object info and operations
public record ObjectInfo(Guid Id, Guid CreatorMemberId, Guid OwnerMemberId, string Scope, Dictionary<string, object?> Data, long Version);
public record ObjectUpdateInfo(Guid Id, Dictionary<string, object?> Data, long Version);
public record ObjectUpdateRequest(Guid ObjectId, Dictionary<string, object?> Data, long? ExpectedVersion = null);
public record ObjectReplacedEvent(Guid DeletedObjectId, List<ObjectInfo> CreatedObjects);

// Operation responses
public record CreateObjectResponse(ObjectInfo ObjectInfo, long MemberSequence);
public record UpdateObjectsResponse(Dictionary<string, long> Versions, long MemberSequence, long ServerTimestamp);
public record DeleteObjectResponse(bool Success, long MemberSequence);
