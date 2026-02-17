# Copilot Instructions for Astervoids

## Build, Test & Run Commands

```powershell
# Run locally with hot reload
dotnet watch run --project AstervoidsWeb/AstervoidsWeb.csproj

# Build solution
dotnet build astervoids.sln --configuration Release

# Run all tests
dotnet test astervoids.sln

# Run a single test
dotnet test AstervoidsWeb.Tests --filter "FullyQualifiedName~SessionServiceTests.CreateSession_ShouldCreateSessionWithFruitName"

# Run via Docker
docker-compose -f AstervoidsWeb/docker-compose.yml up --build
```

## Architecture

### Overview
A multiplayer Astervoids game with real-time synchronization via SignalR.

- **Frontend**: Single HTML5 Canvas file (`AstervoidsWeb/wwwroot/index.html`) with embedded CSS/JS - no build step
- **Backend**: ASP.NET Core (.NET 10.0) with SignalR hub for real-time multiplayer
- **Infrastructure**: Azure Container Apps via Bicep templates (`infra/`)

### Multiplayer Session Model
- `SessionService` manages game sessions (max 6 concurrent, max 4 players each)
- Sessions have a **Server** (first player, authoritative) and **Clients** (other players)
- If the Server leaves, the oldest Client is automatically promoted
- `ObjectService` handles synchronized game objects with optimistic concurrency (version numbers)
- SignalR hub (`/sessionHub`) broadcasts state changes to all session members

### Deployment Model
- Production deploys from `master` branch to its own resource group
- Feature branches deploy as separate Container Apps within the production resource group
- Use `azd deploy` for quick code changes (~24 sec), `azd up` for full provision + deploy

## Key Conventions

- Single HTML file for frontend - all game logic is inline, no bundler or transpiler
- Tests use xUnit with FluentAssertions and Moq
- Result pattern for service operations: `CreateSessionResult`, `JoinSessionResult`, etc.
- Thread-safe collections (`ConcurrentDictionary`) for session/member/object storage
- Sessions are named with fruit names for human-readable identification
