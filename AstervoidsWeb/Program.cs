using AstervoidsWeb.Configuration;
using AstervoidsWeb.Formatters;
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
    // This is a fast-paced game that doesn't benefit from protracted reconnection windows.
    // The 2× relationship (20 = 2 × 10) is preserved so a single missed keep-alive ping
    // doesn't kill the connection. Mobile recovery works well via the auto-rejoin fallback.
    // Defaults: ClientTimeoutInterval=30s, KeepAliveInterval=15s
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(20);
    options.KeepAliveInterval = TimeSpan.FromSeconds(10);
}).AddMessagePackProtocol(options =>
{
    // BinaryGuidResolver is composed first so typed Guid/Guid? properties are serialized
    // as 16-byte binary instead of 36-char strings (~19 bytes saved per GUID on the wire).
    // ContractlessStandardResolver handles everything else: [MessagePackObject]/[Key] DTOs,
    // primitives, collections, Dictionary<K,V>. Collection formatters (e.g. IEnumerable<Guid>)
    // resolve element formatters through the composite root, so Guid elements also get
    // binary encoding. UntrustedData rejects malformed msgpack.
    var compositeResolver = CompositeResolver.Create(
        BinaryGuidResolver.Instance,
        ContractlessStandardResolver.Instance
    );
    options.SerializerOptions = MessagePackSerializerOptions.Standard
        .WithResolver(compositeResolver)
        .WithSecurity(MessagePackSecurity.UntrustedData);
});

var app = builder.Build();

app.UseResponseCompression();
app.UseDefaultFiles();
app.UseStaticFiles();

// Map SignalR hub
app.MapHub<SessionHub>("/sessionHub");

app.Run();
