using AstervoidsWeb.Configuration;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Services;
using MessagePack;
using MessagePack.Resolvers;

var builder = WebApplication.CreateBuilder(args);

// Register configuration
builder.Services.Configure<SessionSettings>(
    builder.Configuration.GetSection(SessionSettings.SectionName));

// Register services
builder.Services.AddSingleton<ISessionService, SessionService>();
builder.Services.AddSingleton<IObjectService, ObjectService>();
builder.Services.AddHostedService<SessionCleanupService>();

// Add response compression (Brotli + Gzip for all HTTP responses).
// Compresses static files (HTML/JS/CSS), SignalR negotiation, and fallback transports.
// EnableForHttps is safe here: payloads contain game state, not secrets susceptible to
// CRIME/BREACH side-channel attacks.
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
});

// Add SignalR with MessagePack protocol (camelCase names to preserve JS client contract)
//
// Wire format optimization notes:
// - WebSocket per-message compression (permessage-deflate) is NOT available through
//   SignalR's API. SignalR manages WebSocket connections internally and does not expose
//   the DangerousEnableCompression flag from WebSocketAcceptContext. HTTP-level
//   compression is handled above via response compression middleware.
// - MessagePack protocol gives ~25-30% smaller payloads vs JSON.
//   Hub DTOs are annotated with [MessagePackObject] + [Key("camelCaseName")] so the
//   binary wire format uses camelCase property names, preserving the existing JS client
//   contract without any frontend changes.
//   ContractlessStandardResolver handles unannotated types (primitives, collections,
//   Dictionary<K,V>) and includes AttributeFormatterResolver for annotated DTOs.
//   UntrustedData security guard is enabled as recommended by the MessagePack docs.
builder.Services.AddSignalR(options =>
{
    // Mobile browsers aggressively suspend WebSocket connections when backgrounded.
    // Longer timeouts give clients more time to resume before the server declares
    // the connection dead and removes the player from the session.
    // Defaults: ClientTimeoutInterval=30s, KeepAliveInterval=15s
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(90);
    options.KeepAliveInterval = TimeSpan.FromSeconds(45);
}).AddMessagePackProtocol(options =>
{
    // ContractlessStandardResolver includes AttributeFormatterResolver (picks up
    // [MessagePackObject]/[Key] on hub DTOs) and BuiltinResolver (serializes Guid as
    // string, which JS reads correctly). UntrustedData rejects malformed msgpack.
    options.SerializerOptions = ContractlessStandardResolver.Options
        .WithSecurity(MessagePackSecurity.UntrustedData);
});

var app = builder.Build();

app.UseResponseCompression();
app.UseDefaultFiles();
app.UseStaticFiles();

// Map SignalR hub
app.MapHub<SessionHub>("/sessionHub");

app.Run();
