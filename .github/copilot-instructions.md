# Copilot Instructions for Astervoids

## Build & Run Commands

```powershell
# Run locally with hot reload
dotnet watch run --project AstervoidsWeb/AstervoidsWeb.csproj

# Build solution
dotnet build astervoids.sln --configuration Release

# Run via Docker
docker-compose -f AstervoidsWeb/docker-compose.yml up --build
```

## Architecture

This is a classic Astervoids game with:
- **Frontend**: Single HTML5 Canvas game (`AstervoidsWeb/wwwroot/index.html` - ~70KB, contains all game logic inline)
- **Backend**: Minimal ASP.NET Core server serving static files (`AstervoidsWeb/Program.cs`)
- **Infrastructure**: Azure Container Apps via Bicep templates (`infra/`)
- **Deployment**: Azure Developer CLI (azd) with GitHub Actions CI/CD

### Deployment Model

- Production deploys from `master` branch to its own resource group
- Feature branches deploy as separate Container Apps within the production resource group (sharing Container Registry and Container Apps Environment)
- Branch cleanup is automated via `cleanup-branch.yml` workflow

## Key Conventions

- The entire game is a single HTML file with embedded CSS and JavaScript - no build step for frontend
- Use `azd deploy` for quick code changes (~24 sec), `azd up` for full provision + deploy
- .NET 10.0 target framework
- Container Apps scale 0-3 replicas (production) or 0-1 (branches)
