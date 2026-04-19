/**
 * Object Sync Module
 * Handles local object registry and synchronization with the session.
 *
 * ## Per-Member Event Sequencing
 *
 * Every broadcast from the backend carries (senderMemberId, memberSequence).
 * Each member has its own monotonic counter on the backend (Interlocked.Increment),
 * starting at 0 and incrementing for each event triggered by that member:
 * OnMemberJoined, OnObjectCreated, OnObjectsUpdated, OnObjectDeleted, OnObjectReplaced.
 *
 * OnMemberLeft is special: it uses the departing member's ID with hardcoded seq 0,
 * since the member is being removed and will never send again. Receivers already
 * track that member at seq >= 1, so 0 > lastSeq is false — no false gap.
 *
 * Each frontend tracks a memberSequences Map (memberId -> lastSeqReceived).
 * On each incoming event, trackMemberSequence() checks:
 *   - First event from a member (no baseline): initializes the entry, no gap possible.
 *   - Sequential (seq === lastSeq + 1): normal, updates the map.
 *   - Gap (seq > lastSeq + 1): event(s) lost, triggers reconciliation.
 *   - Old/duplicate (seq <= lastSeq): silently ignored.
 *
 * Gap detection is only performed for OTHER members' streams. The local member's
 * own sequence is tracked (to keep the map current) but gaps are not flagged,
 * because the sender can't miss their own events and the mixed delivery channels
 * (invoke response for updates vs broadcast for create/delete/replace) can race
 * at await microtask boundaries.
 *
 * This works because SignalR guarantees in-order delivery per connection, and all
 * events for a given member flow through that member's single connection. So the
 * backend's Interlocked.Increment producing 5, 6, 7 guarantees arrival in that
 * order at every receiver. The old global sequence had a race where concurrent
 * broadcasts from different members could arrive out of order — per-member
 * sequencing eliminates this entirely since each member's stream is independent.
 *
 * ## Self-Echo Elimination
 *
 * Three event types use OthersInGroup (sender does NOT receive broadcast echo):
 *   - UpdateObjects: sender gets versions, memberSequence, serverTimestamp from response
 *   - CreateObject: sender registers object from invoke response (response-first)
 *   - DeleteObject: sender removes object before invoking (local-first)
 * For all three, the sender's own memberSequence is tracked from the invoke response.
 *
 * OnObjectReplaced still uses Group (sender DOES receive echo) because replaceObject
 * is NOT local-first — the sender relies on the broadcast to mutate its object map
 * (delete parent + add children, which may have different owners).
 *
 * Because the sender's own events arrive through invoke responses (not broadcasts),
 * gap detection is skipped for the sender's own member stream. This avoids false
 * reconciliations from: (a) mixed delivery channels racing at await boundaries,
 * and (b) lost invoke responses leaving stale sequence values. A lost response is
 * self-correcting — the next successful response or reconciliation snapshot will
 * restore the correct sequence value.
 *
 * ## Reconciliation (Gap Recovery)
 *
 * When a gap is detected, triggerReconciliation() calls GetSessionState() which
 * returns a full object snapshot plus the current server-side memberSequences for
 * every member. The local memberSequences map is reset from this snapshot,
 * fast-forwarding past the gap to prevent re-triggering. Objects are synced:
 * missing objects added, stale objects updated, ghost objects removed. A
 * reconciling flag prevents concurrent reconciliations.
 */

const ObjectSync = (function() {
    // ── Field name compression for network traffic ─────────────────────────
    // Maps readable field names to short wire names. Applied at the sync
    // boundary (compress before send, expand after receive) so all game
    // logic uses the full readable names internally.
    //
    // The map is empty by default (no compression). Games supply their own
    // field map via configure({ fieldMap: { ... } }) at startup. Unmapped
    // keys pass through unchanged, so compression is purely opt-in.
    let fieldMap = {};
    let reverseMap = {};

    function compressData(data) {
        if (!data) return data;
        const out = {};
        for (const key in data) {
            out[fieldMap[key] || key] = data[key];
        }
        return out;
    }

    function expandData(data) {
        if (!data) return data;
        const out = {};
        for (const key in data) {
            out[reverseMap[key] || key] = data[key];
        }
        return out;
    }

    // Local object registry
    const objects = new Map();
    
    // Type index for faster lookups - maps type string to Set of object IDs
    const typeIndex = new Map();
    
    // Pending updates to be batched
    let pendingUpdates = [];
    
    // Sender sequence counter (incremented per flush)
    let senderSequence = 0;
    
    // Per-member event sequence tracking for gap detection
    const memberSequences = new Map(); // memberId -> lastSeq
    let reconciling = false;
    let reconciliationCount = 0;
    // External callers (e.g. attemptAutoRejoin) can suspend reconciliation during
    // windows where currentMember/currentSession are mid-transition. While suspended,
    // triggerReconciliation() is a silent no-op. Counter (not bool) so nested
    // suspend/resume calls compose correctly.
    let reconciliationSuspendCount = 0;

    // Tracks objects locally deleted but not yet acknowledged by the server.
    // Reconciliation skips these IDs in the "add missing object" pass — the server's
    // snapshot may still contain them (delete in flight), and re-adding them would
    // resurrect a ghost the user already destroyed. Cleared when DeleteObject's
    // invoke resolves (success or failure) since by then the snapshot will reflect
    // the deletion.
    const pendingDeletes = new Set();
    
    // Delta encoding: track last-sent data per object to only send changes
    const lastSentData = new Map();
    let deltaEncodingEnabled = false;
    
    // Full-state sync interval (frames at nominal rate)
    const FULL_SYNC_INTERVAL = 6000;
    
    // Frame-count-based sync settings
    let nominalFrameTime = 1 / 30;  // target send interval in seconds
    let baseNominalFrameTime = 1 / 30; // configured baseline (before adaptive adjustment)
    let minFrameTime = 1 / 480;     // clamp to prevent extreme thresholds
    let frameCounter = 0;
    let sendThreshold = 2;          // recalculated each frame from actual frame time
    let adaptiveSendRate = false;    // dynamically adjust send rate based on RTT
    const ADAPTIVE_SEND_MIN = 1 / 20; // fastest send interval (20Hz) in seconds
    const ADAPTIVE_SEND_MAX = 1 / 1;  // slowest send interval (1Hz) in seconds

    // Callbacks
    const callbacks = {
        onObjectCreated: null,
        onObjectUpdated: null,
        onObjectDeleted: null,
        onBatchReceived: null,
        onSyncError: null,
        onReconciliationFailed: null,
        onReconciliationComplete: null
    };
    
    /**
     * Configure sync timing and field compression parameters.
     * @param {object} config - { nominalFrameTime, minFrameTime, deltaEncoding, adaptiveSendRate, fieldMap }
     */
    function configure(config) {
        if (config.nominalFrameTime !== undefined) {
            nominalFrameTime = config.nominalFrameTime;
            baseNominalFrameTime = config.nominalFrameTime;
        }
        if (config.minFrameTime !== undefined) {
            minFrameTime = config.minFrameTime;
        }
        if (config.deltaEncoding !== undefined) {
            deltaEncodingEnabled = config.deltaEncoding;
        }
        if (config.adaptiveSendRate !== undefined) {
            adaptiveSendRate = config.adaptiveSendRate;
        }
        if (config.fieldMap !== undefined) {
            fieldMap = config.fieldMap;
            reverseMap = Object.fromEntries(
                Object.entries(fieldMap).map(([k, v]) => [v, k])
            );
        }
    }
    
    /**
     * Adapt send rate based on measured RTT.
     * Linearly scales send interval: low RTT → 20Hz, high RTT → 2Hz.
     * @param {number} rttMs - Current round-trip time in milliseconds
     */
    function updateSendRate(rttMs) {
        if (!adaptiveSendRate) return;
        const rttSec = rttMs / 1000;
        nominalFrameTime = Math.max(ADAPTIVE_SEND_MIN, Math.min(ADAPTIVE_SEND_MAX, rttSec));
    }

    /**
     * Get the current effective send rate in Hz.
     */
    function getSendRate() {
        return Math.round(1 / nominalFrameTime);
    }
    
    /**
     * Add object to type index
     */
    function addToTypeIndex(obj) {
        const type = obj.data?.type;
        if (!type) return;
        
        if (!typeIndex.has(type)) {
            typeIndex.set(type, new Set());
        }
        typeIndex.get(type).add(obj.id);
    }
    
    /**
     * Remove object from type index
     */
    function removeFromTypeIndex(obj) {
        const type = obj.data?.type;
        if (!type) return;
        
        const typeSet = typeIndex.get(type);
        if (typeSet) {
            typeSet.delete(obj.id);
            if (typeSet.size === 0) {
                typeIndex.delete(type);
            }
        }
    }
    
    /**
     * Update type index when object data changes
     */
    function updateTypeIndex(obj, oldType, newType) {
        if (oldType === newType) return;
        
        // Remove from old type
        if (oldType) {
            const oldSet = typeIndex.get(oldType);
            if (oldSet) {
                oldSet.delete(obj.id);
                if (oldSet.size === 0) {
                    typeIndex.delete(oldType);
                }
            }
        }
        
        // Add to new type
        if (newType) {
            if (!typeIndex.has(newType)) {
                typeIndex.set(newType, new Set());
            }
            typeIndex.get(newType).add(obj.id);
        }
    }

    /**
     * Initialize the object sync module.
     */
    function init() {
        // Register for session client events
        SessionClient.on('onObjectCreated', handleRemoteObjectCreated);
        SessionClient.on('onObjectsUpdated', handleRemoteObjectsUpdated);
        SessionClient.on('onObjectDeleted', handleRemoteObjectDeleted);
        SessionClient.on('onObjectReplaced', handleRemoteObjectReplaced);
        SessionClient.on('onSessionJoined', handleSessionJoined);
        SessionClient.on('onSessionLeft', handleSessionLeft);

        // console.log('[ObjectSync] Initialized');
    }

    // ── Internal helpers ────────────────────────────────────────────────

    /**
     * Reset all sync state to initial values.
     */
    function resetState() {
        objects.clear();
        typeIndex.clear();
        lastSentData.clear();
        pendingUpdates = [];
        frameCounter = 0;
        fullSyncCounter = 0;
        senderSequence = 0;
        memberSequences.clear();
        pendingDeletes.clear();
        reconciling = false;
        reconciliationCount = 0;
        flushInProgress = false;
    }

    /**
     * Suspend reconciliation. Calls compose (counter, not bool). While suspended,
     * triggerReconciliation() is a silent no-op. Used by attemptAutoRejoin to
     * prevent reconciliation from racing with a full rejoin in progress.
     */
    function suspendReconciliation() {
        reconciliationSuspendCount++;
    }

    function resumeReconciliation() {
        if (reconciliationSuspendCount > 0) reconciliationSuspendCount--;
    }

    /**
     * Build a local object representation from server ObjectInfo.
     */
    function toLocalObject(objectInfo) {
        return {
            id: objectInfo.id,
            creatorMemberId: objectInfo.creatorMemberId,
            ownerMemberId: objectInfo.ownerMemberId,
            scope: objectInfo.scope,
            data: objectInfo.data || {},
            version: objectInfo.version
        };
    }

    /**
     * Register an object from server ObjectInfo into the local object map and type index.
     */
    function registerObject(objectInfo) {
        const obj = toLocalObject(objectInfo);
        objects.set(obj.id, obj);
        addToTypeIndex(obj);
        return obj;
    }

    /**
     * Remove an object from the local object map, type index, and delta tracking.
     * Returns the removed object, or null if not found.
     */
    function removeObjectLocal(objectId) {
        const obj = objects.get(objectId);
        if (!obj) return null;
        removeFromTypeIndex(obj);
        objects.delete(objectId);
        lastSentData.delete(objectId);
        return obj;
    }

    /**
     * Track the local member's own sequence from an invoke response.
     * Used by createObject, deleteObject, and flushUpdates which all
     * use OthersInGroup (no broadcast echo for own events).
     */
    function trackOwnMemberSequence(memberSequence) {
        if (!memberSequence || memberSequence <= 0) return;
        const myId = SessionClient.getCurrentMember()?.id;
        if (myId) {
            trackMemberSequence(myId, memberSequence);
        }
    }

    /**
     * Handle session joined - load existing objects.
     *
     * Version-aware: if an object already exists locally with a higher (or equal)
     * version than the snapshot, the snapshot value is ignored. This prevents the
     * snapshot from clobbering a live OnObjectsUpdated broadcast that arrived
     * between the hub's AddToGroupAsync and the snapshot delivery in the JoinSession
     * response. (See SessionHub.JoinSession ordering.)
     */
    function handleSessionJoined(session, member) {
        resetState();

        if (session.objects) {
            for (const obj of session.objects) {
                obj.data = expandData(obj.data);
                const existing = objects.get(obj.id);
                if (existing && existing.version >= obj.version) {
                    // A live broadcast already populated this object at >= this version
                    continue;
                }
                registerObject(obj, false);
            }
        }

        // console.log('[ObjectSync] Loaded', objects.size, 'objects from session');
    }

    /**
     * Handle session left - clear objects.
     */
    function handleSessionLeft() {
        resetState();
        // console.log('[ObjectSync] Cleared all objects');
    }

    /**
     * Handle remote object created.
     */
    function handleRemoteObjectCreated(objectInfo, senderMemberId, memberSequence) {
        trackMemberSequence(senderMemberId, memberSequence);
        objectInfo.data = expandData(objectInfo.data);
        
        const existing = objects.get(objectInfo.id);
        if (existing) {
            // Backfill metadata from creation event (object was pre-created by update fallback)
            existing.creatorMemberId = objectInfo.creatorMemberId;
            existing.ownerMemberId = objectInfo.ownerMemberId;
            existing.scope = objectInfo.scope;
            // Keep existing data/version if already ahead from updates
            if (objectInfo.version > existing.version) {
                existing.data = objectInfo.data || {};
                existing.version = objectInfo.version;
            }
            return;
        }

        const obj = registerObject(objectInfo);

        if (callbacks.onObjectCreated) {
            callbacks.onObjectCreated(obj);
        }
    }

    /**
     * Handle remote objects updated (from other members only — self-echo eliminated).
     */
    function handleRemoteObjectsUpdated(updatedObjects, serverTimestamp, senderMemberId, senderSeq, memberSequence, senderSendIntervalMs) {
        trackMemberSequence(senderMemberId, memberSequence);
        
        // Signal packet arrival (for adaptive delay and latency tracking)
        if (callbacks.onBatchReceived) {
            callbacks.onBatchReceived(serverTimestamp, null, senderSendIntervalMs, senderMemberId);
        }
        // Updates contain only id, data, version (metadata stripped for bandwidth)
        for (const update of updatedObjects) {
            update.data = expandData(update.data);
            const existing = objects.get(update.id);
            if (existing) {
                // Only apply if version is newer
                if (update.version > existing.version) {
                    const oldType = existing.data?.type;
                    Object.assign(existing.data, update.data);
                    existing.version = update.version;
                    
                    // Update type index if type changed (only when type is present in delta)
                    if (update.data?.type !== undefined) {
                        updateTypeIndex(existing, oldType, update.data.type);
                    }

                    if (callbacks.onObjectUpdated) {
                        callbacks.onObjectUpdated(existing);
                    }
                }
            } else {
                // Object not yet known — create with available data
                // (full metadata arrives via OnObjectCreated; this is a fallback)
                const obj = {
                    id: update.id,
                    creatorMemberId: null,
                    ownerMemberId: null,
                    scope: null,
                    data: update.data || {},
                    version: update.version
                };
                objects.set(obj.id, obj);
                addToTypeIndex(obj);

                if (callbacks.onObjectCreated) {
                    callbacks.onObjectCreated(obj);
                }
            }
        }
    }

    /**
     * Handle remote object deleted.
     */
    function handleRemoteObjectDeleted(objectId, senderMemberId, memberSequence) {
        trackMemberSequence(senderMemberId, memberSequence);
        const obj = removeObjectLocal(objectId);
        if (obj && callbacks.onObjectDeleted) {
            callbacks.onObjectDeleted(obj);
        }
    }

    /**
     * Handle remote object replaced (atomic delete + create).
     */
    function handleRemoteObjectReplaced(event, senderMemberId, memberSequence) {
        trackMemberSequence(senderMemberId, memberSequence);
        // Delete the original object (no sequence tracking — already tracked above)
        handleRemoteObjectDeleted(event.deletedObjectId);

        // Create all replacement objects (no sequence tracking — already tracked above)
        for (const objectInfo of event.createdObjects) {
            handleRemoteObjectCreated(objectInfo);
        }

        if (callbacks.onObjectReplaced) {
            callbacks.onObjectReplaced(event.deletedObjectId, event.createdObjects);
        }
    }

    /**
     * Track per-member event sequence and trigger reconciliation on gaps.
     *
     * Gap detection is only performed for OTHER members' streams. The local member's
     * own sequence is tracked (to keep the map current for reconciliation snapshots)
     * but gaps are NOT flagged, for two reasons:
     *
     * 1. Self-echo elimination: UpdateObjects, CreateObject, and DeleteObject all use
     *    OthersInGroup — the sender never receives broadcast echoes for these events.
     *    The sender's own memberSequence is instead tracked from invoke responses
     *    (flushUpdates, createObject, deleteObject). OnObjectReplaced still echoes.
     *
     * 2. Mixed delivery channels: even for OnObjectReplaced (which still uses Group),
     *    the broadcast callback (synchronous) can race with invoke response processing
     *    (await microtask), causing out-of-order sequence values for the sender's own
     *    stream. This would trigger false reconciliations.
     *
     * If a sender's invoke response is lost, their own sequence map entry will be stale.
     * This is harmless because: (a) gap detection is skipped, and (b) the next successful
     * response or reconciliation snapshot will correct it.
     *
     * @param {string} memberId - The member who triggered the event
     * @param {number} memberSequence - The member's monotonic sequence number
     */
    function trackMemberSequence(memberId, memberSequence) {
        if (memberId == null || memberSequence == null) return;
        
        const lastSeq = memberSequences.get(memberId);
        // Only detect gaps for other members' streams
        const myId = SessionClient.getCurrentMember()?.id;
        if (myId !== memberId && lastSeq !== undefined && memberSequence > lastSeq + 1) {
            console.warn('[ObjectSync] Per-member sequence gap:', memberId, 'expected', lastSeq + 1, 'got', memberSequence);
            triggerReconciliation();
        }
        if (lastSeq === undefined || memberSequence > lastSeq) {
            memberSequences.set(memberId, memberSequence);
        }
    }

    // Public alias for external callers (member events tracked from index.html)
    function trackEventSequence(senderMemberId, memberSequence) {
        trackMemberSequence(senderMemberId, memberSequence);
    }

    /**
     * Trigger state reconciliation via GetSessionState.
     */
    async function triggerReconciliation() {
        if (reconciling) return;
        if (reconciliationSuspendCount > 0) return;
        reconciling = true;
        
        try {
            // console.log('[ObjectSync] Reconciling state...');
            const snapshot = await SessionClient.getSessionState();
            if (!snapshot) {
                // Server doesn't recognize this connection as a session member.
                // This happens when auto-reconnect restores the transport but the
                // server already processed the disconnect (member removed).
                // Signal the game to trigger a full rejoin.
                if (callbacks.onReconciliationFailed) {
                    callbacks.onReconciliationFailed();
                }
                return;
            }
            
            // Restore per-member sequences from snapshot
            memberSequences.clear();
            if (snapshot.memberSequences) {
                for (const [memberId, seq] of Object.entries(snapshot.memberSequences)) {
                    memberSequences.set(memberId, seq);
                }
            }
            
            // Build set of server-known object IDs
            const serverObjectIds = new Set();
            for (const obj of (snapshot.objects || [])) {
                serverObjectIds.add(obj.id);
                obj.data = expandData(obj.data);
                
                const existing = objects.get(obj.id);
                if (existing) {
                    // Update ownership and version if server is newer
                    existing.ownerMemberId = obj.ownerMemberId;
                    if (obj.version > existing.version) {
                        const oldType = existing.data?.type;
                        existing.data = obj.data || {};
                        existing.version = obj.version;
                        updateTypeIndex(existing, oldType, existing.data?.type);
                    }
                } else if (pendingDeletes.has(obj.id)) {
                    // Locally deleted but server hasn't processed yet — do NOT
                    // resurrect. The server will broadcast OnObjectDeleted shortly.
                    continue;
                } else {
                    // Add missing object
                    const localObj = registerObject(obj);
                    if (callbacks.onObjectCreated) {
                        callbacks.onObjectCreated(localObj);
                    }
                }
            }
            
            // Remove ghost objects (locally present but not on server).
            // Skip pendingDeletes — they're already gone locally and are about
            // to be confirmed by the server.
            for (const [id, obj] of objects) {
                if (!serverObjectIds.has(id) && !pendingDeletes.has(id)) {
                    removeObjectLocal(id);
                    if (callbacks.onObjectDeleted) {
                        callbacks.onObjectDeleted(obj);
                    }
                }
            }
            
            // console.log('[ObjectSync] Reconciliation complete, objects:', objects.size);
            reconciliationCount++;
            if (callbacks.onReconciliationComplete) {
                callbacks.onReconciliationComplete();
            }
        } catch (err) {
            console.error('[ObjectSync] Reconciliation failed:', err);
            // Treat invoke errors the same as a null snapshot: the connection
            // is broken (e.g. stale WebSocket after mobile background) and the
            // server no longer recognizes us. Fire the failure callback so the
            // game can trigger a full rejoin instead of silently stalling.
            if (callbacks.onReconciliationFailed) {
                callbacks.onReconciliationFailed();
            }
        } finally {
            reconciling = false;
        }
    }

    /**
     * Create a new synchronized object.
     * Response-first: registers the object in the local map from the invoke response.
     * Unlike deleteObject (which is local-first, removing before invoking), createObject
     * cannot pre-register because it needs the server-assigned ID and version.
     * The backend broadcasts OnObjectCreated to OthersInGroup only — the sender does
     * NOT receive its own creation echo. This means the sender's memberSequence for
     * this event is tracked from the response, not the broadcast. If the response is
     * lost, the sender's sequence map will have a gap for their own member ID, but
     * gap detection is skipped for own streams (see trackMemberSequence), so this
     * won't trigger false reconciliation. The stale sequence value will be corrected
     * on the next successful response or reconciliation snapshot.
     * @param {object} data - Object data
     * @param {string} scope - 'Member' or 'Session' (default: 'Member')
     * @param {string} ownerMemberId - Optional owner override
     * @param {function} isStillNeeded - Optional callback checked after async creation;
     *   if it returns false, the server object is auto-deleted (handles race where
     *   the caller destroys the local representation during the server round-trip)
     */
    async function createObject(data = {}, scope = 'Member', ownerMemberId = null, isStillNeeded = null) {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }

        try {
            const response = await SessionClient.createObject(compressData(data), scope, ownerMemberId);
            if (!response || !response.objectInfo) return null;

            const objectInfo = response.objectInfo;
            objectInfo.data = expandData(objectInfo.data);

            // Auto-cleanup: if caller's object was destroyed during async creation
            if (isStillNeeded && !isStillNeeded()) {
                deleteObject(objectInfo.id); // fire-and-forget server cleanup
                return null;
            }

            // Response-first: register the object from the invoke response (no broadcast echo)
            const existing = objects.get(objectInfo.id);
            if (!existing) {
                const obj = registerObject(objectInfo);

                if (callbacks.onObjectCreated) {
                    callbacks.onObjectCreated(obj);
                }
            }

            // Track own member sequence from response (no broadcast echo to track it from)
            trackOwnMemberSequence(response.memberSequence);

            return objectInfo;
        } catch (err) {
            console.error('[ObjectSync] Create object failed:', err);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('create', err);
            }
            throw err;
        }
    }

    /**
     * Atomically replace an object with new objects in a single broadcast.
     */
    async function replaceObject(deleteObjectId, replacements, scope = 'Session', ownerMemberId = null) {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }

        try {
            const compressedReplacements = replacements.map(r => compressData(r));
            const createdInfos = await SessionClient.replaceObject(deleteObjectId, compressedReplacements, scope, ownerMemberId);
            // Objects will be added/removed via the onObjectReplaced event
            return createdInfos;
        } catch (err) {
            console.error('[ObjectSync] Replace object failed:', err);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('replace', err);
            }
            throw err;
        }
    }

    /**
     * Update an object's data locally and queue for sync.
     */
    function updateObject(objectId, data, immediate = false) {
        const obj = objects.get(objectId);
        if (!obj) {
            console.warn('[ObjectSync] Object not found:', objectId);
            return false;
        }

        // Track type changes for index update
        const oldType = obj.data?.type;
        
        // Update local data immediately
        Object.assign(obj.data, data);
        
        // Update type index if type changed
        if (data.type !== undefined) {
            updateTypeIndex(obj, oldType, data.type);
        }

        // Queue for batch sync
        const existingUpdate = pendingUpdates.find(u => u.objectId === objectId);
        if (existingUpdate) {
            Object.assign(existingUpdate.data, data);
        } else {
            pendingUpdates.push({
                objectId: objectId,
                data: { ...data }
            });
        }

        if (immediate) {
            flushUpdates();
        }
        // Otherwise, tick() will flush when frame counter reaches threshold

        return true;
    }

    let fullSyncCounter = 0;
    let flushInProgress = false;

    /**
     * Called once per frame to drive frame-count-based sync.
     * Recalculates the send threshold from the current frame time,
     * increments the frame counter, and flushes when threshold is reached.
     *
     * Backpressure: when flushInProgress the counter caps at sendThreshold
     * instead of resetting. This way the very next tick after the in-flight
     * invoke completes will trigger a flush, preventing the effective send
     * rate from being halved when RTT ≈ nominalFrameTime.
     * @param {number} frameTimeSec - Elapsed time for this frame in seconds
     */
    function tick(frameTimeSec) {
        const clampedFrameTime = Math.max(frameTimeSec, minFrameTime);
        sendThreshold = Math.max(1, Math.round(nominalFrameTime / clampedFrameTime));
        if (frameCounter < sendThreshold) {
            frameCounter++;
        }
        if (frameCounter >= sendThreshold && !flushInProgress) {
            frameCounter = 0;
            flushUpdates();
        }
    }

    /**
     * Compute delta between current data and last-sent data for an object.
     * Returns only the fields that changed, or null if nothing changed.
     * Note: 'type' is NOT included in deltas — it never changes after creation and
     * the backend preserves it in the stored object state. The broadcast to other
     * members forwards the client's delta data as-is, so receivers always
     * have 'type' from the original OnObjectCreated event.
     *
     * IMPORTANT: lastSentData is NOT updated here. It is only updated after the
     * server confirms the batch, so that rejected or failed deltas are re-included
     * in the next flush. See confirmSentDeltas().
     */
    function computeDelta(objectId, data, forceFullSync) {
        const prev = lastSentData.get(objectId);
        if (!prev || forceFullSync) {
            return { ...data };
        }

        const delta = {};
        let hasChanges = false;
        for (const key in data) {
            if (data[key] !== prev[key]) {
                delta[key] = data[key];
                hasChanges = true;
            }
        }

        if (!hasChanges) return null;

        return delta;
    }

    /**
     * Confirm that deltas were accepted by the server for the given object IDs.
     * Updates lastSentData only for confirmed objects so that rejected fields
     * are re-sent on the next flush.
     * @param {Map<string, object>} sentDeltas - Map of objectId → delta data that was sent
     * @param {object} confirmedVersions - Server response versions map (objectId → version)
     */
    function confirmSentDeltas(sentDeltas, confirmedVersions) {
        for (const [objectId, delta] of sentDeltas) {
            if (confirmedVersions[objectId] === undefined) continue;
            const prev = lastSentData.get(objectId);
            if (prev) {
                Object.assign(prev, delta);
            } else {
                lastSentData.set(objectId, { ...delta });
            }
        }
    }

    /**
     * Flush all pending updates to the server.
     * Guarded to prevent overlapping flushes.
     *
     * Delta encoding defers lastSentData updates until the server confirms the batch.
     * On partial success, only confirmed objects update their delta baseline.
     * On complete failure (network error), no baselines are updated, so all
     * changed fields are re-included in the next flush.
     */
    async function flushUpdates() {
        if (pendingUpdates.length === 0) return;
        if (!SessionClient.isInSession()) return;
        if (flushInProgress) return;

        let updates;
        // Track deltas sent per object for deferred confirmation
        let sentDeltas = null;
        if (deltaEncodingEnabled) {
            const forceFullSync = (++fullSyncCounter >= FULL_SYNC_INTERVAL);
            if (forceFullSync) fullSyncCounter = 0;

            updates = [];
            sentDeltas = new Map();
            for (const update of pendingUpdates) {
                const delta = computeDelta(update.objectId, update.data, forceFullSync);
                if (delta) {
                    updates.push({
                        objectId: update.objectId,
                        data: delta
                    });
                    sentDeltas.set(update.objectId, delta);
                }
            }
        } else {
            updates = pendingUpdates.map(update => ({
                objectId: update.objectId,
                data: update.data
            }));
        }
        pendingUpdates = [];

        if (updates.length === 0) return;

        flushInProgress = true;
        const currentSenderSequence = ++senderSequence;
        const clientTimestamp = Date.now();
        // Compress field names for the wire — game logic stays readable
        const wireUpdates = updates.map(u => ({
            objectId: u.objectId,
            data: compressData(u.data)
        }));
        try {
            const response = await SessionClient.updateObjects(wireUpdates, currentSenderSequence, Math.round(nominalFrameTime * 1000));
            // Capture response timestamp immediately — before processing
            // versions or sequences — so RTT reflects only the network
            // round-trip and not client-side processing overhead.
            const responseTimestamp = Date.now();
            if (response) {
                // Apply server-assigned versions to local objects
                if (response.versions) {
                    for (const [id, version] of Object.entries(response.versions)) {
                        const obj = objects.get(id);
                        if (obj && version > obj.version) {
                            obj.version = version;
                        }
                    }
                    // Confirm delta baselines only for objects the server accepted
                    if (sentDeltas) {
                        confirmSentDeltas(sentDeltas, response.versions);
                    }
                }
                // Track own member sequence from response
                trackOwnMemberSequence(response.memberSequence);
                // RTT from request/response round-trip (uses responseTimestamp
                // captured above to exclude local processing from the sample)
                if (response.serverTimestamp && callbacks.onBatchReceived) {
                    callbacks.onBatchReceived(response.serverTimestamp, clientTimestamp, undefined, undefined, responseTimestamp);
                }
            }
            // If response is null/undefined (server returned null), sentDeltas are
            // NOT confirmed — all fields will be re-sent on next flush.
        } catch (err) {
            console.error('[ObjectSync] Batch update failed:', err);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('update', err);
            }
        } finally {
            flushInProgress = false;
        }
    }

    /**
     * Delete an object.
     * Local-first: removes from local state immediately before sending to server.
     * The backend broadcasts OnObjectDeleted to OthersInGroup only — the sender does
     * NOT receive its own deletion echo. Same trade-off as createObject: sender's
     * memberSequence is tracked from the response. See createObject comment for
     * detailed rationale on lost-response recovery.
     *
     * Ownership safety: local-first deletion is safe because ownership only changes
     * via HandleMemberDeparture (member leaving). A member actively deleting objects
     * is not departing, so no concurrent ownership migration can occur. The hub
     * rejects the delete if ownership has changed, but the local Map would already
     * be stale until reconciliation. If voluntary ownership transfer is ever added,
     * this would need a local ownership check before removing, or deferred removal.
     */
    async function deleteObject(objectId) {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }

        // Local-first: remove immediately so getObjectsByType() won't return it
        removeObjectLocal(objectId);
        // Track as pending so an interleaving reconciliation snapshot does not
        // resurrect this object before the server processes the delete.
        pendingDeletes.add(objectId);

        // Also remove from pending updates
        pendingUpdates = pendingUpdates.filter(u => u.objectId !== objectId);

        try {
            const response = await SessionClient.deleteObject(objectId);

            // Track own member sequence from response (no broadcast echo to track it from)
            if (response) {
                trackOwnMemberSequence(response.memberSequence);
            }

            return response?.success ?? false;
        } catch (err) {
            console.warn('[ObjectSync] Server delete failed (local deletion already applied):', objectId, err.message);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('delete', err);
            }
            return false;
        } finally {
            // Whether the server accepted, rejected, or threw, the request has
            // resolved. Any subsequent snapshot reflects the post-resolution state,
            // so we no longer need to suppress this id from reconciliation.
            pendingDeletes.delete(objectId);
        }
    }

    /**
     * Get an object by ID.
     */
    function getObject(objectId) {
        return objects.get(objectId);
    }

    /**
     * Get all objects.
     */
    function getAllObjects() {
        return Array.from(objects.values());
    }

    /**
     * Get objects by owner member ID.
     */
    function getObjectsByOwner(memberId) {
        return getAllObjects().filter(obj => obj.ownerMemberId === memberId);
    }

    /**
     * Get objects by type (from data.type field).
     * Uses type index for O(n) lookup where n = objects of that type, instead of all objects.
     * @param {string} type - The object type to filter by
     * @returns {array} Array of objects with matching type
     */
    function getObjectsByType(type) {
        const typeSet = typeIndex.get(type);
        if (!typeSet || typeSet.size === 0) return [];
        
        const result = [];
        for (const id of typeSet) {
            const obj = objects.get(id);
            if (obj) result.push(obj);
        }
        return result;
    }

    /**
     * Get a single object by type (for singletons like GameState).
     * Uses type index for efficient lookup.
     * @param {string} type - The object type to find
     * @returns {object|null} The first object with matching type, or null
     */
    function getObjectByType(type) {
        const typeSet = typeIndex.get(type);
        if (!typeSet || typeSet.size === 0) return null;
        
        // Get first ID from the set
        const firstId = typeSet.values().next().value;
        return objects.get(firstId) || null;
    }

    /**
     * Register a callback.
     */
    function on(event, callback) {
        if (callbacks.hasOwnProperty(event)) {
            callbacks[event] = callback;
        } else {
            console.warn('[ObjectSync] Unknown event:', event);
        }
    }

    /**
     * Handle ownership migration for objects (called when a member leaves and objects are migrated).
     * Uses server-authoritative version to prevent drift from blind local increments.
     * @param {Array<{objectId: string, newOwnerId: string, newVersion: number}>} migratedObjects - Objects with their new owners and versions
     */
    function handleOwnershipMigration(migratedObjects) {
        for (const migration of migratedObjects) {
            const obj = objects.get(migration.objectId);
            if (obj) {
                obj.ownerMemberId = migration.newOwnerId;
                obj.version = migration.newVersion;
            }
        }
    }

    /**
     * Handle member departure - remove deleted objects from local state.
     * @param {string[]} deletedObjectIds - IDs of objects that were deleted
     */
    function handleMemberDeparture(deletedObjectIds) {
        for (const objectId of deletedObjectIds) {
            const obj = removeObjectLocal(objectId);
            if (obj && callbacks.onObjectDeleted) {
                callbacks.onObjectDeleted(obj);
            }
        }
    }

    /**
     * Get object count.
     */
    function getObjectCount() {
        return objects.size;
    }

    /**
     * Get the reconciliation count for this session.
     */
    function getReconciliationCount() {
        return reconciliationCount;
    }

    /**
     * Clear all local objects (for testing).
     */
    function clear() {
        resetState();
    }

    // Public API
    return {
        init,
        createObject,
        replaceObject,
        updateObject,
        deleteObject,
        flushUpdates,
        tick,
        getObject,
        getAllObjects,
        getObjectsByOwner,
        getObjectsByType,
        getObjectByType,
        getObjectCount,
        getReconciliationCount,
        configure,
        getSendRate,
        updateSendRate,
        triggerReconciliation,
        suspendReconciliation,
        resumeReconciliation,
        handleOwnershipMigration,
        handleMemberDeparture,
        trackEventSequence,
        isReconciling: () => reconciling,
        on,
        clear
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ObjectSync;
}
