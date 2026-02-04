/**
 * Session UI Module
 * Handles the user interface for session management.
 */

const SessionUI = (function() {
    let containerElement = null;
    let onSessionSelected = null;
    let refreshInterval = null;

    /**
     * Initialize the session UI.
     * @param {HTMLElement|string} container - Container element or selector
     * @param {Function} callback - Callback when session is selected/created
     */
    function init(container, callback) {
        if (typeof container === 'string') {
            containerElement = document.querySelector(container);
        } else {
            containerElement = container;
        }

        if (!containerElement) {
            console.error('[SessionUI] Container element not found');
            return;
        }

        onSessionSelected = callback;
        render();
    }

    /**
     * Render the session selection UI.
     */
    function render() {
        containerElement.innerHTML = `
            <div class="session-ui">
                <style>
                    .session-ui {
                        font-family: 'Courier New', monospace;
                        color: #00ff00;
                        background: rgba(0, 0, 0, 0.9);
                        padding: 20px;
                        border: 2px solid #00ff00;
                        border-radius: 8px;
                        max-width: 400px;
                        margin: 20px auto;
                    }
                    .session-ui h2 {
                        margin: 0 0 15px 0;
                        text-align: center;
                        text-transform: uppercase;
                        letter-spacing: 2px;
                    }
                    .session-ui .status {
                        text-align: center;
                        margin-bottom: 15px;
                        font-size: 12px;
                        color: #888;
                    }
                    .session-ui .status.connected {
                        color: #00ff00;
                    }
                    .session-ui .status.error {
                        color: #ff4444;
                    }
                    .session-ui button {
                        width: 100%;
                        padding: 12px;
                        margin: 5px 0;
                        background: transparent;
                        border: 1px solid #00ff00;
                        color: #00ff00;
                        font-family: inherit;
                        font-size: 14px;
                        cursor: pointer;
                        transition: all 0.2s;
                    }
                    .session-ui button:hover {
                        background: #00ff00;
                        color: #000;
                    }
                    .session-ui button:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                    }
                    .session-ui .session-list {
                        max-height: 200px;
                        overflow-y: auto;
                        margin: 15px 0;
                        border: 1px solid #333;
                    }
                    .session-ui .session-item {
                        padding: 10px;
                        border-bottom: 1px solid #333;
                        cursor: pointer;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .session-ui .session-item:last-child {
                        border-bottom: none;
                    }
                    .session-ui .session-item:hover {
                        background: rgba(0, 255, 0, 0.1);
                    }
                    .session-ui .session-name {
                        font-weight: bold;
                    }
                    .session-ui .session-members {
                        font-size: 12px;
                        color: #888;
                    }
                    .session-ui .no-sessions {
                        padding: 20px;
                        text-align: center;
                        color: #666;
                    }
                    .session-ui .divider {
                        text-align: center;
                        margin: 15px 0;
                        color: #666;
                    }
                    .session-ui .current-session {
                        text-align: center;
                        padding: 15px;
                        border: 1px solid #00ff00;
                        margin-bottom: 15px;
                    }
                    .session-ui .member-info {
                        font-size: 12px;
                        color: #888;
                        margin-top: 5px;
                    }
                    .session-ui .role-server {
                        color: #ffff00;
                    }
                    .session-ui .role-client {
                        color: #00ffff;
                    }
                </style>
                <h2>🚀 Multiplayer</h2>
                <div id="session-status" class="status">Connecting...</div>
                <div id="session-content"></div>
            </div>
        `;

        connectAndShowUI();
    }

    /**
     * Connect to the session hub and show UI.
     */
    async function connectAndShowUI() {
        const statusEl = document.getElementById('session-status');
        const contentEl = document.getElementById('session-content');

        // Setup callbacks
        SessionClient.on('onConnected', () => {
            statusEl.textContent = '● Connected';
            statusEl.className = 'status connected';
            showSessionList();
        });

        SessionClient.on('onDisconnected', () => {
            statusEl.textContent = '○ Disconnected';
            statusEl.className = 'status';
            contentEl.innerHTML = '<button onclick="SessionUI.reconnect()">Reconnect</button>';
            stopAutoRefresh();
        });

        SessionClient.on('onError', (error) => {
            statusEl.textContent = '⚠ ' + error;
            statusEl.className = 'status error';
        });

        SessionClient.on('onMemberJoined', (member) => {
            if (SessionClient.isInSession()) {
                showInSessionUI();
            }
        });

        SessionClient.on('onMemberLeft', (info) => {
            if (SessionClient.isInSession()) {
                showInSessionUI();
            }
        });

        SessionClient.on('onRoleChanged', (newRole) => {
            if (SessionClient.isInSession()) {
                showInSessionUI();
            }
        });

        // Connect
        const connected = await SessionClient.connect();
        if (!connected) {
            statusEl.textContent = '○ Connection Failed';
            statusEl.className = 'status error';
            contentEl.innerHTML = '<button onclick="SessionUI.reconnect()">Retry</button>';
        }
    }

    /**
     * Show the session list UI.
     */
    async function showSessionList() {
        const contentEl = document.getElementById('session-content');
        
        try {
            const sessions = await SessionClient.getActiveSessions();

            let html = '<button id="create-session-btn">Create New Session</button>';
            
            if (sessions && sessions.length > 0) {
                html += '<div class="divider">— or join existing —</div>';
                html += '<div class="session-list">';
                for (const session of sessions) {
                    html += `
                        <div class="session-item" data-session-id="${session.id}">
                            <span class="session-name">🍎 ${session.name}</span>
                            <span class="session-members">${session.memberCount} player${session.memberCount !== 1 ? 's' : ''}</span>
                        </div>
                    `;
                }
                html += '</div>';
            } else {
                html += '<div class="no-sessions">No active sessions</div>';
            }

            contentEl.innerHTML = html;

            // Bind events
            document.getElementById('create-session-btn').addEventListener('click', handleCreateSession);
            
            const sessionItems = contentEl.querySelectorAll('.session-item');
            sessionItems.forEach(item => {
                item.addEventListener('click', () => {
                    handleJoinSession(item.dataset.sessionId);
                });
            });

            // Auto-refresh session list
            startAutoRefresh();

        } catch (err) {
            contentEl.innerHTML = `<div class="status error">Error loading sessions</div>
                <button onclick="SessionUI.showSessionList()">Retry</button>`;
        }
    }

    /**
     * Show the in-session UI.
     */
    async function showInSessionUI() {
        stopAutoRefresh();
        
        const contentEl = document.getElementById('session-content');
        const session = SessionClient.getCurrentSession();
        const member = SessionClient.getCurrentMember();

        if (!session || !member) {
            showSessionList();
            return;
        }

        // Get fresh session data
        let memberCount = 1;
        if (session.members) {
            memberCount = Array.isArray(session.members) ? session.members.length : Object.keys(session.members).length;
        }

        const roleClass = member.role === 'Server' ? 'role-server' : 'role-client';
        const roleIcon = member.role === 'Server' ? '👑' : '🎮';

        contentEl.innerHTML = `
            <div class="current-session">
                <div class="session-name">🍎 ${session.name}</div>
                <div class="member-info">
                    ${roleIcon} <span class="${roleClass}">${member.role}</span> · 
                    ${memberCount} player${memberCount !== 1 ? 's' : ''}
                </div>
            </div>
            <button id="leave-session-btn">Leave Session</button>
        `;

        document.getElementById('leave-session-btn').addEventListener('click', handleLeaveSession);
    }

    /**
     * Handle create session button click.
     */
    async function handleCreateSession() {
        const btn = document.getElementById('create-session-btn');
        btn.disabled = true;
        btn.textContent = 'Creating...';

        try {
            const result = await SessionClient.createSession();
            showInSessionUI();
            
            if (onSessionSelected) {
                onSessionSelected(result.session, result.member, 'created');
            }
        } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Create New Session';
        }
    }

    /**
     * Handle join session click.
     */
    async function handleJoinSession(sessionId) {
        try {
            const result = await SessionClient.joinSession(sessionId);
            showInSessionUI();
            
            if (onSessionSelected) {
                onSessionSelected(result.session, result.member, 'joined');
            }
        } catch (err) {
            // Session may have been destroyed, refresh list
            showSessionList();
        }
    }

    /**
     * Handle leave session button click.
     */
    async function handleLeaveSession() {
        await SessionClient.leaveSession();
        showSessionList();
        
        if (onSessionSelected) {
            onSessionSelected(null, null, 'left');
        }
    }

    /**
     * Reconnect to the session hub.
     */
    async function reconnect() {
        await SessionClient.disconnect();
        render();
    }

    /**
     * Start auto-refreshing the session list.
     */
    function startAutoRefresh() {
        stopAutoRefresh();
        refreshInterval = setInterval(async () => {
            if (SessionClient.isConnected() && !SessionClient.isInSession()) {
                const sessions = await SessionClient.getActiveSessions();
                updateSessionList(sessions);
            }
        }, 5000);
    }

    /**
     * Stop auto-refreshing.
     */
    function stopAutoRefresh() {
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
    }

    /**
     * Update the session list without full re-render.
     */
    function updateSessionList(sessions) {
        const listEl = document.querySelector('.session-list');
        if (!listEl) return;

        if (sessions && sessions.length > 0) {
            let html = '';
            for (const session of sessions) {
                html += `
                    <div class="session-item" data-session-id="${session.id}">
                        <span class="session-name">🍎 ${session.name}</span>
                        <span class="session-members">${session.memberCount} player${session.memberCount !== 1 ? 's' : ''}</span>
                    </div>
                `;
            }
            listEl.innerHTML = html;

            // Re-bind events
            const sessionItems = listEl.querySelectorAll('.session-item');
            sessionItems.forEach(item => {
                item.addEventListener('click', () => {
                    handleJoinSession(item.dataset.sessionId);
                });
            });
        }
    }

    /**
     * Hide the session UI.
     */
    function hide() {
        if (containerElement) {
            containerElement.style.display = 'none';
        }
        stopAutoRefresh();
    }

    /**
     * Show the session UI.
     */
    function show() {
        if (containerElement) {
            containerElement.style.display = 'block';
        }
        if (SessionClient.isInSession()) {
            showInSessionUI();
        } else if (SessionClient.isConnected()) {
            showSessionList();
        }
    }

    /**
     * Destroy the session UI.
     */
    function destroy() {
        stopAutoRefresh();
        if (containerElement) {
            containerElement.innerHTML = '';
        }
    }

    // Public API
    return {
        init,
        show,
        hide,
        destroy,
        reconnect,
        showSessionList,
        showInSessionUI
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionUI;
}
