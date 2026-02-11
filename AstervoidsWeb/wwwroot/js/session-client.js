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
        onSessionsChanged: null,
        onGameStarted: null,
        onBulletHitReported: null,
        onBulletHitConfirmed: null,
        onBulletHitRejected: null,
        onShipHitReported: null,
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
        connection.on('OnMemberJoined', (memberInfo) => {
            console.log('[SessionClient] Member joined:', memberInfo);
            // Add member to local session state
            if (currentSession && currentSession.members) {
                currentSession.members.push(memberInfo);
            }
            if (callbacks.onMemberJoined) {
                callbacks.onMemberJoined(memberInfo);
            }
        });

        connection.on('OnMemberLeft', (info) => {
            console.log('[SessionClient] Member left:', info);
            
            // Remove member from local session state
            if (currentSession && currentSession.members) {
                currentSession.members = currentSession.members.filter(m => m.id !== info.memberId);
            }

            // Check if we were promoted
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
                    callbacks.onRoleChanged(info.promotedRole, info.migratedObjectIds || []);
                }
            }

            if (callbacks.onMemberLeft) {
                callbacks.onMemberLeft(info);
            }
        });

        // Object events
        connection.on('OnObjectCreated', (objectInfo) => {
            console.log('[SessionClient] Object created:', objectInfo);
            if (callbacks.onObjectCreated) {
                callbacks.onObjectCreated(objectInfo);
            }
        });

        connection.on('OnObjectsUpdated', (objects) => {
            console.log('[SessionClient] Objects updated:', objects.length);
            if (callbacks.onObjectsUpdated) {
                callbacks.onObjectsUpdated(objects);
            }
        });

        connection.on('OnObjectDeleted', (objectId) => {
            console.log('[SessionClient] Object deleted:', objectId);
            if (callbacks.onObjectDeleted) {
                callbacks.onObjectDeleted(objectId);
            }
        });

        // Session list changed (signal only - fetch data separately)
        connection.on('OnSessionsChanged', () => {
            console.log('[SessionClient] Sessions changed signal received');
            if (callbacks.onSessionsChanged) {
                callbacks.onSessionsChanged();
            }
        });

        // Game started in current session
        connection.on('OnGameStarted', (sessionId) => {
            console.log('[SessionClient] Game started in session:', sessionId);
            if (currentSession) {
                currentSession.gameStarted = true;
            }
            if (callbacks.onGameStarted) {
                callbacks.onGameStarted(sessionId);
            }
        });

        // Collision events
        connection.on('OnBulletHitReported', (report) => {
            if (callbacks.onBulletHitReported) {
                callbacks.onBulletHitReported(report);
            }
        });

        connection.on('OnBulletHitConfirmed', (confirmation) => {
            if (callbacks.onBulletHitConfirmed) {
                callbacks.onBulletHitConfirmed(confirmation);
            }
        });

        connection.on('OnBulletHitRejected', (rejection) => {
            if (callbacks.onBulletHitRejected) {
                callbacks.onBulletHitRejected(rejection);
            }
        });

        connection.on('OnShipHitReported', (report) => {
            if (callbacks.onShipHitReported) {
                callbacks.onShipHitReported(report);
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
                aspectRatio: response.aspectRatio,
                gameStarted: response.gameStarted
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
     * Start the game in the current session. Only the server can call this.
     */
    async function startGame() {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }
        if (!currentSession) {
            throw new Error('Not in a session');
        }

        try {
            const success = await connection.invoke('StartGame');
            if (success && currentSession) {
                currentSession.gameStarted = true;
            }
            return success;
        } catch (err) {
            console.error('[SessionClient] Start game failed:', err);
            throw err;
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
    async function createObject(data, scope = 'Member') {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }
        if (!currentSession) {
            throw new Error('Not in a session');
        }

        try {
            return await connection.invoke('CreateObject', data, scope);
        } catch (err) {
            console.error('[SessionClient] Create object failed:', err);
            throw err;
        }
    }

    /**
     * Update multiple objects atomically.
     */
    async function updateObjects(updates) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }
        if (!currentSession) {
            throw new Error('Not in a session');
        }

        try {
            return await connection.invoke('UpdateObjects', updates);
        } catch (err) {
            console.error('[SessionClient] Update objects failed:', err);
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

    /**
     * Report that a bullet hit an asteroid. Asteroid owner will process the collision.
     */
    async function reportBulletHit(asteroidObjectId, bulletObjectId) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
        try {
            await connection.invoke('ReportBulletHit', asteroidObjectId, bulletObjectId);
        } catch (err) {
            console.error('[SessionClient] ReportBulletHit failed:', err);
        }
    }

    /**
     * Confirm that a bullet hit was accepted (called by asteroid owner).
     */
    async function confirmBulletHit(bulletObjectId, bulletOwnerMemberId, points, asteroidSize) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
        try {
            await connection.invoke('ConfirmBulletHit', bulletObjectId, bulletOwnerMemberId, points, asteroidSize);
        } catch (err) {
            console.error('[SessionClient] ConfirmBulletHit failed:', err);
        }
    }

    /**
     * Reject a bullet hit because the asteroid no longer exists (called by asteroid owner).
     */
    async function rejectBulletHit(bulletObjectId, bulletOwnerMemberId) {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
        try {
            await connection.invoke('RejectBulletHit', bulletObjectId, bulletOwnerMemberId);
        } catch (err) {
            console.error('[SessionClient] RejectBulletHit failed:', err);
        }
    }

    /**
     * Report that this player's ship was hit by an asteroid.
     * GameState owner will decrement lives.
     */
    async function reportShipHit() {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
        try {
            await connection.invoke('ReportShipHit');
        } catch (err) {
            console.error('[SessionClient] ReportShipHit failed:', err);
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
        startGame,
        getActiveSessions,
        createObject,
        updateObjects,
        deleteObject,
        reportBulletHit,
        confirmBulletHit,
        rejectBulletHit,
        reportShipHit,
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
