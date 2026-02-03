/**
 * Object Sync Module
 * Handles local object registry and synchronization with the session.
 */

const ObjectSync = (function() {
    // Local object registry
    const objects = new Map();
    
    // Pending updates to be batched
    let pendingUpdates = [];
    let updateTimer = null;
    const batchInterval = 50; // ms - batch updates every 50ms (20 updates/sec max)

    // Callbacks
    const callbacks = {
        onObjectCreated: null,
        onObjectUpdated: null,
        onObjectDeleted: null,
        onSyncError: null
    };

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
        SessionClient.on('onRoleChanged', handleRoleChanged);

        console.log('[ObjectSync] Initialized');
    }

    /**
     * Handle session joined - load existing objects.
     */
    function handleSessionJoined(session, member) {
        objects.clear();
        pendingUpdates = [];

        if (session.objects) {
            for (const obj of session.objects) {
                objects.set(obj.id, {
                    id: obj.id,
                    creatorMemberId: obj.creatorMemberId,
                    affiliatedRole: obj.affiliatedRole,
                    data: obj.data || {},
                    version: obj.version,
                    isLocal: false
                });
            }
        }

        console.log('[ObjectSync] Loaded', objects.size, 'objects from session');
    }

    /**
     * Handle session left - clear objects.
     */
    function handleSessionLeft() {
        objects.clear();
        pendingUpdates = [];
        if (updateTimer) {
            clearTimeout(updateTimer);
            updateTimer = null;
        }
        console.log('[ObjectSync] Cleared all objects');
    }

    /**
     * Handle role changed - update object affiliations.
     */
    function handleRoleChanged(newRole, affectedObjectIds) {
        for (const objectId of affectedObjectIds) {
            const obj = objects.get(objectId);
            if (obj) {
                obj.affiliatedRole = newRole;
            }
        }
        console.log('[ObjectSync] Updated affiliations for', affectedObjectIds.length, 'objects');
    }

    /**
     * Handle remote object created.
     */
    function handleRemoteObjectCreated(objectInfo) {
        const obj = {
            id: objectInfo.id,
            creatorMemberId: objectInfo.creatorMemberId,
            affiliatedRole: objectInfo.affiliatedRole,
            data: objectInfo.data || {},
            version: objectInfo.version,
            isLocal: objectInfo.creatorMemberId === SessionClient.getCurrentMember()?.id
        };

        objects.set(obj.id, obj);

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
                    existing.data = update.data;
                    existing.version = update.version;
                    existing.affiliatedRole = update.affiliatedRole;

                    if (callbacks.onObjectUpdated) {
                        callbacks.onObjectUpdated(existing);
                    }
                }
            } else {
                // Object doesn't exist locally, add it
                const obj = {
                    id: update.id,
                    creatorMemberId: update.creatorMemberId,
                    affiliatedRole: update.affiliatedRole,
                    data: update.data || {},
                    version: update.version,
                    isLocal: false
                };
                objects.set(obj.id, obj);

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
            objects.delete(objectId);

            if (callbacks.onObjectDeleted) {
                callbacks.onObjectDeleted(obj);
            }
        }
    }

    /**
     * Create a new synchronized object.
     */
    async function createObject(data = {}) {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }

        try {
            const objectInfo = await SessionClient.createObject(data);
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

        // Update local data immediately
        Object.assign(obj.data, data);

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
        } else {
            scheduleBatchUpdate();
        }

        return true;
    }

    /**
     * Schedule a batch update.
     */
    function scheduleBatchUpdate() {
        if (updateTimer) return;

        updateTimer = setTimeout(() => {
            updateTimer = null;
            flushUpdates();
        }, batchInterval);
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
     */
    async function deleteObject(objectId) {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }

        try {
            const success = await SessionClient.deleteObject(objectId);
            // Object will be removed via the onObjectDeleted event
            return success;
        } catch (err) {
            console.error('[ObjectSync] Delete object failed:', err);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('delete', err);
            }
            throw err;
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
     * Get objects by affiliation.
     */
    function getObjectsByRole(role) {
        return getAllObjects().filter(obj => obj.affiliatedRole === role);
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
        pendingUpdates = [];
    }

    // Public API
    return {
        init,
        createObject,
        updateObject,
        deleteObject,
        flushUpdates,
        getObject,
        getAllObjects,
        getObjectsByRole,
        getLocalObjects,
        getObjectCount,
        on,
        clear
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ObjectSync;
}
