using AstervoidsWeb.Hubs;
using AstervoidsWeb.Services;

var builder = WebApplication.CreateBuilder(args);

// Register services
builder.Services.AddSingleton<ISessionService, SessionService>();
builder.Services.AddSingleton<IObjectService, ObjectService>();

// Add SignalR
builder.Services.AddSignalR();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

// Map SignalR hub
app.MapHub<SessionHub>("/sessionHub");

app.Run();
