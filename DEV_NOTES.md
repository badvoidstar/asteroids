# Dev Notes

## Running the Server Locally

### Launch
```powershell
# Build first
dotnet build AstervoidsWeb/AstervoidsWeb.csproj --configuration Debug

# Launch as a background process (note the PID in output)
$proc = Start-Process -FilePath "dotnet" -ArgumentList "AstervoidsWeb\bin\Debug\net10.0\AstervoidsWeb.dll" -WorkingDirectory "AstervoidsWeb" -PassThru -WindowStyle Hidden; "PID: $($proc.Id)"
```

The server runs at **http://localhost:5000**.

### Stop
```powershell
Stop-Process -Id <PID>
```

### Notes
- Use the DLL directly (`dotnet AstervoidsWeb.dll`), not `dotnet run` — the `dotnet run` wrapper can lose its child process.
- `dotnet watch run --project AstervoidsWeb/AstervoidsWeb.csproj` works for hot reload during development but requires an active terminal session.

## Deploying to Azure with azd (Dev/Test)

For testing on a real URL (e.g., mobile device testing, sharing with others), use `azd` to deploy to Azure Container Apps.

### Prerequisites
- [Azure Developer CLI (azd)](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/install-azd) installed
- Docker Desktop running (required to build the container image)
- An Azure subscription (`az login` to authenticate)

### First-Time Setup
```powershell
# Set the Azure region
azd env set AZURE_LOCATION westus2

# Provision infrastructure and deploy (takes ~3-4 minutes)
azd up
```

This creates a resource group `rg-astervoids` with a Container Registry, Container Apps Environment, and Container App.

### Subsequent Deploys
```powershell
# Code-only redeploy (~30 seconds)
azd deploy
```

Use `azd deploy` for iterating on code changes. Use `azd up` if infrastructure (Bicep templates) changed.

### Tear Down
```powershell
# Remove all Azure resources
azd down
```

### Notes
- The Dockerfile uses Alpine-based .NET images (`10.0-alpine`) — the glibc-based images (`10.0` / `10.0-noble`) segfault during `dotnet restore` on Docker Desktop/WSL2.
- The deployed URL is shown at the end of `azd up`/`azd deploy` output.
- See `CICD_SETUP.md` for the GitHub Actions CI/CD pipeline (separate from `azd`).
