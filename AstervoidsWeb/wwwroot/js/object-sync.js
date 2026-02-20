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
    
    // Frame-count-based sync settings
    let nominalFrameTime = 1 / 30;  // target send interval in seconds
    let minFrameTime = 1 / 480;     // clamp to prevent extreme thresholds
    let frameCounter = 0;
    let sendThreshold = 2;          // recalculated each frame from actual frame time

    // Callbacks
    const callbacks = {
        onObjectCreated: null,
        onObjectUpdated: null,
        onObjectDeleted: null,
        onSyncError: null
    };
    
    /**
     * Configure sync timing parameters.
     * @param {object} config - { nominalFrameTime, minFrameTime }
     */
    function configure(config) {
        if (config.nominalFrameTime !== undefined) {
            nominalFrameTime = config.nominalFrameTime;
        }
        if (config.minFrameTime !== undefined) {
            minFrameTime = config.minFrameTime;
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

        console.log('[ObjectSync] Loaded', objects.size, 'objects from session');
    }

    /**
     * Handle session left - clear objects.
     */
    function handleSessionLeft() {
        objects.clear();
        typeIndex.clear();
        pendingUpdates = [];
        frameCounter = 0;
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
    function handleRemoteObjectCreated(objectInfo) {
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
     */
    function handleRemoteObjectsUpdated(updatedObjects) {
        for (const update of updatedObjects) {
            const existing = objects.get(update.id);
            if (existing) {
                // Only apply if version is newer
                if (update.version > existing.version) {
                    const oldType = existing.data?.type;
                    existing.data = update.data;
                    existing.version = update.version;
                    existing.ownerMemberId = update.ownerMemberId;
                    
                    // Update type index if type changed
                    updateTypeIndex(existing, oldType, update.data?.type);

                    if (callbacks.onObjectUpdated) {
                        callbacks.onObjectUpdated(existing);
                    }
                }
            } else {
                // Object doesn't exist locally, add it
                const obj = {
                    id: update.id,
                    creatorMemberId: update.creatorMemberId,
                    ownerMemberId: update.ownerMemberId,
                    scope: update.scope,
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
    function handleRemoteObjectDeleted(objectId) {
        const obj = objects.get(objectId);
        if (obj) {
            removeFromTypeIndex(obj);
            objects.delete(objectId);

            if (callbacks.onObjectDeleted) {
                callbacks.onObjectDeleted(obj);
            }
        }
    }

    /**
     * Create a new synchronized object.
     * @param {object} data - Object data
     * @param {string} scope - 'Member' or 'Session' (default: 'Member')
     */
    async function createObject(data = {}, scope = 'Member') {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }

        try {
            const objectInfo = await SessionClient.createObject(data, scope);
            // Object will be added via the onObjectCreated event
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
                data: { ...data },
                expectedVersion: obj.version
            });
        }

        if (immediate) {
            flushUpdates();
        }
        // Otherwise, tick() will flush when frame counter reaches threshold

        return true;
    }

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
     * Flush all pending updates to the server.
     */
    async function flushUpdates() {
        if (pendingUpdates.length === 0) return;
        if (!SessionClient.isInSession()) return;

        const updates = pendingUpdates;
        pendingUpdates = [];

        try {
            await SessionClient.updateObjects(updates);
        } catch (err) {
            console.error('[ObjectSync] Batch update failed:', err);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('update', err);
            }
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
     * Clear all local objects (for testing).
     */
    function clear() {
        objects.clear();
        typeIndex.clear();
        pendingUpdates = [];
    }

    // Public API
    return {
        init,
        createObject,
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
        configure,
        getSendThreshold,
        handleOwnershipMigration,
        handleMemberDeparture,
        handleRoleChanged,
        on,
        clear
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ObjectSync;
}
