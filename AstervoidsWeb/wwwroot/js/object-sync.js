/**
 * Object Sync Module
 * Handles local object registry and synchronization with the session.
 */

const ObjectSync = (function() {
    // Local object registry
    const objects = new Map();
    
    // Type index for faster lookups - maps type string to Set of object IDs
    const typeIndex = new Map();
    
    // Pending updates to be batched
    let pendingUpdates = [];
    
    // Sender sequence counter (incremented per flush)
    let senderSequence = 0;
    
    // Event sequence tracking for gap detection
    let lastEventSequence = 0;
    let reconciling = false;
    let reconciliationCount = 0;
    
    // Delta encoding: track last-sent data per object to only send changes
    const lastSentData = new Map();
    let deltaEncodingEnabled = false;
    
    // Full-state sync interval (frames at nominal rate)
    const FULL_SYNC_INTERVAL = 60;
    
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
        onSyncError: null
    };
    
    /**
     * Configure sync timing parameters.
     * @param {object} config - { nominalFrameTime, minFrameTime }
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
    }
    
    /**
     * Get the current send threshold (for diagnostics).
     * @returns {number} Current frame-count threshold
     */
    function getSendThreshold() {
        return sendThreshold;
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

        console.log('[ObjectSync] Initialized');
    }

    /**
     * Handle session joined - load existing objects.
     */
    function handleSessionJoined(session, member) {
        objects.clear();
        typeIndex.clear();
        pendingUpdates = [];
        frameCounter = 0;
        senderSequence = 0;
        lastEventSequence = session.eventSequence || 0;
        reconciling = false;
        reconciliationCount = 0;

        if (session.objects) {
            for (const obj of session.objects) {
                const localObj = {
                    id: obj.id,
                    creatorMemberId: obj.creatorMemberId,
                    ownerMemberId: obj.ownerMemberId,
                    scope: obj.scope,
                    data: obj.data || {},
                    version: obj.version,
                    isLocal: false
                };
                objects.set(obj.id, localObj);
                addToTypeIndex(localObj);
            }
        }

        console.log('[ObjectSync] Loaded', objects.size, 'objects from session, eventSequence:', lastEventSequence);
    }

    /**
     * Handle session left - clear objects.
     */
    function handleSessionLeft() {
        objects.clear();
        typeIndex.clear();
        pendingUpdates = [];
        frameCounter = 0;
        senderSequence = 0;
        lastEventSequence = 0;
        reconciling = false;
        flushInProgress = false;
        console.log('[ObjectSync] Cleared all objects');
    }

    /**
     * Handle role changed - update ownership for migrated objects.
     */
    function handleRoleChanged(newRole) {
        console.log('[ObjectSync] Role changed to', newRole);
    }

    /**
     * Handle remote object created.
     */
    function handleRemoteObjectCreated(objectInfo, eventSequence) {
        trackEventSequence(eventSequence);
        
        const existing = objects.get(objectInfo.id);
        if (existing) {
            // Backfill metadata from creation event (object was pre-created by update fallback)
            existing.creatorMemberId = objectInfo.creatorMemberId;
            existing.ownerMemberId = objectInfo.ownerMemberId;
            existing.scope = objectInfo.scope;
            existing.isLocal = objectInfo.creatorMemberId === SessionClient.getCurrentMember()?.id;
            // Keep existing data/version if already ahead from updates
            if (objectInfo.version > existing.version) {
                existing.data = objectInfo.data || {};
                existing.version = objectInfo.version;
            }
            return;
        }

        const obj = {
            id: objectInfo.id,
            creatorMemberId: objectInfo.creatorMemberId,
            ownerMemberId: objectInfo.ownerMemberId,
            scope: objectInfo.scope,
            data: objectInfo.data || {},
            version: objectInfo.version,
            isLocal: objectInfo.creatorMemberId === SessionClient.getCurrentMember()?.id
        };

        objects.set(obj.id, obj);
        addToTypeIndex(obj);

        if (callbacks.onObjectCreated) {
            callbacks.onObjectCreated(obj);
        }
    }

    /**
     * Handle remote objects updated.
     * When isSelfEcho is true, only update versions (not data) for locally-owned objects
     * to avoid overwriting fresh local state with stale echoed data.
     */
    function handleRemoteObjectsUpdated(updatedObjects, serverTimestamp, senderMemberId, clientTimestamp, isSelfEcho, senderSeq, eventSequence) {
        trackEventSequence(eventSequence);
        
        // Signal packet arrival (for adaptive delay and latency tracking)
        if (callbacks.onBatchReceived) {
            callbacks.onBatchReceived(serverTimestamp, clientTimestamp);
        }
        // Updates contain only id, data, version (metadata stripped for bandwidth)
        const currentMemberId = isSelfEcho ? SessionClient.getCurrentMember()?.id : null;
        for (const update of updatedObjects) {
            const existing = objects.get(update.id);
            if (existing) {
                // Only apply if version is newer
                if (update.version > existing.version) {
                    // Skip data overwrite for our own objects echoed back from server
                    if (isSelfEcho && existing.ownerMemberId === currentMemberId) {
                        existing.version = update.version;
                        continue;
                    }
                    const oldType = existing.data?.type;
                    Object.assign(existing.data, update.data);
                    existing.version = update.version;
                    
                    // Update type index if type changed
                    updateTypeIndex(existing, oldType, update.data?.type);

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
                    version: update.version,
                    isLocal: false
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
    function handleRemoteObjectDeleted(objectId, eventSequence) {
        trackEventSequence(eventSequence);
        const obj = objects.get(objectId);
        if (obj) {
            removeFromTypeIndex(obj);
            objects.delete(objectId);
            lastSentData.delete(objectId);

            if (callbacks.onObjectDeleted) {
                callbacks.onObjectDeleted(obj);
            }
        }
    }

    /**
     * Handle remote object replaced (atomic delete + create).
     */
    function handleRemoteObjectReplaced(event, eventSequence) {
        trackEventSequence(eventSequence);
        // Delete the original object
        handleRemoteObjectDeleted(event.deletedObjectId);

        // Create all replacement objects
        for (const objectInfo of event.createdObjects) {
            handleRemoteObjectCreated(objectInfo);
        }

        if (callbacks.onObjectReplaced) {
            callbacks.onObjectReplaced(event.deletedObjectId, event.createdObjects);
        }
    }

    /**
     * Track event sequence and trigger reconciliation on gaps.
     */
    function trackEventSequence(eventSequence) {
        if (eventSequence == null) return;
        
        if (lastEventSequence > 0 && eventSequence > lastEventSequence + 1) {
            console.warn('[ObjectSync] Event sequence gap: expected', lastEventSequence + 1, 'got', eventSequence);
            triggerReconciliation();
        }
        if (eventSequence > lastEventSequence) {
            lastEventSequence = eventSequence;
        }
    }

    /**
     * Trigger state reconciliation via GetSessionState.
     */
    async function triggerReconciliation() {
        if (reconciling) return;
        reconciling = true;
        
        try {
            console.log('[ObjectSync] Reconciling state...');
            const snapshot = await SessionClient.getSessionState();
            if (!snapshot) return;
            
            lastEventSequence = snapshot.eventSequence || 0;
            
            // Build set of server-known object IDs
            const serverObjectIds = new Set();
            for (const obj of (snapshot.objects || [])) {
                serverObjectIds.add(obj.id);
                
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
                } else {
                    // Add missing object
                    const localObj = {
                        id: obj.id,
                        creatorMemberId: obj.creatorMemberId,
                        ownerMemberId: obj.ownerMemberId,
                        scope: obj.scope,
                        data: obj.data || {},
                        version: obj.version,
                        isLocal: false
                    };
                    objects.set(obj.id, localObj);
                    addToTypeIndex(localObj);
                    if (callbacks.onObjectCreated) {
                        callbacks.onObjectCreated(localObj);
                    }
                }
            }
            
            // Remove ghost objects (locally present but not on server)
            for (const [id, obj] of objects) {
                if (!serverObjectIds.has(id)) {
                    removeFromTypeIndex(obj);
                    objects.delete(id);
                    lastSentData.delete(id);
                    if (callbacks.onObjectDeleted) {
                        callbacks.onObjectDeleted(obj);
                    }
                }
            }
            
            console.log('[ObjectSync] Reconciliation complete, objects:', objects.size);
            reconciliationCount++;
        } catch (err) {
            console.error('[ObjectSync] Reconciliation failed:', err);
        } finally {
            reconciling = false;
        }
    }

    /**
     * Create a new synchronized object.
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
            const objectInfo = await SessionClient.createObject(data, scope, ownerMemberId);
            // Auto-cleanup: if caller's object was destroyed during async creation
            if (isStillNeeded && !isStillNeeded()) {
                deleteObject(objectInfo.id); // fire-and-forget server cleanup
                return null;
            }
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
            const createdInfos = await SessionClient.replaceObject(deleteObjectId, replacements, scope, ownerMemberId);
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

        // Queue for batch sync (expectedVersion resolved at flush time, not here)
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
     * @param {number} frameTimeSec - Elapsed time for this frame in seconds
     */
    function tick(frameTimeSec) {
        const clampedFrameTime = Math.max(frameTimeSec, minFrameTime);
        sendThreshold = Math.max(1, Math.round(nominalFrameTime / clampedFrameTime));
        frameCounter++;
        if (frameCounter >= sendThreshold) {
            frameCounter = 0;
            flushUpdates();
        }
    }

    /**
     * Compute delta between current data and last-sent data for an object.
     * Returns only the fields that changed, or null if nothing changed.
     * Always includes 'type' for receiver-side identification.
     */
    function computeDelta(objectId, data, forceFullSync) {
        const prev = lastSentData.get(objectId);
        if (!prev || forceFullSync) {
            lastSentData.set(objectId, { ...data });
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

        // Always include type for receiver identification
        if (data.type !== undefined) delta.type = data.type;
        Object.assign(prev, delta);
        return delta;
    }

    /**
     * Flush all pending updates to the server.
     * Resolves expectedVersion at flush time from current object state to avoid
     * stale versions from queue-time capture. Guarded to prevent overlapping flushes.
     */
    async function flushUpdates() {
        if (pendingUpdates.length === 0) return;
        if (!SessionClient.isInSession()) return;
        if (flushInProgress) return;

        let updates;
        if (deltaEncodingEnabled) {
            const forceFullSync = (++fullSyncCounter >= FULL_SYNC_INTERVAL);
            if (forceFullSync) fullSyncCounter = 0;

            updates = [];
            for (const update of pendingUpdates) {
                const delta = computeDelta(update.objectId, update.data, forceFullSync);
                if (delta) {
                    const obj = objects.get(update.objectId);
                    updates.push({
                        objectId: update.objectId,
                        data: delta,
                        expectedVersion: obj ? obj.version : undefined
                    });
                }
            }
        } else {
            updates = pendingUpdates.map(update => {
                const obj = objects.get(update.objectId);
                return {
                    objectId: update.objectId,
                    data: update.data,
                    expectedVersion: obj ? obj.version : undefined
                };
            });
        }
        pendingUpdates = [];

        if (updates.length === 0) return;

        flushInProgress = true;
        const currentSenderSequence = ++senderSequence;
        try {
            await SessionClient.updateObjects(updates, currentSenderSequence);
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
     * Removes from local state immediately (local-first) before sending to server.
     */
    async function deleteObject(objectId) {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }

        // Local-first: remove immediately so getObjectsByType() won't return it
        const obj = objects.get(objectId);
        if (obj) {
            removeFromTypeIndex(obj);
            objects.delete(objectId);
            lastSentData.delete(objectId);
        }

        // Also remove from pending updates
        pendingUpdates = pendingUpdates.filter(u => u.objectId !== objectId);

        try {
            const success = await SessionClient.deleteObject(objectId);
            return success;
        } catch (err) {
            console.warn('[ObjectSync] Server delete failed (local deletion already applied):', objectId, err.message);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('delete', err);
            }
            return false;
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
     * Get objects created by the local member.
     */
    function getLocalObjects() {
        const memberId = SessionClient.getCurrentMember()?.id;
        if (!memberId) return [];
        return getAllObjects().filter(obj => obj.creatorMemberId === memberId);
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
     * @param {Array<{objectId: string, newOwnerId: string}>} migratedObjects - Objects with their new owners
     */
    function handleOwnershipMigration(migratedObjects) {
        for (const migration of migratedObjects) {
            const obj = objects.get(migration.objectId);
            if (obj) {
                obj.ownerMemberId = migration.newOwnerId;
                obj.version++;
            }
        }
    }

    /**
     * Handle member departure - remove deleted objects from local state.
     * @param {string[]} deletedObjectIds - IDs of objects that were deleted
     */
    function handleMemberDeparture(deletedObjectIds) {
        for (const objectId of deletedObjectIds) {
            const obj = objects.get(objectId);
            if (obj) {
                removeFromTypeIndex(obj);
                objects.delete(objectId);
                lastSentData.delete(objectId);

                if (callbacks.onObjectDeleted) {
                    callbacks.onObjectDeleted(obj);
                }
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
        objects.clear();
        typeIndex.clear();
        lastSentData.clear();
        pendingUpdates = [];
        fullSyncCounter = 0;
        senderSequence = 0;
        lastEventSequence = 0;
        reconciling = false;
        flushInProgress = false;
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
        getLocalObjects,
        getObjectsByType,
        getObjectByType,
        getObjectCount,
        getReconciliationCount,
        configure,
        getSendThreshold,
        getSendRate,
        updateSendRate,
        handleOwnershipMigration,
        handleMemberDeparture,
        handleRoleChanged,
        trackEventSequence,
        on,
        clear
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ObjectSync;
}
