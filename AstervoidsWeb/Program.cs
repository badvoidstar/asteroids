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

// Add SignalR
// Future optimization: Add .AddMessagePackProtocol() for binary serialization (~30-50% smaller payloads)
builder.Services.AddSignalR();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

// Map SignalR hub
app.MapHub<SessionHub>("/sessionHub");

app.Run();
