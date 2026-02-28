# Astervoids Architecture

## System Overview

```mermaid
graph TB
    subgraph "Browser (HTML5 Canvas)"
        UI["index.html<br/>Single-file frontend<br/>Game loop · Rendering · Input"]
        OS["ObjectSync<br/>object-sync.js"]
        SC["SessionClient<br/>session-client.js"]
        RO["RemoteObjects<br/>Interpolation · BUF · RTT · LAT"]
    end

    subgraph "ASP.NET Core Server"
        HUB["SessionHub<br/>SignalR Hub · /sessionHub"]
        SS["SessionService<br/>Session lifecycle"]
        OBS["ObjectService<br/>Object CRUD · Versioning"]
    end

    UI -->|"tick(dt) each frame"| OS
    OS -->|"updateObjects / createObject / deleteObject"| SC
    SC <-->|"WebSocket (SignalR)"| HUB
    HUB --> SS
    HUB --> OBS
    SC -->|"onBatchReceived · onObjectCreated · onObjectDeleted"| OS
    OS -->|"updateState(id, data, ownerMemberId)"| RO
    RO -->|"getInterpolated(id, renderTime)"| UI
```

---

## Backend Data Model

```mermaid
classDiagram
    class Session {
        +Guid Id
        +string Name (fruit name)
        +double AspectRatio [0.25, 4.0]
        +long Version (incremented on promotion)
        +DateTime CreatedAt
        +ConcurrentDictionary~Guid,Member~ Members
        +ConcurrentDictionary~Guid,SessionObject~ Objects
        -object PromotionLock
    }

    class Member {
        +Guid Id
        +string ConnectionId
        +MemberRole Role (Server|Client)
        +DateTime JoinedAt
        +Guid SessionId
        +long EventSequence (Interlocked)
    }

    class SessionObject {
        +Guid Id
        +Guid SessionId
        +Guid CreatorMemberId (immutable)
        +Guid OwnerMemberId (mutable)
        +ObjectScope Scope (Member|Session)
        +Dictionary~string,object?~ Data
        +long Version
        +DateTime CreatedAt
        +DateTime UpdatedAt
    }

    Session "1" --> "*" Member : Members
    Session "1" --> "*" SessionObject : Objects
    Member "1" --> "*" SessionObject : owns (OwnerMemberId)
```

## Service Layer

```mermaid
graph TB
    subgraph "SessionService"
        direction TB
        SS_DICT["State:<br/>_sessions: ConcurrentDictionary&lt;Guid, Session&gt;<br/>_connectionToMember: ConcurrentDictionary&lt;string, Guid&gt;<br/>_memberToSession: ConcurrentDictionary&lt;Guid, Guid&gt;"]
        SS_CFG["Config:<br/>MaxSessions: 6<br/>MaxMembersPerSession: 4<br/>50 fruit names pool"]
    end

    subgraph "ObjectService"
        direction TB
        OS_OPS["Operations:<br/>CreateObject → Id, Version=0, Owner<br/>UpdateObject → Version check, merge, Version++<br/>UpdateObjects → Batch (skip failures, partial success)<br/>DeleteObject → TryRemove (no ownership check)<br/>HandleMemberDeparture → Delete/Migrate"]
        OS_CFG["Config:<br/>DistributeOrphanedObjects: true<br/>(round-robin vs first-member)"]
    end
```

## SessionService: Lookup Chain

```mermaid
flowchart LR
    CID["ConnectionId<br/>(string)"]
    MID["MemberId<br/>(Guid)"]
    SID["SessionId<br/>(Guid)"]
    S["Session"]
    M["Member"]

    CID -->|"_connectionToMember"| MID
    MID -->|"_memberToSession"| SID
    SID -->|"_sessions"| S
    S -->|"Members[MemberId]"| M
```

## SessionService: Create & Join

```mermaid
flowchart TB
    subgraph "CreateSession(aspectRatio)"
        CS1{"Connection already<br/>in a session?"}
        CS2{"Active sessions<br/>>= maxSessions (6)?"}
        CS3["Clamp aspectRatio to [0.25, 4.0]"]
        CS4["Pick fruit name:<br/>Random unused from 50-item pool<br/>If all used → append counter (Apple2)"]
        CS5["Create Session with Name, AspectRatio"]
        CS6["Create Member with Role=Server"]
        CS7["Add to _sessions, _connectionToMember,<br/>_memberToSession, session.Members"]
        CS8["Return CreateSessionResult<br/>{Success, Session, Creator}"]
        CSE["Return error"]

        CS1 -->|Yes| CSE
        CS1 -->|No| CS2
        CS2 -->|Yes| CSE
        CS2 -->|No| CS3 --> CS4 --> CS5 --> CS6 --> CS7 --> CS8
    end

    subgraph "JoinSession(sessionId)"
        JS1{"Connection already<br/>in a session?"}
        JS2{"Session exists?"}
        JS3{"Members.Count<br/>>= maxMembers (4)?"}
        JS4["Create Member with Role=Client"]
        JS5["Add to all dictionaries"]
        JS6["Return JoinSessionResult<br/>{Success, Session, Member}"]
        JSE["Return error"]

        JS1 -->|Yes| JSE
        JS1 -->|No| JS2
        JS2 -->|No| JSE
        JS2 -->|Yes| JS3
        JS3 -->|Yes| JSE
        JS3 -->|No| JS4 --> JS5 --> JS6
    end
```

## SessionService: Leave & Server Promotion

```mermaid
flowchart TB
    L1["LeaveSession(connectionId)"]
    L2["TryRemove from _connectionToMember<br/>TryRemove from _memberToSession<br/>TryRemove from session.Members"]
    L3{"Leaving member<br/>was Server?"}
    L4{"Any members<br/>remaining?"}
    L5["lock(session.PromotionLock)"]
    L6{"Double-check:<br/>still no Server?"}
    L7["Select random Client"]
    L8["Set Role = Server<br/>session.Version++"]
    L9{"session.Members<br/>empty?"}
    L10["Destroy session:<br/>TryRemove from _sessions"]
    L11["Return LeaveSessionResult<br/>{SessionId, MemberId,<br/>SessionDestroyed, PromotedMember?}"]

    L1 --> L2 --> L3
    L3 -->|No| L9
    L3 -->|Yes| L4
    L4 -->|No| L9
    L4 -->|Yes| L5 --> L6
    L6 -->|"No — race: already promoted"| L9
    L6 -->|Yes| L7 --> L8 --> L9
    L9 -->|Yes| L10 --> L11
    L9 -->|No| L11
```

## ObjectService: Optimistic Concurrency

```mermaid
flowchart TB
    subgraph "UpdateObject (single)"
        U1["UpdateObject(sessionId, objectId,<br/>data, expectedVersion)"]
        U2{"Session exists?<br/>Object exists?"}
        U3{"expectedVersion provided<br/>AND obj.Version ≠ expected?"}
        U4["Merge data into obj.Data<br/>obj.Version++<br/>obj.UpdatedAt = now"]
        U5["Return updated SessionObject"]
        UF["Return null (failure)"]

        U1 --> U2
        U2 -->|No| UF
        U2 -->|Yes| U3
        U3 -->|Mismatch| UF
        U3 -->|Match or none| U4 --> U5
    end

    subgraph "UpdateObjects (batch)"
        B1["For each update in batch:"]
        B2{"Object exists AND<br/>version matches?"}
        B3["Merge, Version++"]
        B4["Skip (continue)"]
        B5["Return list of ONLY<br/>successfully updated objects<br/>(partial success allowed)"]

        B1 --> B2
        B2 -->|Yes| B3 --> B5
        B2 -->|No| B4 --> B5
    end
```

## ObjectService: Member Departure & Ownership Redistribution

```mermaid
flowchart TB
    HD["HandleMemberDeparture<br/>(sessionId, departingMemberId,<br/>remainingMemberIds[])"]
    ITER["Iterate all session objects<br/>where OwnerMemberId == departingMemberId"]

    subgraph "Per Object Decision"
        CHK{"Object Scope?"}

        subgraph "Member-Scoped (Ship, Bullet)"
            DEL["TryRemove from session.Objects<br/>Add Id to deletedIds<br/>Track type in affectedTypes"]
        end

        subgraph "Session-Scoped (Asteroid, GameState)"
            REM{"remainingMembers > 0?"}
            DIST{"distributeOrphanedObjects<br/>AND members > 1?"}
            RR["Round-robin:<br/>newOwner = remaining[index % count]<br/>index++"]
            FIRST["First member:<br/>newOwner = remaining[0]"]
            ASSIGN["obj.OwnerMemberId = newOwner<br/>obj.Version++<br/>obj.UpdatedAt = now<br/>Add ObjectMigration(id, newOwner)"]
            ORPHAN["Object remains but<br/>has no owner"]
        end
    end

    RES["Return MemberDepartureResult<br/>{deletedIds[], migratedObjects[],<br/>affectedTypes[]}"]

    HD --> ITER --> CHK
    CHK -->|Member| DEL
    CHK -->|Session| REM
    REM -->|No| ORPHAN
    REM -->|Yes| DIST
    DIST -->|Yes| RR --> ASSIGN
    DIST -->|No| FIRST --> ASSIGN
    DEL --> RES
    ASSIGN --> RES
```

### Round-Robin Example (3 players, Player B leaves)

```mermaid
flowchart LR
    subgraph "Before Departure"
        B_A1["🪨 Asteroid 1<br/>Owner: B"]
        B_A2["🪨 Asteroid 2<br/>Owner: B"]
        B_A3["🪨 Asteroid 3<br/>Owner: B"]
        B_GS["📊 GameState<br/>Owner: B"]
        B_S["🚀 B's Ship<br/>Owner: B (Member-scoped)"]
    end

    subgraph "After Departure (remaining: [A, C])"
        A_A1["🪨 Asteroid 1<br/>Owner: A (index 0 % 2)"]
        A_A2["🪨 Asteroid 2<br/>Owner: C (index 1 % 2)"]
        A_A3["🪨 Asteroid 3<br/>Owner: A (index 2 % 2)"]
        A_GS["📊 GameState<br/>Owner: C (index 3 % 2)"]
        A_S["🚀 B's Ship<br/>DELETED"]
    end

    B_A1 -.->|migrated| A_A1
    B_A2 -.->|migrated| A_A2
    B_A3 -.->|migrated| A_A3
    B_GS -.->|migrated| A_GS
    B_S -.->|deleted| A_S
```

## SessionHub: Method Signatures & Broadcast Patterns

```mermaid
flowchart TB
    subgraph "Hub Methods → Broadcast Targets"
        direction TB
        CREATE["CreateSession(aspectRatio)<br/>→ Add to AllClients + SessionGroup<br/>→ Broadcast: OnSessionsChanged to AllClients"]
        JOIN["JoinSession(sessionId)<br/>→ Add to SessionGroup<br/>→ Broadcast: OnMemberJoined to OthersInGroup<br/>→ Response: memberId, objects[], members[]"]
        LEAVE["LeaveSession()<br/>→ Remove from SessionGroup<br/>→ Broadcast: OnMemberLeft to Group (all remaining)<br/>→ Broadcast: OnSessionsChanged to AllClients"]
        CO["CreateObject(data, scope, ownerMemberId?)<br/>→ Broadcast: OnObjectCreated to OthersInGroup<br/>→ Response: objectInfo + memberSequence"]
        UO["UpdateObjects(updates[], senderSeq,<br/>clientTimestamp, senderSendIntervalMs)<br/>→ Ownership filter: only owned objects processed<br/>→ Broadcast: OnObjectsUpdated to OthersInGroup<br/>→ Response: versions{} + memberSequence + serverTimestamp"]
        DO["DeleteObject(objectId)<br/>→ Broadcast: OnObjectDeleted to OthersInGroup<br/>→ Response: success + memberSequence"]
        RO["ReplaceObject(deleteId, replacements[],<br/>scope, ownerMemberId?)<br/>→ Broadcast: OnObjectReplaced to Group (ALL)<br/>→ Response: createdInfos[]"]
        GS["GetSessionState()<br/>→ No broadcast (read-only)<br/>→ Response: full snapshot"]
    end
```

## SessionHub: UpdateObjects Detail

```mermaid
sequenceDiagram
    participant C as Caller
    participant HUB as SessionHub
    participant OS as ObjectService
    participant OTH as Other Members

    C->>HUB: UpdateObjects(updates[], senderSeq,<br/>clientTimestamp, senderSendIntervalMs)
    HUB->>HUB: GetMemberByConnectionId(connectionId)
    HUB->>HUB: Filter updates: only objects where<br/>obj.OwnerMemberId == caller.Id
    HUB->>OS: UpdateObjects(sessionId, authorizedUpdates)
    OS-->>HUB: List of successfully updated objects<br/>(partial success — failed versions skipped)
    HUB->>HUB: memberSequence = Interlocked.Increment(member.EventSequence)
    HUB->>HUB: serverTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()

    par Broadcast to others
        HUB->>OTH: OnObjectsUpdated(<br/>  updateInfos[{Id, Data, Version}],<br/>  member.Id,<br/>  senderSequence,<br/>  memberSequence,<br/>  serverTimestamp,<br/>  clientTimestamp,<br/>  senderSendIntervalMs)
    and Response to caller
        HUB-->>C: UpdateObjectsResponse(<br/>  versions: {objectId → version},<br/>  memberSequence,<br/>  serverTimestamp)
    end

    Note over C: clientTimestamp echoed back in broadcast<br/>→ null for others (RTT discriminator)<br/>→ original value in response
```

## SessionHub: Leave & Disconnect Flow

```mermaid
sequenceDiagram
    participant C as Leaving Member
    participant HUB as SessionHub
    participant SS as SessionService
    participant OS as ObjectService
    participant REM as Remaining Members
    participant ALL as AllClients

    C->>HUB: LeaveSession() or OnDisconnectedAsync()
    HUB->>SS: LeaveSession(connectionId)
    Note over SS: Remove from 3 dictionaries<br/>Promote random Client if Server left<br/>Destroy session if empty
    SS-->>HUB: LeaveSessionResult {sessionId, memberId,<br/>sessionDestroyed, promotedMember?}

    HUB->>HUB: Gather remainingMemberIds from session
    HUB->>OS: HandleMemberDeparture(sessionId,<br/>departingMemberId, remainingMemberIds)
    Note over OS: Delete Member-scoped objects<br/>Round-robin migrate Session-scoped objects
    OS-->>HUB: MemberDepartureResult {deletedIds[],<br/>migratedObjects[], affectedTypes[]}

    HUB->>HUB: RemoveFromGroupAsync(sessionGroup)

    HUB->>REM: OnMemberLeft(MemberLeftInfo {<br/>  memberId,<br/>  promotedMemberId?,<br/>  promotedRole?,<br/>  deletedObjectIds[],<br/>  migratedObjects[{objectId, newOwnerId}]<br/>})
    HUB->>ALL: OnSessionsChanged
```

## SignalR Group Management

```mermaid
flowchart TB
    subgraph "Groups"
        AC["AllClients<br/>(all connected browsers)"]
        SG["SessionGroup<br/>(session.Id.ToString())<br/>per-session"]
    end

    subgraph "Lifecycle"
        CONN["OnConnectedAsync()"] -->|"AddToGroupAsync"| AC
        CRS["CreateSession()"] -->|"AddToGroupAsync"| SG
        JN["JoinSession()"] -->|"AddToGroupAsync"| SG
        LV["LeaveSession()"] -->|"RemoveFromGroupAsync"| SG
        DC["OnDisconnectedAsync()"] -->|"calls LeaveSession()"| LV
    end

    subgraph "Broadcast Targets"
        ALL_BC["OnSessionsChanged<br/>→ AllClients"]
        OTHERS["OnObjectCreated/Updated/Deleted<br/>→ OthersInGroup (sender excluded)"]
        GROUP["OnMemberLeft, OnObjectReplaced<br/>→ Group (ALL in session)"]
    end
```

## SessionHub: ReplaceObject (Atomic Delete + Create)

```mermaid
sequenceDiagram
    participant C as Caller (asteroid owner)
    participant HUB as SessionHub
    participant OS as ObjectService
    participant ALL as All Session Members

    Note over C: Asteroid split — need atomic delete + create children
    C->>HUB: ReplaceObject(deleteId, [{child1Data}, {child2Data}],<br/>scope="Session", ownerMemberId=null)

    HUB->>OS: DeleteObject(sessionId, deleteId)
    Note over OS: TryRemove (no ownership check)

    loop For each replacement
        HUB->>OS: CreateObject(sessionId, memberId,<br/>scope, data, ownerMemberId)
        Note over OS: New Id, Version=0, Owner=caller
    end

    HUB->>HUB: memberSequence = Interlocked.Increment

    HUB->>ALL: OnObjectReplaced({<br/>  deletedObjectId,<br/>  createdObjects[{Id, Owner, Scope, Data, Version}]<br/>}, memberId, memberSequence, serverTimestamp)

    Note over ALL: Broadcast to ALL (not OthersInGroup)<br/>because caller also needs to sync<br/>new server-assigned Ids for children

    HUB-->>C: Response: createdInfos[]
```

## Session & Member Model

```mermaid
stateDiagram-v2
    [*] --> Lobby: Page load
    Lobby --> Creating: CreateSession(aspectRatio)
    Lobby --> Joining: JoinSession(sessionId)
    Creating --> InSession: Response (memberId, sessionId, role=Server)
    Joining --> InSession: Response (memberId, sessionId, role=Client, objects[], members[])
    InSession --> Lobby: LeaveSession()
    InSession --> InSession: Server leaves → oldest Client promoted

    state InSession {
        [*] --> Playing
        Playing --> Playing: Game loop
    }
```

```mermaid
graph LR
    subgraph "Session (max 6 concurrent)"
        direction TB
        S["Session<br/>Id: Guid<br/>Name: fruit name (Apple, Banana...)<br/>AspectRatio: double<br/>Version: long<br/>Max members: 4"]
        M1["Member (Server)<br/>Id: Guid<br/>Role: Server<br/>ConnectionId: string<br/>EventSequence: long<br/>JoinedAt: DateTime"]
        M2["Member (Client)<br/>Id: Guid<br/>Role: Client<br/>ConnectionId: string<br/>EventSequence: long<br/>JoinedAt: DateTime"]
        M3["Member (Client)<br/>...up to 4 total"]
        S --- M1
        S --- M2
        S --- M3
    end
```

## Object Model & Ownership

```mermaid
graph TB
    subgraph "Object Scopes"
        direction TB
        MS["Member-Scoped<br/>Deleted when owner leaves"]
        SS["Session-Scoped<br/>Ownership migrates on departure<br/>Round-robin to remaining members"]
    end

    subgraph "Object Types"
        SHIP["🚀 Ship<br/>Scope: Member<br/>Owner: creating player<br/>One per member"]
        BULLET["• Bullet<br/>Scope: Member<br/>Owner: firing player<br/>Lifetime: 60 frames"]
        AST["🪨 Asteroid<br/>Scope: Session<br/>Owner: creator (migrates)<br/>Splitting via ReplaceObject"]
        GS["📊 GameState<br/>Scope: Session<br/>Owner: authority player<br/>Score, lives, hitCounts"]
    end

    SHIP --> MS
    BULLET --> MS
    AST --> SS
    GS --> SS
```

```mermaid
graph TB
    subgraph "SessionObject"
        OBJ["Id: Guid<br/>Type: string<br/>Scope: Member | Session<br/>CreatorMemberId: Guid (immutable)<br/>OwnerMemberId: Guid (mutable)<br/>Version: long (optimistic concurrency)<br/>Data: Dictionary&lt;string, object?&gt;"]
    end

    subgraph "Member Departure"
        LEAVE["Member leaves"]
        DEL["Delete all Member-scoped<br/>objects owned by departing member<br/>(ships, bullets)"]
        MIG["Migrate all Session-scoped<br/>objects to remaining members<br/>(asteroids, gamestate)<br/>Version incremented"]
        BC["Broadcast OnMemberLeft<br/>{memberId, deletedObjects[],<br/>migratedObjects[],<br/>promotedMemberId?}"]
    end

    LEAVE --> DEL
    LEAVE --> MIG
    DEL --> BC
    MIG --> BC
```

## Async Send/Receive & Sequencing

```mermaid
sequenceDiagram
    participant GL as Game Loop (60fps)
    participant OS as ObjectSync
    participant SC as SessionClient
    participant HUB as SessionHub
    participant R as Remote Client

    Note over GL,OS: Tick/Flush cycle (send rate ≠ frame rate)
    loop Every frame
        GL->>OS: tick(frameTimeSec)
        OS->>OS: frameCounter++
        Note over OS: sendThreshold = round(nominalFrameTime / frameTime)<br/>e.g. 50ms / 16.7ms ≈ 3 frames
    end

    Note over OS: frameCounter >= sendThreshold → flush
    OS->>OS: Compute deltas (only changed fields)
    OS->>OS: Check inFlightCount > 0? → skip (backpressure)
    OS->>OS: inFlightCount++, senderSequence++
    OS->>SC: updateObjects(updates, senderSeq, senderSendIntervalMs)
    SC->>HUB: Invoke UpdateObjects(updates, senderSeq, clientTimestamp, senderSendIntervalMs)

    Note over HUB: Server processes batch atomically<br/>Version check per object<br/>memberSequence = Interlocked.Increment

    par Response to sender
        HUB-->>SC: Response {versions{}, memberSequence, serverTimestamp}
        SC-->>OS: Apply versions, track own memberSequence
        OS-->>OS: inFlightCount--
        Note over OS: RTT = Date.now() - clientTimestamp
    and Broadcast to others
        HUB->>R: OnObjectsUpdated(objects[], senderMemberId,<br/>senderSeq, memberSeq, serverTimestamp,<br/>null, senderSendIntervalMs)
        Note over R: clientTimestamp = null (discriminator:<br/>null = remote broadcast,<br/>set = own invoke response)
    end
```

## Sequence Gap Detection & Reconciliation

```mermaid
flowchart TB
    RX["Receive event from member X<br/>with memberSequence N"]
    CHK{"lastSeq[X] exists<br/>AND N > lastSeq[X] + 1?"}
    OK["Update lastSeq[X] = N<br/>Process event normally"]
    GAP["Sequence gap detected!<br/>Expected lastSeq+1, got N"]
    RECON["triggerReconciliation()"]
    FETCH["GetSessionState() from server"]
    SYNC["Sync local objects:<br/>• Add missing<br/>• Update stale versions<br/>• Remove ghosts<br/>Reset memberSequences from snapshot"]

    RX --> CHK
    CHK -->|No gap| OK
    CHK -->|Gap detected| GAP
    GAP --> RECON
    RECON --> FETCH
    FETCH --> SYNC

    NOTE["Note: own-member gaps NOT checked<br/>(response/broadcast channels can race)"]
```

## Networking: RTT → TX → BUF Pipeline

```mermaid
flowchart LR
    subgraph "RTT Estimation"
        SAMPLE["RTT sample =<br/>Date.now() - clientTimestamp"]
        EMA["Asymmetric EMA:<br/>spike: α=0.6 (fast up)<br/>decay: α=0.1 (slow down)<br/>rtt += α × (sample - rtt)"]
        SAMPLE --> EMA
    end

    subgraph "TX (Send Rate)"
        FORMULA["nominalFrameTime =<br/>clamp(rtt/1000,<br/>1/20, 1/1)"]
        TABLE["RTT 4ms → TX 50ms (20Hz)<br/>RTT 100ms → TX 100ms (10Hz)<br/>RTT 500ms → TX 500ms (2Hz)<br/>RTT 1500ms → TX 1000ms (1Hz)"]
        FORMULA --- TABLE
    end

    subgraph "Backpressure"
        BP["inFlightCount > 0?<br/>→ skip this flush<br/>(instant congestion signal)"]
    end

    EMA --> FORMULA
    EMA --> BP
```

```mermaid
flowchart TB
    subgraph "Per-Member BUF Calculation"
        direction TB
        PKT["Packet arrives from member X<br/>(remote broadcast only: clientTimestamp=null)"]
        MEM["getMemberDelay(senderMemberId)<br/>Independent state per member"]
        INT["interval = serverTimestamp - lastServerTimestamp"]
        OUT{"interval > 2 × remoteSendInterval?"}
        SKIP["Outlier: skip interval<br/>(idle gap / delta suppression)"]
        REC["Record interval in packetIntervals[]<br/>(sliding window, 30 samples)"]

        PKT --> MEM
        MEM --> INT
        INT --> OUT
        OUT -->|Yes| SKIP
        OUT -->|No| REC
    end

    subgraph "BUF Formula"
        direction TB
        CALC["observedMean = mean(packetIntervals)<br/>σ = stddev(packetIntervals)<br/>mean = remoteSendInterval ∥ observedMean<br/><br/>networkFactor = min(1.0,<br/>  0.25 + RTT / (2 × mean))<br/><br/>rawDelay = max(16.67ms,<br/>  mean × networkFactor + 2σ)<br/><br/>computedDelay += 0.1 × (rawDelay - computedDelay)"]
    end

    subgraph "Example (localhost)"
        EX["RTT=4ms, TX=50ms, σ=1.7ms<br/>nf = 0.25 + 4/(2×50) = 0.29<br/>raw = 50×0.29 + 2×1.7 = 17.9ms<br/>BUF converges to ~18ms"]
    end

    REC --> CALC
    CALC --> EX
```

## Ring Buffer Interpolation

```mermaid
flowchart TB
    subgraph "Per-Object Ring Buffer (max 6 snapshots)"
        S1["snapshot[0]<br/>data, time, velocity, rotationSpeed"]
        S2["snapshot[1]"]
        S3["snapshot[2]"]
        S4["snapshot[3]"]
        S5["..."]
        S6["snapshot[5]<br/>(newest)"]
        S1 --- S2 --- S3 --- S4 --- S5 --- S6
    end

    TARGET["targetTime = renderTime - getDelayForMember(ownerMemberId)"]

    subgraph "Bracket Search (reverse scan)"
        direction TB
        BEFORE{"targetTime ≤ oldest?"}
        CLAMP["Return oldest snapshot (clamped)"]
        BRACKET{"Find i where<br/>snap[i].time ≤ targetTime < snap[i+1].time"}
        HERMITE["Build pseudo-state from snap[i] & snap[i+1]<br/>Hermite interpolate with t ∈ (0,1]"]
        AFTER{"targetTime ≥ newest?"}
        EXTRAP["Extrapolate with velocity<br/>capped at MAX_EXTRAPOLATION (1.0s)"]
    end

    TARGET --> BEFORE
    BEFORE -->|Yes| CLAMP
    BEFORE -->|No| AFTER
    AFTER -->|Yes| EXTRAP
    AFTER -->|No| BRACKET
    BRACKET --> HERMITE
```

```mermaid
flowchart LR
    subgraph "Hermite Interpolation"
        BASIS["Basis functions:<br/>h00 = 2t³ - 3t² + 1<br/>h10 = t³ - 2t² + t<br/>h01 = -2t³ + 3t²<br/>h11 = t³ - t²"]
        POS["Position (x,y):<br/>p = h00·p₀ + h10·m₀ + h01·p₁ + h11·m₁<br/><br/>Tangents m = velocity × velScale × dt<br/>velScale = refDim / gameWidth<br/>Wrap-aware Δ for p₁ - p₀"]
        ANG["Angle:<br/>Same Hermite with rotationSpeed tangents<br/>rpsToPerSec = TARGET_FPS (60)<br/>Shortest-arc via ±π wrapping"]
        SNAP{"‖p₁ - p₀‖ > SNAP_THRESHOLD (0.25)?"}
        SNAPR["Skip interpolation → snap to p₁"]

        BASIS --> POS
        BASIS --> ANG
        POS --> SNAP
        SNAP -->|Yes| SNAPR
    end
```

## Cross-Owner Collision

```mermaid
sequenceDiagram
    participant A as Player A (bullet owner)
    participant SRV as Server
    participant B as Player B (asteroid owner)

    Note over A: A's bullet hits B's asteroid locally
    A->>A: Mark bullet pendingHit=true, hitTargetId=asteroidId
    A->>SRV: UpdateObjects(bullet with pendingHit)
    SRV->>B: OnObjectsUpdated (bullet data with pendingHit)

    Note over B: B scans remote bullets for pendingHit on own asteroids
    B->>B: Process split: create child asteroids
    B->>SRV: ReplaceObject(asteroidId, [child1, child2])
    SRV->>A: OnObjectReplaced (broadcast to ALL)
    SRV->>B: OnObjectReplaced (broadcast to ALL)

    Note over A: A sees asteroid replaced → confirms hit, awards points
```
