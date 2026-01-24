# Asteroids

A classic Asteroids game built with HTML5 Canvas and ASP.NET Core.

## Play Online

- **GitHub Pages:** https://badvoidstar.github.io/asteroids/
- **Azure Container Apps:** https://ca-web-dev.redgrass-104110a0.westus3.azurecontainerapps.io/

## Local Development

```powershell
# Run with hot reload
dotnet watch run --project AsteroidsWeb/AsteroidsWeb.csproj

# Or use Docker
docker-compose -f AsteroidsWeb/docker-compose.yml up --build
```

## Azure Deployment

This project uses [Azure Developer CLI (azd)](https://learn.microsoft.com/azure/developer/azure-developer-cli/) for deployment to Azure Container Apps.

### Prerequisites

- [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) (`winget install microsoft.azd`)
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`winget install Microsoft.AzureCLI`) - optional, for advanced operations

### First Time Setup

```powershell
./deploy.ps1 -Init
```

This will:
1. Log you into Azure (browser opens)
2. Ask you to select your subscription and region
3. Create all Azure resources (Container Registry, Container Apps Environment)
4. Build and push your container image
5. Deploy your app and give you the URL

### Iterative Development Workflow

| Action | Command | Time |
|--------|---------|------|
| **Deploy code changes** | `azd deploy` | ~24 sec |
| **Update infrastructure** | `azd provision` | ~1 min |
| **Full provision + deploy** | `azd up` | ~2 min |
| **View logs** | `azd monitor --logs` | - |
| **Open in portal** | `azd monitor` | - |
| **Show deployment info** | `./deploy.ps1 -Status` | - |
| **Delete all resources** | `./deploy.ps1 -Down` | - |

### Quick Deploy After Code Changes

```powershell
azd deploy
```

That's it! Your changes will be live in about 24 seconds.

## Azure Resources Created

| Resource | Name Pattern | Purpose |
|----------|--------------|---------|
| Resource Group | `rg-{env}` | Container for all resources |
| Container Registry | `cr{env}{unique}` | Stores Docker images |
| Container Apps Environment | `cae-{env}` | Managed environment for containers |
| Container App | `ca-web-{env}` | Runs the game (scales 0-3 replicas) |
| Log Analytics | `log-cae-{env}` | Logging and monitoring |

## Project Structure

```
asteroids/
├── azure.yaml              # Azure Developer CLI config
├── deploy.ps1              # Deployment helper script
├── infra/                  # Infrastructure as Code (Bicep)
│   ├── main.bicep
│   ├── main.parameters.json
│   └── core/host/
│       ├── container-apps.bicep
│       └── container-app.bicep
└── AsteroidsWeb/
    ├── Dockerfile
    ├── Program.cs
    └── wwwroot/
        └── index.html      # The game!
```

## Controls

**Desktop:** Arrow keys to move, Space to fire, P to pause

**Mobile:** Touch controls appear automatically on touch devices
