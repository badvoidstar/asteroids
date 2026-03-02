using AstervoidsWeb.Configuration;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Services;

var builder = WebApplication.CreateBuilder(args);

// Register configuration
builder.Services.Configure<SessionSettings>(
    builder.Configuration.GetSection(SessionSettings.SectionName));

// Register services
builder.Services.AddSingleton<ISessionService, SessionService>();
builder.Services.AddSingleton<IObjectService, ObjectService>();

// Add response compression (Brotli + Gzip for all HTTP responses).
// Compresses static files (HTML/JS/CSS), SignalR negotiation, and fallback transports.
// EnableForHttps is safe here: payloads contain game state, not secrets susceptible to
// CRIME/BREACH side-channel attacks.
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
});

// Add SignalR (using default JSON protocol)
//
// Wire format optimization notes:
// - WebSocket per-message compression (permessage-deflate) is NOT available through
//   SignalR's API. SignalR manages WebSocket connections internally and does not expose
//   the DangerousEnableCompression flag from WebSocketAcceptContext. HTTP-level
//   compression is handled above via response compression middleware.
// - MessagePack protocol (.AddMessagePackProtocol()) would give ~25-30% smaller payloads
//   but requires casing alignment: MessagePack is case-sensitive, so all JS property
//   accesses would need to match C# PascalCase, or a custom resolver would be needed.
//   The Dictionary<string, object?> data payloads also need round-trip testing.
//   Current delta encoding + static/dynamic split already reduces payloads significantly,
//   making MessagePack a diminishing-returns optimization at current payload sizes (~700
//   bytes per flush).
builder.Services.AddSignalR();

var app = builder.Build();

app.UseResponseCompression();
app.UseDefaultFiles();
app.UseStaticFiles();

// Map SignalR hub
app.MapHub<SessionHub>("/sessionHub");

app.Run();
