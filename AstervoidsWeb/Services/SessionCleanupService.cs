using AstervoidsWeb.Configuration;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Services;

/// <summary>
/// Background service that periodically checks for and cleans up expired sessions.
/// Handles two timeout tiers:
/// 1. Empty timeout: sessions with no connected members for a configurable duration.
/// 2. Absolute timeout: sessions that have exceeded a maximum lifetime regardless of activity.
/// </summary>
public class SessionCleanupService : BackgroundService
{
    private readonly ISessionService _sessionService;
    private readonly IHubContext<SessionHub> _hubContext;
    private readonly ILogger<SessionCleanupService> _logger;
    private readonly TimeSpan _emptyTimeout;
    private readonly TimeSpan _absoluteTimeout;
    private static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(10);

    // Group name must match SessionHub.AllClientsGroup
    private const string AllClientsGroup = SessionHub.AllClientsGroup;

    public SessionCleanupService(
        ISessionService sessionService,
        IHubContext<SessionHub> hubContext,
        IOptions<SessionSettings> settings,
        ILogger<SessionCleanupService> logger)
    {
        _sessionService = sessionService;
        _hubContext = hubContext;
        _logger = logger;
        _emptyTimeout = TimeSpan.FromSeconds(settings.Value.EmptyTimeoutSeconds);
        _absoluteTimeout = TimeSpan.FromMinutes(settings.Value.AbsoluteTimeoutMinutes);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "Session cleanup service started. Empty timeout: {EmptyTimeout}s, Absolute timeout: {AbsoluteTimeout}min",
            _emptyTimeout.TotalSeconds, _absoluteTimeout.TotalMinutes);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(CheckInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            try
            {
                await CleanupExpiredSessions();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during session cleanup");
            }
        }
    }

    private async Task CleanupExpiredSessions()
    {
        var now = DateTime.UtcNow;
        var sessions = _sessionService.GetAllSessions().ToList();
        var sessionsDestroyed = false;

        foreach (var session in sessions)
        {
            string? reason = null;
            Func<Session, bool>? predicate = null;

            // Check absolute timeout first (takes priority)
            if (now - session.CreatedAt > _absoluteTimeout)
            {
                reason = "Session exceeded maximum duration";
                // Re-check the absolute timeout inside the lock to guard against a clock
                // edge where CleanupExpiredSessions runs just before the deadline
                var capturedNow = now;
                var absoluteTimeout = _absoluteTimeout;
                predicate = s => capturedNow - s.CreatedAt > absoluteTimeout;

                _logger.LogInformation(
                    "Session {SessionName} ({SessionId}) exceeded absolute timeout ({AbsoluteTimeout}min). Created at {CreatedAt}.",
                    session.Name, session.Id, _absoluteTimeout.TotalMinutes, session.CreatedAt);
            }
            // Check empty timeout
            else if (session.Members.IsEmpty
                     && session.LastMemberLeftAt.HasValue
                     && now - session.LastMemberLeftAt.Value > _emptyTimeout)
            {
                reason = "Session was empty for too long";
                // Re-check inside the lock so a concurrent join that cleared
                // LastMemberLeftAt prevents this session from being destroyed.
                var capturedNow = now;
                var emptyTimeout = _emptyTimeout;
                predicate = s => s.Members.IsEmpty
                              && s.LastMemberLeftAt.HasValue
                              && capturedNow - s.LastMemberLeftAt.Value > emptyTimeout;

                _logger.LogInformation(
                    "Session {SessionName} ({SessionId}) empty for {EmptyDuration}s (timeout: {EmptyTimeout}s). Destroying.",
                    session.Name, session.Id,
                    (now - session.LastMemberLeftAt.Value).TotalSeconds,
                    _emptyTimeout.TotalSeconds);
            }

            if (reason != null)
            {
                var result = _sessionService.ForceDestroySession(session.Id, predicate);
                if (result != null)
                {
                    sessionsDestroyed = true;

                    // Notify any connected members (only relevant for absolute timeout)
                    foreach (var connectionId in result.ConnectionIds)
                    {
                        try
                        {
                            await _hubContext.Clients.Client(connectionId)
                                .SendAsync("OnSessionExpired", reason);
                            await _hubContext.Groups.RemoveFromGroupAsync(
                                connectionId, session.Id.ToString());
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex,
                                "Failed to notify connection {ConnectionId} of session expiration",
                                connectionId);
                        }
                    }
                }
            }
        }

        // Broadcast session list change once if any sessions were destroyed
        if (sessionsDestroyed)
        {
            await _hubContext.Clients.Group(AllClientsGroup).SendAsync("OnSessionsChanged");
        }
    }
}
