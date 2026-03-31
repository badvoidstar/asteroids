# Astervoids Architecture

## System Overview

```mermaid
graph TB
    subgraph "Browser (HTML5 Canvas)"
        UI["index.html<br/>Single-file frontend<br/>Game loop · Rendering · Input"]
        OS["ObjectSync<br/>object-sync.js"]
        SC["SessionClient<br/>session-client.js"]
        RO["RemoteObjects<br/>Interpolation · BUF · RTT · JIT"]
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
        +DateTime? LastMemberLeftAt
        +SessionLifecycleState LifecycleState
        +ConcurrentDictionary~Guid,Member~ Members
        +ConcurrentDictionary~Guid,SessionObject~ Objects
        -object SyncRoot
    }

    class SessionLifecycleState {
        <<enumeration>>
        Active
        Destroying
        Destroyed
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
    Session --> SessionLifecycleState : LifecycleState
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
        OS_OPS["Operations:<br/>CreateObject → Id, Version=1, Owner<br/>UpdateObject → Version check, merge, Version++<br/>UpdateObjects → Batch (skip failures, partial success)<br/>DeleteObject → TryRemove (no ownership check)<br/>HandleMemberDeparture → Delete/Migrate"]
        OS_CFG["Config:<br/>DistributeOrphanedObjects: true<br/>(round-robin vs first-member)"]
    end

    subgraph "SessionCleanupService (BackgroundService)"
        direction TB
        SCS_OPS["Runs every 10 seconds<br/>Empty timeout: destroy sessions with no members for N seconds<br/>Absolute timeout: destroy sessions exceeding max lifetime<br/>Notifies connected members via SignalR OnSessionExpired<br/>Broadcasts OnSessionsChanged on any cleanup"]
        SCS_CFG["Config (SessionSettings):<br/>EmptyTimeoutSeconds: 60<br/>AbsoluteTimeoutMinutes: 20"]
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
    L11["Return LeaveSessionResult<br/>{SessionId, SessionName, MemberId,<br/>SessionDestroyed, PromotedMember?}"]

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

## ObjectService: Update Flow

```mermaid
flowchart TB
    subgraph "UpdateObject (single, no ownership check)"
        U1["UpdateObject(sessionId, objectId, data)"]
        U2{"Session exists?<br/>Object exists?"}
        U4["Merge data into obj.Data<br/>obj.Version++<br/>obj.UpdatedAt = now"]
        U5["Return updated SessionObject"]
        UF["Return null (failure)"]

        U1 --> U2
        U2 -->|No| UF
        U2 -->|Yes| U4 --> U5
    end

    subgraph "UpdateObjects (batch, ownership enforced)"
        B1["For each update in batch:"]
        B2{"Object exists AND<br/>owned by caller?"}
        B3["Merge, Version++"]
        B4["Skip (continue)"]
        B5["Return list of ONLY<br/>successfully updated objects"]

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

    RES["Return MemberDepartureResult<br/>{deletedIds[], migratedObjects[]}"]

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
    InSession --> InSession: Server leaves → random Client promoted

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
        OBJ["Id: Guid<br/>Type: string<br/>Scope: Member | Session<br/>CreatorMemberId: Guid (immutable)<br/>OwnerMemberId: Guid (mutable)<br/>Version: long (change counter)<br/>Data: Dictionary&lt;string, object?&gt;"]
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
        EMA["Asymmetric EMA:<br/>spike: α=0.3 (fast up)<br/>decay: α=0.1 (slow down)<br/>rtt += α × (sample - rtt)"]
        SAMPLE --> EMA
    end

    subgraph "TX (Send Rate)"
        FORMULA["nominalFrameTime =<br/>clamp(rtt/1000,<br/>1/20, 1/1)"]
        TABLE["RTT 4ms → TX 50ms (20Hz)<br/>RTT 100ms → TX 100ms (10Hz)<br/>RTT 500ms → TX 500ms (2Hz)<br/>RTT 1500ms → TX 1000ms (1Hz)"]
        FORMULA --- TABLE
    end

    subgraph "Backpressure"
        BP["flushInProgress?<br/>→ cap frame counter at threshold<br/>→ flush on next tick after completion<br/>(instant congestion signal)"]
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

## Response-First vs Local-First Patterns

```mermaid
flowchart TB
    subgraph "CreateObject (Response-First)"
        direction TB
        C1["Caller invokes CreateObject"]
        C2["Wait for server response<br/>(server assigns Id, Version=1)"]
        C3["Register object in local Map<br/>from response"]
        C4["Broadcast: OthersInGroup<br/>(sender excluded)"]
        C5["If isStillNeeded callback returns false:<br/>auto-delete server object"]
        C1 --> C2 --> C3
        C2 --> C4
        C3 --> C5
    end

    subgraph "DeleteObject (Local-First)"
        direction TB
        D1["Remove from local Map immediately<br/>(before server call)"]
        D2["Remove from pendingUpdates"]
        D3["Invoke server DeleteObject"]
        D4["Server verifies ownership<br/>(rejects if not owner)"]
        D5["Broadcast: OthersInGroup<br/>(sender excluded)"]
        D1 --> D2 --> D3 --> D4 --> D5
    end

    subgraph "ReplaceObject (Broadcast-Dependent)"
        direction TB
        R1["Invoke server ReplaceObject"]
        R2["Server creates children,<br/>deletes parent"]
        R3["Broadcast: Group (ALL)<br/>sender included"]
        R4["Sender updates local Map<br/>from broadcast echo"]
        R1 --> R2 --> R3 --> R4
    end
```

## Delta Encoding & Deferred Confirmation

```mermaid
sequenceDiagram
    participant OS as ObjectSync
    participant SC as SessionClient
    participant SRV as Server

    Note over OS: computeDelta(): compare current data vs lastSentData<br/>Uses shallow reference comparison (===)<br/>Nested objects must be spread into new refs

    OS->>OS: delta = computeDelta(objectId, data)<br/>lastSentData NOT updated yet

    OS->>SC: updateObjects(deltas, senderSeq, sendIntervalMs)
    SC->>SRV: Invoke UpdateObjects(deltas, ...)

    alt Server accepts batch
        SRV-->>SC: Response {versions: {id→ver}, ...}
        SC-->>OS: confirmSentDeltas(sentDeltas, versions)
        OS->>OS: Update lastSentData only for<br/>confirmed objects
    else Network error / null response
        Note over OS: sentDeltas NOT confirmed<br/>→ all changed fields re-sent next flush
    end

    Note over OS: Full sync forced every 6000 frames<br/>(FULL_SYNC_INTERVAL) — bypasses delta,<br/>sends complete object state

    Note over OS: Field name compression (FIELD_MAP) is applied<br/>after delta computation — wire payloads use short<br/>keys (e.g. velocityX→vx) while game logic uses<br/>readable names. expandData() reverses on receive.
```

## Type Index (ObjectSync)

```mermaid
flowchart TB
    subgraph "Type Index (Map<string, Set<objectId>>)"
        direction TB
        IDX["typeIndex: Map<br/>e.g. 'ship' → {id1, id2}<br/>'asteroid' → {id3, id4, id5}<br/>'gameState' → {id6}"]
    end

    subgraph "Index Maintenance"
        ADD["addToTypeIndex(obj)<br/>On: createObject, handleRemoteObjectCreated"]
        REM["removeFromTypeIndex(obj)<br/>On: deleteObject, handleRemoteObjectDeleted"]
        UPD["updateTypeIndex(obj, oldType, newType)<br/>On: updateObject, handleRemoteObjectsUpdated<br/>(only when data.type changes)"]
    end

    subgraph "Efficient Queries"
        QT["getObjectsByType(type) → O(n) for n = matching<br/>vs O(N) scanning all objects"]
        QS["getObjectByType(type) → O(1) singleton lookup<br/>e.g. GameState"]
    end

    ADD --> IDX
    REM --> IDX
    UPD --> IDX
    IDX --> QT
    IDX --> QS
```

## SignalR Reconnection & Reconciliation

```mermaid
sequenceDiagram
    participant C as Client
    participant SR as SignalR
    participant HUB as SessionHub

    Note over C,SR: Connection lost (network interruption)

    SR->>SR: withAutomaticReconnect<br/>Exponential backoff: 1s, 2s, 4s, 8s, 16s<br/>Max 5 attempts, cap at 30s

    SR->>C: onreconnecting(error)

    alt Reconnection succeeds
        SR->>C: onreconnected(connectionId)
        C->>C: ObjectSync.triggerReconciliation()
        C->>HUB: GetSessionState()
        HUB-->>C: Full snapshot + memberSequences
        C->>C: Sync local objects:<br/>• Add missing<br/>• Update stale<br/>• Remove ghosts<br/>• Reset sequences
    else Max retries exceeded (or mobile auto-rejoin)
        SR->>C: onclose(error)
        C->>C: attemptAutoRejoin(sessionId)
        C->>C: connect() stops old connection,<br/>creates new one
        C->>HUB: JoinSession(sessionId)
        HUB-->>C: Rejoin response (new memberId, objects)
    end

    Note over C: Stale connection guard: setupEventHandlers()<br/>captures thisConnection reference.<br/>Old connection's onclose/on* events<br/>are silently ignored if connection<br/>has been replaced by connect().
```

## SessionService: Thread Safety

```mermaid
flowchart TB
    subgraph "Serialization Strategy"
        direction TB
        LOCK["_sessionLock (object)<br/>Serializes CreateSession & JoinSession<br/>Prevents TOCTOU races on:<br/>• connection-already-in-session check<br/>• max sessions count check<br/>• concurrent join + full check"]
        PROMO["session.PromotionLock (object)<br/>Per-session lock for server promotion<br/>Double-check pattern: verify no server<br/>exists before promoting"]
        CONC["ConcurrentDictionary (4 instances)<br/>_sessions, _connectionToMember,<br/>_memberToSession, session.Members<br/>Thread-safe individual operations"]
    end

    subgraph "Why _sessionLock is needed"
        direction TB
        RACE["Without _sessionLock, concurrent CreateSession calls<br/>could both pass the maxSessions check<br/>before either adds to _sessions"]
    end

    LOCK --> CONC
    PROMO --> CONC
```

## Hub: Ownership Enforcement

```mermaid
flowchart TB
    subgraph "ObjectService (no ownership check)"
        OS_DEL["DeleteObject: TryRemove by id<br/>(trusts caller)"]
        OS_UPD["UpdateObject: version check only<br/>(trusts caller)"]
    end

    subgraph "SessionHub (enforces ownership)"
        HUB_UPD["UpdateObjects:<br/>Filter to obj.OwnerMemberId == caller.Id<br/>Only authorized updates reach ObjectService"]
        HUB_DEL["DeleteObject:<br/>Verify obj.OwnerMemberId == caller.Id<br/>Reject with warning if not owner"]
        HUB_REP["ReplaceObject:<br/>Verify obj.OwnerMemberId == caller.Id<br/>Reject + rollback if not owner"]
    end

    HUB_UPD --> OS_UPD
    HUB_DEL --> OS_DEL
    HUB_REP --> OS_DEL
```

## Project Structure

```
astervoids/
├── ARCHITECTURE.md              # This document
├── README.md                    # Project overview and setup
├── CICD_SETUP.md               # CI/CD pipeline documentation
├── DEV_NOTES.md                # Developer notes
├── astervoids.sln              # .NET solution file
├── azure.yaml                  # Azure Developer CLI config
├── index.html                  # Root redirect page
│
├── AstervoidsWeb/              # Main web application
│   ├── AstervoidsWeb.csproj    # .NET 10.0 Web SDK project
│   ├── Program.cs              # App startup, DI, middleware, SignalR mapping
│   ├── Dockerfile              # Multi-stage Docker build (SDK → aspnet runtime)
│   ├── docker-compose.yml      # Local Docker orchestration
│   ├── appsettings.json        # Configuration (Session section)
│   ├── manifest.json           # PWA manifest
│   │
│   ├── Configuration/
│   │   └── SessionSettings.cs  # MaxSessions, MaxMembersPerSession, DistributeOrphanedObjects
│   │
│   ├── Models/
│   │   ├── Session.cs                  # Session entity (Members, Objects, SyncRoot, LifecycleState)
│   │   ├── Member.cs                   # Member entity (Role, EventSequence)
│   │   ├── SessionObject.cs            # Synced object (Scope, Version, Data dictionary)
│   │   ├── MemberRole.cs               # Enum: Server, Client
│   │   ├── ObjectScope.cs              # Enum: Member, Session
│   │   └── SessionLifecycleState.cs    # Enum: Active, Destroying, Destroyed
│   │
│   ├── Services/
│   │   ├── ISessionService.cs          # Interface + result records (Create/Join/Leave/ActiveSessions)
│   │   ├── SessionService.cs           # In-memory session management (ConcurrentDictionary)
│   │   ├── IObjectService.cs           # Interface + ObjectUpdate/ObjectMigration/MemberDepartureResult
│   │   ├── ObjectService.cs            # Object CRUD, version control, member departure handling
│   │   └── SessionCleanupService.cs    # Background service: expires empty and long-lived sessions
│   │
│   ├── Hubs/
│   │   ├── SessionHub.cs       # SignalR hub: game-agnostic session/object API
│   │   └── HubDtos.cs          # Request/response DTOs for hub methods
│   │
│   └── wwwroot/
│       ├── index.html          # Single-file game: HTML5 Canvas + CSS + JS (~4800 lines)
│       ├── session-test.html   # Session management test harness
│       ├── manifest.json       # PWA web app manifest
│       ├── debug/
│       │   └── index.html      # Real-time network metrics debug page
│       └── js/
│           ├── session-client.js  # SignalR connection & session API wrapper
│           ├── object-sync.js     # Object registry, delta encoding, sync timing
│           └── signalr.min.js     # SignalR client library (local copy)
│
├── AstervoidsWeb.Tests/        # xUnit test project (79 tests)
│   ├── AstervoidsWeb.Tests.csproj  # Test dependencies: xUnit, FluentAssertions, Moq
│   ├── TestBase.cs                 # Shared test base: CreateTestSession / CreateTestSessionWithClient helpers
│   ├── SessionServiceTests.cs      # Session create/join/leave/naming (24 tests)
│   ├── ObjectServiceTests.cs       # Object CRUD/versioning/departure (21 tests)
│   ├── ServerPromotionTests.cs     # Server role promotion scenarios (13 tests)
│   ├── ConcurrencyTests.cs         # Concurrency / thread-safety tests (17 tests)
│   └── SessionHubTests.cs          # SessionHub unit tests (4 tests)
│
├── infra/                      # Azure infrastructure (Bicep IaC)
│   ├── main.bicep              # Three deployment paths: production, branch, standalone
│   ├── main.parameters.json    # Environment parameters
│   ├── enable-custom-domain.ps1 # Custom domain setup script
│   ├── CUSTOM_DOMAIN_SETUP.md  # Custom domain documentation
│   └── core/
│       ├── host/
│       │   ├── container-apps.bicep  # Container Apps Environment + ACR
│       │   └── container-app.bicep   # Individual Container App module
│       └── dns/
│           ├── dns-zone.bicep        # Azure DNS zone
│           └── dns-records.bicep     # CNAME + TXT verification records
│
└── .github/
    ├── copilot-instructions.md     # AI coding assistant instructions
    ├── agents/
    │   └── race-condition-reviewer.agent.md  # Race condition review agent
    ├── scripts/
    │   └── sanitize-branch-name.sh # Branch name sanitization for deployments
    └── workflows/
        ├── azure-deploy.yml        # CI/CD: build, test, provision, deploy
        └── cleanup-orphans.yml     # Cleanup orphaned branch deployments
```

## Infrastructure & Deployment

```mermaid
flowchart TB
    subgraph "Three Deployment Paths"
        direction TB
        PROD["Production<br/>environmentName = 'production'<br/>Creates own resource group: rg-production<br/>Full infra: ACR + CAE + Container App<br/>Optional: DNS zone + custom domain"]
        BRANCH["Branch (CI/CD)<br/>useSharedInfra = true<br/>Uses production's resource group<br/>Shares ACR + CAE<br/>Creates new Container App per branch"]
        STANDALONE["Standalone (local dev)<br/>Creates own resource group: rg-{env}<br/>Full infra: own ACR + CAE + Container App"]
    end

    subgraph "CI/CD Pipeline (azure-deploy.yml)"
        direction TB
        TRIGGER["Trigger: push to main or PR branches"]
        BUILD["Build & Test: dotnet build/test"]
        DOCKER["Docker: build + push to ACR"]
        DEPLOY["Deploy: azd provision + deploy"]
        CLEANUP["cleanup-orphans.yml:<br/>Remove Container Apps for<br/>deleted/merged branches"]
    end

    subgraph "Runtime"
        direction TB
        CA["Azure Container App<br/>Port 8080, 0-1 replicas<br/>.NET 10.0 runtime"]
        WS["WebSocket: /sessionHub<br/>SignalR with auto-reconnect"]
        COMP["Response Compression:<br/>Brotli + Gzip (EnableForHttps=true)"]
    end

    TRIGGER --> BUILD --> DOCKER --> DEPLOY
    DEPLOY --> PROD
    DEPLOY --> BRANCH
```

## Game Configuration (CONFIG)

The frontend `CONFIG` object in `index.html` defines all game constants (normalized to shorter canvas dimension):

| Category | Key Constants |
|----------|-------------|
| **Physics** | `TARGET_FPS: 60`, `SHIP_THRUST: 0.009`, `SHIP_FRICTION: 0.99`, `SHIP_MAX_SPEED: 0.8` |
| **Weapons** | `BULLET_SPEED: 1.0`, `BULLET_LIFETIME: 60 frames`, `MAX_BULLETS: 10`, `SHOOT_COOLDOWN: 10 frames` |
| **Asteroids** | `INITIAL_ASTEROID_RADIUS: 0.083`, `MIN_ASTEROID_RADIUS: 0.025`, `SPLIT_COUNT: 2`, `IMPACT_SPIN_FACTOR: 0.02` |
| **Scoring** | `POINTS_LARGE: 20`, `POINTS_MEDIUM: 50`, `POINTS_SMALL: 100` (smaller = more points) |
| **Game** | `STARTING_LIVES: 3`, `MULTIPLAYER_LIVES: 3`, `INVULNERABILITY_TIME: 180 frames`, `WAVE_DELAY: 120 frames` |
| **Sync** | `SYNC_NOMINAL_FRAME_TIME: 1/10 (10Hz)`, `ADAPTIVE_SEND_RATE: true`, `DELTA_ENCODING_ENABLED: true` |
| **Interpolation** | `INTERPOLATION_DELAY: 33ms`, `ADAPTIVE_DELAY_ENABLED: true`, `SNAPSHOT_BUFFER_SIZE: 6`, `MAX_EXTRAPOLATION: 1.0s` |
| **Adaptive Delay** | `ADAPTIVE_DELAY_NET_FLOOR: 0.25`, `ADAPTIVE_DELAY_JITTER_MULT: 2`, `ADAPTIVE_DELAY_SMOOTHING: 0.1`, `ADAPTIVE_DELAY_SAMPLES: 30` |

Object types: `ship`, `asteroid`, `bullet`, `gameState`. Ship colors: Green, Cyan, Magenta, Yellow (up to 4 players).

## Debug & Test Pages

| Page | Path | Purpose |
|------|------|---------|
| **Debug** | `/debug/index.html` | Real-time network metrics display using BroadcastChannel. Shows per-member BUF, RTT, jitter, send rate, reconciliation count. Auto-connects to the game page's metrics broadcast. |
| **Session Test** | `/session-test.html` | Interactive test harness for session management. Tests create/join/leave sessions, object CRUD, and SignalR events. Uses local `signalr.min.js`. |
