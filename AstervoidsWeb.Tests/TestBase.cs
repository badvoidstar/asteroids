using AstervoidsWeb.Models;
using AstervoidsWeb.Services;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Base class for tests that provides common setup utilities for session and member creation.
/// </summary>
public abstract class TestBase
{
    protected readonly SessionService SessionService;
    protected readonly ObjectService ObjectService;

    protected TestBase()
    {
        SessionService = new SessionService();
        ObjectService = new ObjectService(SessionService);
    }

    /// <summary>
    /// Creates a test session with a single member (the creator/server).
    /// </summary>
    /// <param name="connectionId">Connection ID for the creator. Defaults to "connection-1".</param>
    /// <returns>Tuple containing the session and its creator member.</returns>
    protected (Session session, Member creator) CreateTestSession(string connectionId = "connection-1")
    {
        var result = SessionService.CreateSession(connectionId, 1.5);
        return (result.Session!, result.Creator!);
    }

    /// <summary>
    /// Creates a test session with two members: a server and a client.
    /// </summary>
    /// <param name="serverConn">Connection ID for the server. Defaults to "connection-1".</param>
    /// <param name="clientConn">Connection ID for the client. Defaults to "connection-2".</param>
    /// <returns>Tuple containing the session, server member, and client member.</returns>
    protected (Session session, Member server, Member client) CreateTestSessionWithClient(
        string serverConn = "connection-1", string clientConn = "connection-2")
    {
        var (session, server) = CreateTestSession(serverConn);
        var joinResult = SessionService.JoinSession(session.Id, clientConn);
        return (session, server, joinResult.Member!);
    }
}
