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

## Client Architecture

The browser client is split into four cooperative modules loaded before `index.html`'s inline script runs. Each module exposes only an explicit `return { ... }` object; all internal state is closure-private. Dependency direction is strictly top-down — no code above a given layer ever calls into a layer below it directly.

### Layer Boundaries

```mermaid
graph TB
    GAME["index.html<br/>Game loop · Rendering · Input · Gameplay rules"]
    OS["ObjectSync  (object-sync.js)<br/>Object registry · Delta encoding · Batched flush<br/>Per-member sequencing · Reconciliation · Field-name compression"]
    SC["SessionClient  (session-client.js)<br/>SignalR lifecycle · Hub RPC wrappers<br/>Stale-connection guard() · GUID normalization"]
    GU["GuidUtils  (guid-utils.js)<br/>bytesToGuid · transformBinaryGuids"]
    HUB["/sessionHub<br/>ASP.NET Core SignalR — MessagePack"]

    GAME -->|"tick(dt) · create/update/delete/replaceObject · on(event)"| OS
    GAME -->|"connect · createSession · joinSession · leaveSession · on(event)"| SC
    OS -->|"createObject · updateObjects · deleteObject<br/>replaceObject · getSessionState"| SC
    SC -->|"transformBinaryGuids(result / args)"| GU
    SC <-->|"WebSocket · MessagePack binary"| HUB
```

### Dependency Invariants

These rules are enforced purely by module structure and must not be violated when extending the client:

- **Only `SessionClient` holds a `signalR.HubConnection`.** The hub URL `/sessionHub` and `MessagePackHubProtocol` are referenced nowhere outside `session-client.js`. `index.html` contains no `signalR.*` references.
- **Only `SessionClient` calls `GuidUtils.transformBinaryGuids`.** It is applied in both the `guard()` event wrapper (all hub push callbacks) and `invokeHub()` (all RPC responses), so nothing above `SessionClient` ever observes a raw 16-byte `Uint8Array` GUID.
- **`ObjectSync` is the sole consumer of `SessionClient.{createObject, updateObjects, deleteObject, replaceObject, getSessionState}`.** The game never calls these transport methods directly.
- **The game never directly manages `memberSequence`, delta encoding, or reconciliation.** Per-member sequence tracking, gap detection, and `GetSessionState` calls are entirely encapsulated inside `ObjectSync`.
- **Send rate is decoupled from frame rate.** The game calls only `ObjectSync.tick(frameTimeSec)` once per frame; `ObjectSync` internally computes `sendThreshold` from `nominalFrameTime` and flushes batched mutations independently.

> These are the client-side analogues of the server-side lock ordering described in the [Thread Safety](#sessionservice-thread-safety) section.

### SessionClient Public API

#### RPC Wrappers

All wrappers route through `invokeHub()`, which enforces session membership and applies `GuidUtils.transformBinaryGuids` to the result before returning it to the caller.

| Wrapper | Hub method | Wire args | Return (after GUID normalization) |
|---|---|---|---|
| `createSession(metadata?)` | `CreateSession` | `metadata?` | `{ session, member }` or `null` |
| `joinSession(sessionId, evictMemberId?)` | `JoinSession` | `sessionId, evictMemberId?` | `{ session, member }` or `null` |
| `leaveSession()` | `LeaveSession` | — | `void` (broadcast only) |
| `getActiveSessions()` | `GetActiveSessions` | — | `{ sessions[], maxSessions, canCreateSession }` |
| `createObject(data, scope, ownerMemberId?)` | `CreateObject` | `data, scope, ownerMemberId?` | `{ objectInfo, memberSequence }` |
| `updateObjects(updates, senderSequence, senderSendIntervalMs)` | `UpdateObjects` | `updates[], senderSequence, clientTimestamp†, senderSendIntervalMs` | `{ versions{}, memberSequence, serverTimestamp }` |
| `replaceObject(deleteObjectId, replacements, scope, ownerMemberId?)` | `ReplaceObject` | `deleteObjectId, replacements[], scope, ownerMemberId?` | `createdInfos[]` |
| `deleteObject(objectId)` | `DeleteObject` | `objectId` | `{ success, memberSequence }` |
| `getSessionState()` | `GetSessionState` | — | `{ members[], objects[], memberSequences{} }` |

† `clientTimestamp = Date.now()` is injected by the `updateObjects` wrapper; the JS caller does not pass it.

#### Lifecycle and State Methods

These methods have no corresponding hub RPC.

| Method | Description |
|---|---|
| `connect(force?)` | Opens `/sessionHub` with `MessagePackHubProtocol`; `force=true` tears down the existing connection first (awaits `stop()` with a 3 s timeout before creating a new one) |
| `disconnect()` | Stops the connection and clears all state including `lastSessionId` |
| `on(eventName, callback)` | Registers a named callback from the fixed `callbacks` set |
| `getCurrentSession()` | Returns the current session object (`id, name, members[], objects[], metadata`) or `null` |
| `getCurrentMember()` | Returns the current member object (`id, role`) or `null` |
| `isConnected()` | `true` when the connection is `HubConnectionState.Connected` |
| `isInSession()` | `true` when `currentSession !== null` |
| `getLastSessionId()` | Returns the session id from the most recent join; preserved across unexpected disconnects for auto-rejoin |
| `clearSessionState()` | Blanks `currentSession` and `currentMember` without stopping the transport; used during auto-rejoin |

### SessionClient Event Callbacks

`SessionClient.on(name, fn)` registers callbacks from a fixed set of **16** names. The regular mapping is `OnFooBar` (hub broadcast) → `onFooBar` (JS callback). All handler arguments are walked through `GuidUtils.transformBinaryGuids` by `guard()` before dispatch, so callers never observe raw `Uint8Array` GUIDs.

| JS callback | Hub source | Notes |
|---|---|---|
| `onConnected` | `onreconnected` / initial `connect()` | Fires on first connect and after every successful automatic reconnection |
| `onReconnecting` | `onreconnecting` | Transport lost; SignalR is retrying |
| `onDisconnected` | `onclose` | Connection permanently closed; `error` is `null` for intentional disconnect |
| `onSessionCreated` | `createSession()` response | Not a hub broadcast; fired after local state is populated from the RPC response |
| `onSessionJoined` | `joinSession()` response | Not a hub broadcast |
| `onSessionLeft` | `leaveSession()` | Not a hub broadcast |
| `onMemberJoined` | `OnMemberJoined` | `(memberInfo, senderMemberId, memberSequence)` |
| `onMemberLeft` | `OnMemberLeft` | `(info, senderMemberId, memberSequence)`; may be immediately followed by `onRoleChanged` if the local member was promoted |
| `onRoleChanged` | Derived from `OnMemberLeft` | Fired only when `info.promotedMemberId === currentMember.id`; arg: `(newRole)` |
| `onObjectCreated` | `OnObjectCreated` | `(objectInfo, senderMemberId, memberSequence)` |
| `onObjectsUpdated` | `OnObjectsUpdated` | Arg reorder: hub sends `serverTimestamp` at position 4; callback puts it at position 1 → `(objects, serverTimestamp, senderMemberId, senderSequence, memberSequence, senderSendIntervalMs)` |
| `onObjectDeleted` | `OnObjectDeleted` | `(objectId, senderMemberId, memberSequence)` |
| `onObjectReplaced` | `OnObjectReplaced` | `(event, senderMemberId, memberSequence)` |
| `onSessionsChanged` | `OnSessionsChanged` | No args; signal only — caller must call `getActiveSessions()` to get the updated list |
| `onSessionExpired` | `OnSessionExpired` | `(reason)` — server-driven session destroy via `SessionCleanupService` |
| `onError` | Internal | `(errorMessage)` — fired on connection or RPC errors |

### ObjectSync Public API

#### Lifecycle / Config

| Method | Description |
|---|---|
| `init()` | Subscribes to the six `SessionClient` events the sync layer consumes (`onObjectCreated`, `onObjectsUpdated`, `onObjectDeleted`, `onObjectReplaced`, `onSessionJoined`, `onSessionLeft`) |
| `configure(config)` | Sets `nominalFrameTime`, `minFrameTime`, `deltaEncoding`, `adaptiveSendRate`, and `fieldMap` |
| `clear()` | Resets all local state (objects, sequences, pending updates); called on session leave |

#### Object Mutations

| Method | Description |
|---|---|
| `createObject(data, scope?, ownerMemberId?, isStillNeeded?)` | **Response-first**: invokes `CreateObject`, registers the server-assigned id + version; if `isStillNeeded()` returns `false` after the round-trip, fires a fire-and-forget delete to clean up the orphan |
| `updateObject(id, data, immediate?)` | Mutates the local object immediately and queues for batched flush; `immediate=true` forces a flush without waiting for `tick()` |
| `deleteObject(id)` | **Local-first**: removes from the local map and `pendingUpdates`, adds to `pendingDeletes`, then invokes `DeleteObject` |
| `replaceObject(deleteId, replacements, scope?, ownerMemberId?)` | Atomic delete-plus-create round-trip; local map is not mutated until the `OnObjectReplaced` broadcast echo arrives |
| `flushUpdates()` | Builds the wire batch (delta or full), compresses field names via `fieldMap`, and calls `SessionClient.updateObjects` |

#### Frame Pump

| Method | Description |
|---|---|
| `tick(frameTimeSec)` | Called once per game frame; recomputes `sendThreshold = round(nominalFrameTime / clampedFrameTime)`, increments the frame counter, and calls `flushUpdates()` when the threshold is reached |

#### Queries

| Method | Description |
|---|---|
| `getObject(id)` | Returns the local object with the given id, or `undefined` |
| `getAllObjects()` | Returns an array of all locally tracked objects |
| `getObjectsByOwner(memberId)` | Returns all objects where `ownerMemberId === memberId` |
| `getObjectsByType(type)` | O(n-matching) type lookup via the internal `typeIndex` |
| `getObjectByType(type)` | O(1) singleton lookup (e.g. `GameState`) via `typeIndex` |
| `getObjectCount()` | Returns the number of locally tracked objects |
| `getReconciliationCount()` | Returns the number of completed reconciliations in this session |
| `getSendRate()` | Returns the current effective send rate in Hz (`round(1 / nominalFrameTime)`) |
| `isReconciling()` | `true` while a `GetSessionState` reconciliation round-trip is in progress |

#### Adaptive Send Rate

| Method | Description |
|---|---|
| `updateSendRate(rttMs)` | Scales `nominalFrameTime` linearly from measured RTT (only when `adaptiveSendRate` is enabled); low RTT → 20 Hz, high RTT → 1 Hz |

#### Reconciliation Control

| Method | Description |
|---|---|
| `triggerReconciliation()` | Fetches a full state snapshot from the server and syncs the local object map; no-op while suspended or already reconciling |
| `suspendReconciliation()` | Increments the suspend counter; while `> 0`, `triggerReconciliation()` is a silent no-op |
| `resumeReconciliation()` | Decrements the suspend counter |

#### Cross-Layer Coordination Hooks

| Method | Description |
|---|---|
| `handleOwnershipMigration(migratedObjects)` | Applies server-authoritative `{ objectId, newOwnerId, newVersion }` entries from `MemberLeftInfo`; prevents version drift from blind local increments |
| `handleMemberDeparture(deletedObjectIds)` | Removes member-scoped objects from the local map and fires `onObjectDeleted` for each |
| `trackEventSequence(senderMemberId, memberSequence)` | Public alias for `trackMemberSequence`; keeps the per-member sequence map current for events not handled internally by `ObjectSync` |

#### Event Registration

| Method | Description |
|---|---|
| `on(eventName, callback)` | Registers a callback from the fixed 7-name `callbacks` set |

### ObjectSync Event Callbacks

`ObjectSync.on(name, fn)` registers callbacks from a fixed set of **7** names.

| Callback | Signature | Notes |
|---|---|---|
| `onObjectCreated` | `(obj)` | Fires when an object is first registered locally (from remote creation, reconciliation, or own `createObject` response) |
| `onObjectUpdated` | `(obj)` | Fires when a remote update is applied to a locally tracked object |
| `onObjectDeleted` | `(obj)` | Fires when an object is removed from the local map (remote delete, member departure, or reconciliation ghost removal) |
| `onBatchReceived` | `(serverTimestamp, clientTimestamp?, senderSendIntervalMs?, senderMemberId?, responseTimestamp?)` | Powers the full RTT→TX→BUF pipeline (see [Networking: RTT → TX → BUF Pipeline](#networking-rtt--tx--buf-pipeline)). For remote batches `clientTimestamp` is `null`; for own flush responses `clientTimestamp` is set and RTT is computable as `responseTimestamp - clientTimestamp` |
| `onSyncError` | `(operation, error)` | Fires when a `createObject`, `updateObject`, or `deleteObject` RPC fails |
| `onReconciliationFailed` | `()` | Fires when `GetSessionState` returns `null` or throws — the server no longer recognizes this connection as a session member; drives `attemptAutoRejoin` in the game |
| `onReconciliationComplete` | `()` | Fires at the end of a successful reconciliation round-trip |

### Cross-Layer Coordination Contracts

The following implicit protocols are promoted here to explicit contracts.

#### Member Departure Ordering

Inside the game's `onMemberLeft(info, ...)` handler, the game **must** call `ObjectSync.handleOwnershipMigration(info.migratedObjects)` and `ObjectSync.handleMemberDeparture(info.deletedObjectIds)` **before** reading ownership from the local object map. These calls apply the server-authoritative versions from `MemberLeftInfo` — skipping them would cause blind local increments to diverge from the server version, triggering spurious reconciliations.

#### Auto-Rejoin Reentry

The `attemptAutoRejoin` path wraps its multi-step reentry with `suspendReconciliation` / `resumeReconciliation` (counter-based, so nested calls compose correctly) and uses `clearSessionState()` to drop stale refs without tearing down the transport:

```
ObjectSync.suspendReconciliation()      // prevent snapshot races mid-rejoin
SessionClient.clearSessionState()       // drop stale currentSession/currentMember
                                        //   without stopping the SignalR connection
SessionClient.joinSession(sessionId, evictMemberId)   // evict own stale member if still present
ObjectSync.resumeReconciliation()
```

Cross-reference: [SignalR Reconnection & Reconciliation](#signalr-reconnection--reconciliation).

#### Local-First Delete Safety

`ObjectSync.deleteObject` adds the object id to `pendingDeletes` immediately after removing it from the local map, before the `DeleteObject` invoke resolves. A concurrent `triggerReconciliation` snapshot skips ids in `pendingDeletes` on the "add missing object" pass, preventing a racing snapshot from resurrecting a locally-deleted object. `pendingDeletes` is cleared when the invoke resolves (success or failure).

#### Field-Name Compression Boundary

`ObjectSync.compressData` / `expandData` apply the configured `fieldMap` exactly at the wire boundary:

- **Before send**: after delta computation, field names are compressed (e.g. `velocityX` → `vx`).
- **After receive**: field names are expanded before dispatch to game callbacks.

Game logic always uses readable field names. An empty `fieldMap` (the default) means pass-through — compression is purely opt-in via `configure({ fieldMap: { ... } })`.

---

## Backend Data Model

```mermaid
classDiagram
    class Session {
        +Guid Id
        +string Name (from ISessionNameGenerator)
        +Dictionary~string,object?~ Metadata (immutable after create)
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
        SS_CFG["Config:<br/>MaxSessions: 6<br/>MaxMembersPerSession: 4<br/>Names from ISessionNameGenerator<br/>(default: FruitNameGenerator, 50 names)"]
        SS_DEP["Member departure (atomic in LeaveSession):<br/>• Remove from indexes<br/>• Promote oldest remaining if Server left<br/>• HandleObjectDeparture: delete Member-scoped,<br/>  migrate Session-scoped (round-robin)<br/>• Mark LastMemberLeftAt for deferred cleanup"]
    end

    subgraph "ObjectService"
        direction TB
        OS_OPS["Operations (all enforce ownership + lifecycle<br/>under session.SyncRoot):<br/>CreateObject → Id, Version=1, Owner<br/>UpdateObject → merge, Version++ (no ownership check)<br/>UpdateObjects → Batch, owner-filtered atomically<br/>DeleteObject → ownership-checked TryRemove<br/>ReplaceObject → atomic delete + create children"]
    end

    subgraph "FruitNameGenerator (ISessionNameGenerator)"
        direction TB
        FNG["50-fruit pool (Apple, Banana, ...)<br/>Pick random unused name<br/>If all used → append counter (Apple2)"]
    end

    subgraph "ServerMetricsService (singleton)"
        direction TB
        SMS["Tracks: CPU/memory/GC/thread pool,<br/>connection counts, hub invocations,<br/>per-member TX/RX bytes, reconciliations,<br/>reconnects.<br/>Exposed via GET /api/srvmon (camelCase JSON)."]
    end

    subgraph "SessionCleanupService (BackgroundService)"
        direction TB
        SCS_OPS["Runs every 10 seconds<br/>Empty timeout: destroy sessions with no members<br/>Absolute timeout: destroy sessions exceeding max lifetime<br/>Notifies connected members via SignalR OnSessionExpired<br/>Broadcasts OnSessionsChanged on any cleanup"]
        SCS_CFG["Config (SessionSettings):<br/>EmptyTimeoutSeconds: 30<br/>AbsoluteTimeoutMinutes: 20<br/>ClientTimeoutSeconds: 20<br/>KeepAliveSeconds: 10"]
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
    subgraph "CreateSession(metadata?)"
        CS1{"Connection already<br/>in a session?"}
        CS2{"Active sessions<br/>>= maxSessions (6)?"}
        CS4["Pick session name via ISessionNameGenerator<br/>(default FruitNameGenerator: random unused fruit;<br/>append counter if pool exhausted)"]
        CS5["Create Session with Name + Metadata"]
        CS6["Create Member with Role=Server"]
        CS7["Add to _sessions, _connectionToMember,<br/>_memberToSession, session.Members"]
        CS8["Return CreateSessionResult<br/>{Success, Session, Creator}"]
        CSE["Return error"]

        CS1 -->|Yes| CSE
        CS1 -->|No| CS2
        CS2 -->|Yes| CSE
        CS2 -->|No| CS4 --> CS5 --> CS6 --> CS7 --> CS8
    end

    subgraph "JoinSession(sessionId, evictMemberId?)"
        JS1{"Connection already<br/>in a session?"}
        JS2{"Session exists<br/>AND Active?"}
        JSE_EVICT{"evictMemberId given<br/>AND stale member found<br/>(different connection)?"}
        EVI["EvictMemberInternal:<br/>remove from indexes, promote if was Server,<br/>HandleObjectDeparture (delete + migrate)"]
        JS3{"Members.Count<br/>>= maxMembers (4)?"}
        WAS{"Session was empty<br/>(rejoining)?"}
        JS4S["Create Member with Role=Server"]
        JS4C["Create Member with Role=Client"]
        ADOPT["AdoptOrphanedObjects:<br/>reassign session-scoped objects<br/>without a current owner"]
        JS5["Clear session.LastMemberLeftAt"]
        JS6["Return JoinSessionResult<br/>{Success, Session, Member, Eviction?}"]
        JSE["Return error"]

        JS1 -->|Yes| JSE
        JS1 -->|No| JS2
        JS2 -->|No| JSE
        JS2 -->|Yes| JSE_EVICT
        JSE_EVICT -->|Yes| EVI --> JS3
        JSE_EVICT -->|No| JS3
        JS3 -->|Yes| JSE
        JS3 -->|No| WAS
        WAS -->|Yes| JS4S --> ADOPT --> JS5
        WAS -->|No| JS4C --> JS5
        JS5 --> JS6
    end
```

## SessionService: Leave & Server Promotion

`LeaveSession` is **atomic** under `session.SyncRoot` — membership change, server
promotion, and object cleanup happen in one critical section and a single
`LeaveSessionResult` is returned to the hub. There is no separate
`HandleMemberDeparture` call (that responsibility moved out of `ObjectService`).

```mermaid
flowchart TB
    L1["LeaveSession(connectionId, distributeOrphanedObjects=true)"]
    L1A{"connectionId in<br/>_connectionToMember?"}
    L1B["Return null (idempotent no-op)"]
    L2["lock(session.SyncRoot)<br/>Re-check connection still registered<br/>Bail if session already Destroyed"]
    L3["TryRemove from _connectionToMember,<br/>_memberToSession, session.Members"]
    L4{"Departing member<br/>was Server AND<br/>any members remain?"}
    L5["Promote oldest remaining member<br/>(min JoinedAt, then min Id — deterministic)<br/>Set Role = Server, session.Version++"]
    L6["HandleObjectDeparture (under same lock):<br/>• Member-scoped → delete<br/>• Session-scoped → migrate round-robin<br/>  (or to first remaining if !distribute)"]
    L7{"session.Members<br/>now empty?"}
    L8["Set session.LastMemberLeftAt = now<br/>(deferred destruction by SessionCleanupService;<br/>orphaned session-scoped objects retained for<br/>AdoptOrphanedObjects on rejoin)"]
    L9["Return LeaveSessionResult {<br/>  SessionId, SessionName, MemberId,<br/>  SessionDestroyed=false, PromotedMember?,<br/>  RemainingMemberIds, DeletedObjectIds,<br/>  MigratedObjects }"]

    L1 --> L1A
    L1A -->|No| L1B
    L1A -->|Yes| L2 --> L3 --> L4
    L4 -->|Yes| L5 --> L6
    L4 -->|No| L6
    L6 --> L7
    L7 -->|Yes| L8 --> L9
    L7 -->|No| L9
```

## ObjectService: Update Flow

All mutations run under `Session.SyncRoot`. Ownership and session lifecycle are
validated atomically inside `ObjectService` itself (the hub still pre-checks for
fast early-return / logging, but correctness does not rely on it).

```mermaid
flowchart TB
    subgraph "UpdateObject (single, no ownership check)"
        U1["UpdateObject(sessionId, objectId, data)"]
        U2{"Session active?<br/>Object exists?"}
        U4["Replace obj.Data with merged copy<br/>obj.Version++<br/>obj.UpdatedAt = now"]
        U5["Return updated SessionObject"]
        UF["Return null (failure)"]

        U1 --> U2
        U2 -->|No| UF
        U2 -->|Yes| U4 --> U5
    end

    subgraph "UpdateObjects (batch, ownership enforced in service)"
        B1["UpdateObjects(sessionId, ownerMemberId, updates)"]
        B2{"For each update:<br/>object exists AND<br/>OwnerMemberId == ownerMemberId?"}
        B3["Merge data, Version++,<br/>UpdatedAt = now"]
        B4["Skip (continue)"]
        B5["Return ONLY successfully<br/>updated objects"]

        B1 --> B2
        B2 -->|Yes| B3 --> B5
        B2 -->|No| B4 --> B5
    end

    subgraph "DeleteObject (ownership enforced in service)"
        D1["DeleteObject(sessionId, objectId, ownerMemberId)"]
        D2{"Object exists AND<br/>owned by ownerMemberId?"}
        D3["TryRemove from session.Objects<br/>Return deleted SessionObject"]
        D4["Return null (no-op)"]

        D1 --> D2
        D2 -->|Yes| D3
        D2 -->|No| D4
    end

    subgraph "ReplaceObject (atomic delete + create)"
        R1["ReplaceObject(sessionId, deleteObjectId,<br/>ownerMemberId, replacements[])"]
        R2{"Session active AND<br/>delete target owned<br/>by ownerMemberId?"}
        R3["Delete target,<br/>create each replacement<br/>(Version=1, owner = caller or override)"]
        R4["Return created list"]
        R5["Return null (no changes applied)"]

        R1 --> R2
        R2 -->|Yes| R3 --> R4
        R2 -->|No| R5
    end
```

## SessionService: Member Departure & Ownership Redistribution

`HandleObjectDeparture` is a private helper of `SessionService`, called inside
`LeaveSession` and `EvictMemberInternal` while `session.SyncRoot` is held. The
results (`DeletedObjectIds`, `MigratedObjects`) are bundled into
`LeaveSessionResult` / `EvictionInfo` so the hub can broadcast a single
`OnMemberLeft` event.

```mermaid
flowchart TB
    HD["HandleObjectDeparture<br/>(session, departingMemberId,<br/>remainingMemberIds[], distribute)"]
    ITER["Iterate session.Objects<br/>where OwnerMemberId == departingMemberId"]

    subgraph "Per Object Decision"
        CHK{"Object Scope?"}

        subgraph "Member-Scoped (Ship, Bullet)"
            DEL["TryRemove from session.Objects<br/>Add Id to deletedIds"]
        end

        subgraph "Session-Scoped (Asteroid, GameState)"
            REM{"remainingMembers > 0?"}
            DIST{"distribute<br/>AND members > 1?"}
            RR["Round-robin:<br/>newOwner = remaining[index % count]<br/>index++"]
            FIRST["First member:<br/>newOwner = remaining[0]"]
            ASSIGN["obj.OwnerMemberId = newOwner<br/>Replace obj.Data (copy-on-write)<br/>obj.Version++; obj.UpdatedAt = now<br/>Add ObjectMigration(id, newOwner, newVersion)"]
            ORPHAN["Object stays with departing owner-id<br/>Adopted on next JoinSession via<br/>AdoptOrphanedObjects"]
        end
    end

    RES["Return (deletedIds[], migratedObjects[])"]

    HD --> ITER --> CHK
    CHK -->|Member| DEL
    CHK -->|Session| REM
    REM -->|No| ORPHAN
    REM -->|Yes| DIST
    DIST -->|Yes| RR --> ASSIGN
    DIST -->|No| FIRST --> ASSIGN
    DEL --> RES
    ASSIGN --> RES
    ORPHAN --> RES
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
        CREATE["CreateSession(metadata?)<br/>→ Add to AllClients (in OnConnectedAsync) + SessionGroup<br/>→ Broadcast: OnSessionsChanged to AllClients<br/>→ Response: sessionId, name, memberId, role, metadata"]
        JOIN["JoinSession(sessionId, evictMemberId?)<br/>→ If evictMemberId: EvictMemberInternal + broadcast OnMemberLeft<br/>  to existing group BEFORE adding new member<br/>→ Add to SessionGroup FIRST (so concurrent broadcasts<br/>  reach the joiner; client dedups vs snapshot by Version)<br/>→ Snapshot members + objects<br/>→ Broadcast: OnMemberJoined to OthersInGroup<br/>→ Response: memberId, role, members[], objects[], metadata"]
        LEAVE["LeaveSession()<br/>→ Atomic SessionService.LeaveSession (promotion + object cleanup)<br/>→ Remove from SessionGroup<br/>→ Broadcast: OnMemberLeft to Group (all remaining)<br/>→ Broadcast: OnSessionsChanged to AllClients"]
        GAS["GetActiveSessions()<br/>→ No broadcast (read-only)<br/>→ Response: ActiveSessionsResponse"]
        CO["CreateObject(data, scope, ownerMemberId?)<br/>→ Broadcast: OnObjectCreated to OthersInGroup<br/>→ Response: objectInfo + memberSequence"]
        UO["UpdateObjects(updates[], senderSeq,<br/>clientTimestamp, senderSendIntervalMs)<br/>→ ObjectService filters to caller-owned objects atomically<br/>→ Broadcast: OnObjectsUpdated to OthersInGroup<br/>→ Response: versions{} + memberSequence + serverTimestamp"]
        DO["DeleteObject(objectId)<br/>→ ObjectService enforces ownership atomically<br/>→ Broadcast: OnObjectDeleted to OthersInGroup<br/>→ Response: success + memberSequence"]
        RO["ReplaceObject(deleteId, replacements[],<br/>scope, ownerMemberId?)<br/>→ ObjectService atomic delete + create (ownership enforced)<br/>→ Broadcast: OnObjectReplaced to Group (ALL)<br/>→ Response: createdInfos[]"]
        GS["GetSessionState()<br/>→ No broadcast (read-only)<br/>→ Response: full snapshot (members, objects, sequences)"]
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
    participant REM as Remaining Members
    participant ALL as AllClients

    C->>HUB: LeaveSession() or OnDisconnectedAsync()
    HUB->>SS: LeaveSession(connectionId)
    Note over SS: Atomic under session.SyncRoot:<br/>• Remove from 3 dictionaries<br/>• Promote oldest remaining if Server left<br/>• HandleObjectDeparture: delete Member-scoped,<br/>  migrate Session-scoped (round-robin)<br/>• If now empty: set LastMemberLeftAt<br/>  (deferred destroy by SessionCleanupService)
    SS-->>HUB: LeaveSessionResult { sessionId, sessionName,<br/>memberId, sessionDestroyed=false, promotedMember?,<br/>remainingMemberIds, deletedObjectIds, migratedObjects }

    HUB->>HUB: RemoveFromGroupAsync(sessionGroup)

    HUB->>REM: OnMemberLeft(MemberLeftInfo {<br/>  memberId,<br/>  promotedMemberId?,<br/>  promotedRole?,<br/>  deletedObjectIds[],<br/>  migratedObjects[{objectId, newOwnerId, newVersion}]<br/>})
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

    HUB->>OS: ReplaceObject(sessionId, deleteId, callerId, replacements)
    Note over OS: Single critical section under session.SyncRoot:<br/>• Verify session active + caller owns delete target<br/>• Remove delete target<br/>• Create each replacement (Version=1, owner=caller or override)<br/>• Either fully committed or no changes applied

    OS-->>HUB: createdObjects[] (or null on failure)

    HUB->>HUB: memberSequence = Interlocked.Increment

    HUB->>ALL: OnObjectReplaced({<br/>  deletedObjectId,<br/>  createdObjects[{Id, Owner, Scope, Data, Version}]<br/>}, memberId, memberSequence, serverTimestamp)

    Note over ALL: Broadcast to ALL (not OthersInGroup)<br/>because caller also needs to sync<br/>new server-assigned Ids for children

    HUB-->>C: Response: createdInfos[]
```

## Session & Member Model

```mermaid
stateDiagram-v2
    [*] --> Lobby: Page load
    Lobby --> Creating: CreateSession(metadata?)
    Lobby --> Joining: JoinSession(sessionId, evictMemberId?)
    Creating --> InSession: Response (memberId, sessionId, role=Server, metadata)
    Joining --> InSession: Response (memberId, sessionId, role, members[], objects[], metadata)
    InSession --> Lobby: LeaveSession()
    InSession --> InSession: Server leaves → oldest remaining member promoted (deterministic)

    state InSession {
        [*] --> Playing
        Playing --> Playing: Game loop
    }
```

```mermaid
graph LR
    subgraph "Session (max 6 concurrent)"
        direction TB
        S["Session<br/>Id: Guid<br/>Name: string (from ISessionNameGenerator)<br/>Metadata: Dictionary&lt;string, object?&gt;<br/>Version: long<br/>Max members: 4"]
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

    SR->>SR: withAutomaticReconnect<br/>Linear 1s interval<br/>Max 10 attempts (10s window)

    SR->>C: onreconnecting(error) → freeze gameplay,<br/>show #reconnecting-overlay

    alt Reconnection succeeds (transport restored)
        SR->>C: onreconnected(connectionId)
        C->>C: ObjectSync.triggerReconciliation()
        C->>HUB: GetSessionState()

        alt Server still has the member
            HUB-->>C: Full snapshot + memberSequences
            C->>C: Sync local objects:<br/>• Add missing<br/>• Update stale<br/>• Remove ghosts<br/>• Reset sequences<br/>onConnected fires → unfreeze gameplay
        else Server already processed disconnect
            HUB-->>C: null
            C->>C: onReconciliationFailed → re-freeze<br/>and call attemptAutoRejoin (full path below)
        end
    else Max retries exceeded (or mobile auto-rejoin)
        SR->>C: onclose(error)
        C->>C: attemptAutoRejoin(sessionId, oldMemberId)<br/>Guards: rejoinInProgress, leavingSession.<br/>If document.hidden: defer (save pendingRejoinSessionId/MemberId,<br/>resume on visibilitychange).<br/>ObjectSync.suspendReconciliation() while rejoining.
        loop Up to 5 attempts (delay 0.5s, then 2s × n)
            C->>C: connectToSessionHub(force=true) —<br/>await stale.stop() with timeout, clear currentSession/<br/>currentMember, then build new connection.
            C->>HUB: JoinSession(sessionId, evictMemberId=oldMemberId)
            Note over HUB: If old member still present (server hadn't<br/>processed disconnect yet — up to ClientTimeoutSeconds),<br/>it is evicted atomically and OnMemberLeft is broadcast<br/>to remaining members BEFORE the new member is added.
            HUB-->>C: Rejoin response (new memberId, members[], objects[])
        end
        C->>C: resetMultiplayerState() BEFORE handleSessionJoined<br/>loads snapshot (avoids ObjectSync.clear wiping it).<br/>game.connectionLost cleared, ObjectSync.resumeReconciliation().
    end

    Note over C: Stale connection guard: setupEventHandlers()<br/>captures thisConnection reference.<br/>Old connection's onclose/on* events<br/>are silently ignored if connection<br/>has been replaced by connect().
    Note over C: Reconciliation safety: ObjectSync.pendingDeletes Set<br/>prevents triggerReconciliation from resurrecting<br/>locally-deleted objects whose server delete is in flight.
```

## SessionService: Thread Safety

```mermaid
flowchart TB
    subgraph "Serialization Strategy"
        direction TB
        LOCK["_sessionLock (object)<br/>Serializes CreateSession & JoinSession<br/>Prevents TOCTOU races on:<br/>• connection-already-in-session check<br/>• max sessions count check<br/>• concurrent join + capacity check"]
        SYNC["session.SyncRoot (object, per-session)<br/>Serializes ALL session-local mutations:<br/>• member add/remove<br/>• server promotion (deterministic — no race)<br/>• object create/update/delete/replace<br/>• ownership migration<br/>• lifecycle transitions<br/>• LastMemberLeftAt updates"]
        CONC["ConcurrentDictionary (4 instances)<br/>_sessions, _connectionToMember,<br/>_memberToSession, session.Members<br/>Thread-safe individual operations"]
    end

    subgraph "Lock ordering"
        ORDER["Acquisition order is always:<br/>_sessionLock → session.SyncRoot<br/>(prevents deadlocks across cross-session ops)"]
    end

    LOCK --> CONC
    SYNC --> CONC
```

## Hub: Ownership Enforcement

Ownership and session lifecycle are validated **inside the service layer** under
`Session.SyncRoot`, atomically with the mutation. Hub-layer pre-checks remain
only as fast early-return / logging — they are not relied on for correctness.

```mermaid
flowchart TB
    subgraph "ObjectService (authoritative — under SyncRoot)"
        OS_UPD["UpdateObjects: filters batch to objects<br/>where OwnerMemberId == ownerMemberId"]
        OS_DEL["DeleteObject(sessionId, objectId, ownerMemberId):<br/>verifies ownership before TryRemove"]
        OS_REP["ReplaceObject(sessionId, deleteId,<br/>ownerMemberId, replacements[]):<br/>verifies ownership of delete target<br/>before atomic delete + create"]
    end

    subgraph "SessionHub (early-return + logging)"
        HUB_UPD["UpdateObjects: passes caller.Id as ownerMemberId<br/>to ObjectService"]
        HUB_DEL["DeleteObject: optional pre-check + warning if not owner;<br/>passes caller.Id to ObjectService"]
        HUB_REP["ReplaceObject: optional pre-check;<br/>passes caller.Id to ObjectService"]
    end

    HUB_UPD --> OS_UPD
    HUB_DEL --> OS_DEL
    HUB_REP --> OS_REP
```

## Wire Format & Server Monitoring

```mermaid
flowchart TB
    subgraph "SignalR transport (binary MessagePack)"
        direction TB
        MP["AddMessagePackProtocol with CompositeResolver:<br/>• BinaryGuidResolver (16-byte binary GUIDs<br/>  via BinaryGuidFormatter / NullableGuidFormatter)<br/>• ContractlessStandardResolver (DTOs + collections)<br/>• MessagePackSecurity.UntrustedData<br/>~25-30% smaller payloads vs JSON;<br/>~19 bytes saved per GUID over the wire."]
        DTO["Hub DTOs (HubDtos.cs) annotated with<br/>[MessagePackObject] + [Key('camelCaseName')]<br/>so the JS contract is preserved (camelCase names)."]
        JSGUID["JS client transforms binary GUIDs to strings<br/>at the boundary via GuidUtils.transformBinaryGuids<br/>(applied to handler args + invokeHub responses).<br/>See: Client Architecture — Dependency Invariants."]
    end

    subgraph "REST API (camelCase JSON)"
        REST["ConfigureHttpJsonOptions →<br/>JsonNamingPolicy.CamelCase.<br/>Used by GET /api/srvmon."]
    end

    subgraph "ServerMetricsService (singleton, IDisposable)"
        SMS_SAMPLE["Background CPU sampling every 2s.<br/>Tracks: connectedCount, peakConnections,<br/>totalHubInvocations, per-member TX/RX bytes,<br/>reconciliations, reconnects."]
        SMS_EST["SessionHub.EstimatePayloadBytes() uses<br/>a static MessagePackSerializerOptions<br/>matching Program.cs to compute byte counts<br/>per OnHubInvocation / OnBroadcastToMembers call."]
        SMS_API["GET /api/srvmon → snapshot record (camelCase JSON).<br/>/srvmon/index.html polls every 2s and renders<br/>TX Rate / RX Rate / CPU / connection counts."]
    end

    MP --> DTO --> JSGUID
    SMS_SAMPLE --> SMS_API
    SMS_EST --> SMS_API
    REST --> SMS_API
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
│   ├── Program.cs              # App startup, DI, middleware, SignalR mapping,
│   │                           # MessagePack protocol, /api/srvmon endpoint
│   ├── Dockerfile              # Multi-stage Docker build (SDK → aspnet runtime)
│   ├── docker-compose.yml      # Local Docker orchestration
│   ├── appsettings.json        # Configuration (Session section)
│   ├── manifest.json           # PWA manifest
│   │
│   ├── Configuration/
│   │   └── SessionSettings.cs  # MaxSessions, MaxMembersPerSession,
│   │                           # DistributeOrphanedObjects, EmptyTimeoutSeconds,
│   │                           # AbsoluteTimeoutMinutes, ClientTimeoutSeconds,
│   │                           # KeepAliveSeconds
│   │
│   ├── Formatters/
│   │   └── BinaryGuidFormatter.cs      # MessagePack binary GUID encoding:
│   │                                   # BinaryGuidFormatter, NullableGuidFormatter,
│   │                                   # BinaryGuidResolver
│   │
│   ├── Models/
│   │   ├── Session.cs                  # Session entity (Members, Objects, SyncRoot,
│   │   │                               # LifecycleState, Metadata, LastMemberLeftAt)
│   │   ├── Member.cs                   # Member entity (Role, EventSequence)
│   │   ├── SessionObject.cs            # Synced object (Scope, Version, Data dictionary)
│   │   ├── MemberRole.cs               # Enum: Server, Client
│   │   ├── ObjectScope.cs              # Enum: Member, Session
│   │   └── SessionLifecycleState.cs    # Enum: Active, Destroying, Destroyed
│   │
│   ├── Services/
│   │   ├── ISessionService.cs          # Interface + result records (Create/Join/Leave/
│   │   │                               # ActiveSessions/EvictionInfo/ForceDestroy)
│   │   ├── SessionService.cs           # In-memory session management. Atomic LeaveSession,
│   │   │                               # EvictMemberInternal, AdoptOrphanedObjects,
│   │   │                               # HandleObjectDeparture (private helper).
│   │   ├── ISessionNameGenerator.cs    # Pluggable session naming
│   │   ├── FruitNameGenerator.cs       # Default 50-fruit naming with collision counter
│   │   ├── IObjectService.cs           # Interface + ObjectUpdate / ObjectMigration /
│   │   │                               # ReplacementObjectSpec / MemberDepartureResult
│   │   ├── ObjectService.cs            # Object CRUD + ReplaceObject; ownership and
│   │   │                               # lifecycle enforced atomically under Session.SyncRoot
│   │   ├── SessionCleanupService.cs    # Background service: expires empty / long-lived sessions
│   │   └── ServerMetricsService.cs     # Singleton; CPU/memory/GC/connections/per-member
│   │                                   # TX/RX/reconciliation/reconnect; powers /api/srvmon
│   │
│   ├── Hubs/
│   │   ├── SessionHub.cs       # SignalR hub: game-agnostic session/object API.
│   │   │                       # Includes MessagePack payload-size estimation for metrics.
│   │   └── HubDtos.cs          # [MessagePackObject] request/response DTOs (camelCase keys)
│   │
│   └── wwwroot/
│       ├── index.html          # Single-file game: HTML5 Canvas + CSS + JS (~5400 lines)
│       ├── session-test.html   # Session management test harness
│       ├── manifest.json       # PWA web app manifest
│       ├── debug/
│       │   └── index.html      # Real-time client network metrics (BroadcastChannel)
│       ├── srvmon/
│       │   └── index.html      # Server monitoring page; polls /api/srvmon every 2s
│       └── js/
│           ├── session-client.js                  # SignalR lifecycle, hub RPC wrappers, stale-connection
│           │                                      # guard(), GUID normalization. See: Client Architecture.
│           ├── object-sync.js                     # Object registry, type index, delta encoding, batched flush,
│           │                                      # per-member sequencing, reconciliation, field-name compression.
│           │                                      # See: Client Architecture.
│           ├── guid-utils.js                      # bytesToGuid · transformBinaryGuids (binary GUID → string)
│           ├── signalr.min.js                     # SignalR client library (local copy)
│           └── signalr-protocol-msgpack.min.js    # MessagePack protocol for SignalR client
│
├── AstervoidsWeb.Tests/        # xUnit test project (~115 tests)
│   ├── AstervoidsWeb.Tests.csproj   # Test dependencies: xUnit, FluentAssertions, Moq
│   ├── TestBase.cs                  # Shared helpers: CreateTestSession / CreateTestSessionWithClient
│   ├── SessionServiceTests.cs       # Session create/join/leave/naming
│   ├── ObjectServiceTests.cs        # Object CRUD/versioning/replace
│   ├── ServerPromotionTests.cs      # Server promotion, eviction, orphan adoption
│   ├── ConcurrencyTests.cs          # Concurrency / thread-safety tests
│   ├── BinaryGuidFormatterTests.cs  # MessagePack binary GUID round-trip tests
│   ├── ReplaceAfterEvictTest.cs     # Regression: replace right after eviction
│   └── SessionHubTests.cs           # SessionHub unit tests
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
| **Debug** | `/debug/index.html` | Real-time client network metrics display using BroadcastChannel. Shows per-member BUF, RTT, jitter, send rate, reconciliation count. Auto-connects to the game page's metrics broadcast. |
| **Server Monitor** | `/srvmon/index.html` | Server-side monitoring page. Polls `GET /api/srvmon` every 2 seconds and renders CPU / memory / GC / connection counts and per-member TX/RX byte rates derived from poll deltas. |
| **Session Test** | `/session-test.html` | Interactive test harness for session management. Tests create/join/leave sessions, object CRUD, and SignalR events. Uses local `signalr.min.js` and `signalr-protocol-msgpack.min.js`. |
