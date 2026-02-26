/**
 * Session Client Module
 * Handles SignalR connection and session management communication.
 */

const SessionClient = (function() {
    let connection = null;
    let currentSession = null;
    let currentMember = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const baseReconnectDelay = 1000;

    // Event callbacks
    const callbacks = {
        onConnected: null,
        onDisconnected: null,
        onSessionCreated: null,
        onSessionJoined: null,
        onSessionLeft: null,
        onMemberJoined: null,
        onMemberLeft: null,
        onRoleChanged: null,
        onObjectCreated: null,
        onObjectsUpdated: null,
        onObjectDeleted: null,
        onObjectReplaced: null,
        onSessionsChanged: null,
        onError: null
    };

    /**
     * Initialize the SignalR connection.
     */
    async function connect() {
        if (connection && connection.state === signalR.HubConnectionState.Connected) {
            console.log('[SessionClient] Already connected');
            return true;
        }

        try {
            connection = new signalR.HubConnectionBuilder()
                .withUrl('/sessionHub')
                .withAutomaticReconnect({
                    nextRetryDelayInMilliseconds: retryContext => {
                        if (retryContext.previousRetryCount >= maxReconnectAttempts) {
                            return null; // Stop retrying
                        }
                        return Math.min(baseReconnectDelay * Math.pow(2, retryContext.previousRetryCount), 30000);
                    }
                })
                .configureLogging(signalR.LogLevel.Information)
                .build();

            // Register event handlers
            setupEventHandlers();

            await connection.start();
            console.log('[SessionClient] Connected to session hub');
            reconnectAttempts = 0;

            if (callbacks.onConnected) {
                callbacks.onConnected();
            }

            return true;
        } catch (err) {
            console.error('[SessionClient] Connection failed:', err);
            if (callbacks.onError) {
                callbacks.onError('Connection failed: ' + err.message);
            }
            return false;
        }
    }

    /**
     * Disconnect from the SignalR hub.
     */
    async function disconnect() {
        if (connection) {
            try {
                await connection.stop();
                console.log('[SessionClient] Disconnected');
            } catch (err) {
                console.error('[SessionClient] Disconnect error:', err);
            }
            connection = null;
            currentSession = null;
            currentMember = null;
        }
    }

    /**
     * Setup SignalR event handlers.
     */
    function setupEventHandlers() {
        connection.onreconnecting(error => {
            console.log('[SessionClient] Reconnecting...', error);
        });

        connection.onreconnected(connectionId => {
            console.log('[SessionClient] Reconnected:', connectionId);
            reconnectAttempts = 0;
            // Reconcile state — invoke responses for Create/Delete/Update may have been
            // lost during the reconnection window (OthersInGroup means no broadcast fallback)
            ObjectSync.triggerReconciliation();
            if (callbacks.onConnected) {
                callbacks.onConnected();
            }
        });

        connection.onclose(error => {
            console.log('[SessionClient] Connection closed:', error);
            currentSession = null;
            currentMember = null;
            if (callbacks.onDisconnected) {
                callbacks.onDisconnected(error);
            }
        });

        // Session events
        connection.on('OnMemberJoined', (memberInfo, senderMemberId, memberSequence, serverTimestamp) => {
            console.log('[SessionClient] Member joined:', memberInfo);
            // Add member to local session state
            if (currentSession && currentSession.members) {
                currentSession.members.push(memberInfo);
            }
            if (callbacks.onMemberJoined) {
                callbacks.onMemberJoined(memberInfo, senderMemberId, memberSequence);
            }
        });

        connection.on('OnMemberLeft', (info, senderMemberId, memberSequence, serverTimestamp) => {
            console.log('[SessionClient] Member left:', info);
            
            // Remove member from local session state
            if (currentSession && currentSession.members) {
                currentSession.members = currentSession.members.filter(m => m.id !== info.memberId);
            }

            // Handle object cleanup/migration FIRST (before role change, so promoted member sees correct ownership)
            if (callbacks.onMemberLeft) {
                callbacks.onMemberLeft(info, senderMemberId, memberSequence);
            }

            // Check if we were promoted (after migration so ownership is correct for handleServerPromotion)
            if (info.promotedMemberId && currentMember && 
                info.promotedMemberId === currentMember.id) {
                currentMember.role = info.promotedRole;
                // Update local member in session members list
                if (currentSession && currentSession.members) {
                    const self = currentSession.members.find(m => m.id === currentMember.id);
                    if (self) {
                        self.role = info.promotedRole;
                    }
                }
                if (callbacks.onRoleChanged) {
                    callbacks.onRoleChanged(info.promotedRole);
                }
            }
        });

        // Object events
        connection.on('OnObjectCreated', (objectInfo, senderMemberId, memberSequence, serverTimestamp) => {
            if (callbacks.onObjectCreated) {
                callbacks.onObjectCreated(objectInfo, senderMemberId, memberSequence);
            }
        });

        connection.on('OnObjectsUpdated', (objects, senderMemberId, senderSequence, memberSequence, serverTimestamp, clientTimestamp) => {
            if (callbacks.onObjectsUpdated) {
                callbacks.onObjectsUpdated(objects, serverTimestamp, senderMemberId, senderSequence, memberSequence);
            }
        });

        connection.on('OnObjectDeleted', (objectId, senderMemberId, memberSequence, serverTimestamp) => {
            if (callbacks.onObjectDeleted) {
                callbacks.onObjectDeleted(objectId, senderMemberId, memberSequence);
            }
        });

        connection.on('OnObjectReplaced', (event, senderMemberId, memberSequence, serverTimestamp) => {
            if (callbacks.onObjectReplaced) {
                callbacks.onObjectReplaced(event, senderMemberId, memberSequence);
            }
        });

        // Session list changed (signal only - fetch data separately)
        connection.on('OnSessionsChanged', () => {
            console.log('[SessionClient] Sessions changed signal received');
            if (callbacks.onSessionsChanged) {
                callbacks.onSessionsChanged();
            }
        });
    }

    /**
     * Create a new session.
     * @param {number} aspectRatio - The aspect ratio (width/height) to lock for this session.
     */
    async function createSession(aspectRatio) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }

        try {
            const response = await connection.invoke('CreateSession', aspectRatio);
            if (!response) {
                console.log('[SessionClient] CreateSession failed - server at capacity');
                return null;
            }
            
            currentMember = {
                id: response.memberId,
                role: response.role,
                joinedAt: new Date().toISOString()
            };
            currentSession = {
                id: response.sessionId,
                name: response.sessionName,
                members: [currentMember],
                objects: [],
                aspectRatio: response.aspectRatio
            };

            console.log('[SessionClient] Session created:', currentSession.name, 'aspectRatio:', currentSession.aspectRatio);

            if (callbacks.onSessionCreated) {
                callbacks.onSessionCreated(currentSession, currentMember);
            }

            return { session: currentSession, member: currentMember };
        } catch (err) {
            console.error('[SessionClient] Create session failed:', err);
            if (callbacks.onError) {
                callbacks.onError('Failed to create session: ' + err.message);
            }
            throw err;
        }
    }

    /**
     * Join an existing session.
     */
    async function joinSession(sessionId) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }

        try {
            const response = await connection.invoke('JoinSession', sessionId);
            if (!response) {
                console.log('[SessionClient] JoinSession failed - session full or already in a session');
                return null;
            }

            currentSession = {
                id: response.sessionId,
                name: response.sessionName,
                members: response.members,
                objects: response.objects,
                aspectRatio: response.aspectRatio
            };
            currentMember = {
                id: response.memberId,
                role: response.role
            };

            console.log('[SessionClient] Joined session:', currentSession.name, 'aspectRatio:', currentSession.aspectRatio);

            if (callbacks.onSessionJoined) {
                callbacks.onSessionJoined(currentSession, currentMember);
            }

            return { session: currentSession, member: currentMember };
        } catch (err) {
            console.error('[SessionClient] Join session failed:', err);
            if (callbacks.onError) {
                callbacks.onError('Failed to join session: ' + err.message);
            }
            throw err;
        }
    }

    /**
     * Leave the current session.
     */
    async function leaveSession() {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            return;
        }

        try {
            await connection.invoke('LeaveSession');
            const leftSession = currentSession;
            currentSession = null;
            currentMember = null;

            console.log('[SessionClient] Left session');

            if (callbacks.onSessionLeft) {
                callbacks.onSessionLeft(leftSession);
            }
        } catch (err) {
            console.error('[SessionClient] Leave session failed:', err);
        }
    }

    /**
     * Get list of active sessions.
     */
    async function getActiveSessions() {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }

        try {
            const response = await connection.invoke('GetActiveSessions');
            return {
                sessions: response.sessions || [],
                maxSessions: response.maxSessions,
                canCreateSession: response.canCreateSession
            };
        } catch (err) {
            console.error('[SessionClient] Get sessions failed:', err);
            throw err;
        }
    }

    /**
     * Create an object in the current session.
     * @param {object} data - Object data
     * @param {string} scope - 'Member' or 'Session'
     */
    async function createObject(data, scope = 'Member', ownerMemberId = null) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }
        if (!currentSession) {
            throw new Error('Not in a session');
        }

        try {
            return await connection.invoke('CreateObject', data, scope, ownerMemberId);
        } catch (err) {
            console.error('[SessionClient] Create object failed:', err);
            throw err;
        }
    }

    /**
     * Update multiple objects atomically.
     */
    async function updateObjects(updates, senderSequence = null) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }
        if (!currentSession) {
            throw new Error('Not in a session');
        }

        try {
            const response = await connection.invoke('UpdateObjects', updates, senderSequence, Date.now());
            return response;
        } catch (err) {
            console.error('[SessionClient] Update objects failed:', err);
            throw err;
        }
    }

    /**
     * Atomically delete an object and create replacements in a single broadcast.
     */
    async function replaceObject(deleteObjectId, replacements, scope = 'Session', ownerMemberId = null) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }
        if (!currentSession) {
            throw new Error('Not in a session');
        }

        try {
            return await connection.invoke('ReplaceObject', deleteObjectId, replacements, scope, ownerMemberId);
        } catch (err) {
            console.error('[SessionClient] Replace object failed:', err);
            throw err;
        }
    }

    /**
     * Delete an object from the session.
     */
    async function deleteObject(objectId) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }
        if (!currentSession) {
            throw new Error('Not in a session');
        }

        try {
            return await connection.invoke('DeleteObject', objectId);
        } catch (err) {
            console.error('[SessionClient] Delete object failed:', err);
            throw err;
        }
    }

    async function getSessionState() {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }
        if (!currentSession) {
            throw new Error('Not in a session');
        }
        try {
            return await connection.invoke('GetSessionState');
        } catch (err) {
            console.error('[SessionClient] GetSessionState failed:', err);
            throw err;
        }
    }

    /**
     * Register event callbacks.
     */
    function on(event, callback) {
        if (callbacks.hasOwnProperty(event)) {
            callbacks[event] = callback;
        } else {
            console.warn('[SessionClient] Unknown event:', event);
        }
    }

    /**
     * Get current session info.
     */
    function getCurrentSession() {
        return currentSession;
    }

    /**
     * Get current member info.
     */
    function getCurrentMember() {
        return currentMember;
    }

    /**
     * Check if connected.
     */
    function isConnected() {
        return connection && connection.state === signalR.HubConnectionState.Connected;
    }

    /**
     * Check if in a session.
     */
    function isInSession() {
        return currentSession !== null;
    }

    // Public API
    return {
        connect,
        disconnect,
        createSession,
        joinSession,
        leaveSession,
        getActiveSessions,
        createObject,
        updateObjects,
        replaceObject,
        deleteObject,
        getSessionState,
        on,
        getCurrentSession,
        getCurrentMember,
        isConnected,
        isInSession
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionClient;
}
