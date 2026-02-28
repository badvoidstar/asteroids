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

// Add SignalR (using default JSON protocol)
//
// Wire format optimization notes:
// - WebSocket compression (permessage-deflate) is NOT available through SignalR's API.
//   SignalR manages WebSocket connections internally and does not expose the
//   DangerousEnableCompression flag from AcceptWebSocketAsync. Compression is only
//   available when using raw WebSockets directly.
// - MessagePack protocol (.AddMessagePackProtocol()) would give ~25-30% smaller payloads
//   but requires casing alignment: MessagePack is case-sensitive, so all JS property
//   accesses would need to match C# PascalCase, or a custom resolver would be needed.
//   The Dictionary<string, object?> data payloads also need round-trip testing.
//   Current delta encoding + static/dynamic split already reduces payloads significantly,
//   making MessagePack a diminishing-returns optimization at current payload sizes (~700
//   bytes per flush).
builder.Services.AddSignalR();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

// Map SignalR hub
app.MapHub<SessionHub>("/sessionHub");

app.Run();
