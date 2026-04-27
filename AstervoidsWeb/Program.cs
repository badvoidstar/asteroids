using System.Security.Cryptography;
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
builder.Services.AddSingleton<ISessionNameGenerator, FruitNameGenerator>();
builder.Services.AddSingleton<ISessionService, SessionService>();
builder.Services.AddSingleton<IObjectService, ObjectService>();
builder.Services.AddSingleton<ServerMetricsService>();
builder.Services.AddHostedService<SessionCleanupService>();

// Use camelCase JSON property names for REST API endpoints
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
});

// Add response compression (Brotli + Gzip for all HTTP responses).
// Compresses static files (HTML/JS/CSS), SignalR negotiation, and fallback transports.
// EnableForHttps is safe here: payloads contain game state, not secrets susceptible to
// CRIME/BREACH side-channel attacks.
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
});

// Read session settings for SignalR timeout configuration
var sessionSettings = builder.Configuration.GetSection(SessionSettings.SectionName).Get<SessionSettings>() ?? new SessionSettings();

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
    // The 2× relationship (ClientTimeout = 2 × KeepAlive) is preserved so a single
    // missed keep-alive ping doesn't kill the connection.
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(sessionSettings.ClientTimeoutSeconds);
    options.KeepAliveInterval = TimeSpan.FromSeconds(sessionSettings.KeepAliveSeconds);
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

// Build a content-hash ETag table once at startup.
// SHA-256 of each file's bytes → first 16 bytes hex-encoded → stable ETag.
// Unlike ASP.NET Core's default mtime-derived ETag, this is unchanged across deploys
// when the file content hasn't changed (mtime is reset by `dotnet publish` / COPY).
var webRoot = app.Environment.WebRootPath;
var etags = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
if (!string.IsNullOrEmpty(webRoot) && Directory.Exists(webRoot))
{
    foreach (var filePath in Directory.EnumerateFiles(webRoot, "*", SearchOption.AllDirectories))
    {
        using var fs = File.OpenRead(filePath);
        var hash = SHA256.HashData(fs);
        var rel = "/" + Path.GetRelativePath(webRoot, filePath).Replace('\\', '/');
        etags[rel] = "\"" + Convert.ToHexString(hash, 0, 16).ToLowerInvariant() + "\"";
    }
}

// ETag + Cache-Control middleware.
// Placed after UseDefaultFiles (so "/" is already rewritten to "/index.html")
// and before UseStaticFiles (which serves the body on 200 responses).
// - Sets Cache-Control: no-cache so the browser revalidates on every launch.
// - Returns 304 when If-None-Match matches the content-hash ETag (no body transfer).
// - Non-static paths (SignalR, API) are not in the etags table and pass through unchanged.
app.Use(async (context, next) =>
{
    var method = context.Request.Method;
    if ((method == HttpMethods.Get || method == HttpMethods.Head)
        && etags.TryGetValue(context.Request.Path.Value ?? "", out var etag))
    {
        context.Response.Headers.ETag = etag;
        context.Response.Headers.CacheControl = "no-cache";

        var ifNoneMatch = context.Request.Headers.IfNoneMatch.ToString();
        if (!string.IsNullOrEmpty(ifNoneMatch))
        {
            // If-None-Match may contain a comma-separated list of ETags (RFC 9110 §13.1.2).
            // Return 304 if any supplied tag matches our content-hash ETag.
            var clientTags = ifNoneMatch.Split(',',
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (clientTags.Any(t => t == etag))
            {
                context.Response.StatusCode = StatusCodes.Status304NotModified;
                context.Response.Headers.Remove("Content-Type");
                return;
            }
        }
    }
    await next(context);
});

app.UseStaticFiles();

// Map SignalR hub
app.MapHub<SessionHub>("/sessionHub");

// Server monitoring metrics API endpoint
app.MapGet("/api/srvmon", (ServerMetricsService metrics, ISessionService sessionService) =>
    Results.Ok(metrics.GetSnapshot(sessionService)));

app.Run();

// Make Program accessible to integration tests (WebApplicationFactory<Program>).
public partial class Program { }
