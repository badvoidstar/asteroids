<#
.SYNOPSIS
    Deploy Astervoids to Azure Container Apps using Azure Developer CLI
.DESCRIPTION
    This script provides an easy way to deploy and manage your Azure Container Apps deployment.
    Use 'azd' commands for a streamlined developer experience.
.EXAMPLE
    ./deploy.ps1 -Init        # First-time setup
    ./deploy.ps1 -Deploy      # Deploy code changes
    ./deploy.ps1 -Provision   # Update infrastructure only
    ./deploy.ps1 -Down        # Tear down all resources
#>

param(
    [switch]$Init,        # Initialize and provision for first time
    [switch]$Deploy,      # Deploy code changes only
    [switch]$Provision,   # Provision/update infrastructure only  
    [switch]$Down,        # Tear down all resources
    [switch]$Logs,        # Stream logs from container
    [switch]$Status,      # Show deployment status
    [string]$Environment  # Environment name (default: dev)
)

$ErrorActionPreference = "Stop"

# Colors for output
function Write-Step { param($msg) Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Warning { param($msg) Write-Host "⚠ $msg" -ForegroundColor Yellow }

# Check azd is installed
if (-not (Get-Command azd -ErrorAction SilentlyContinue)) {
    Write-Error "Azure Developer CLI (azd) is not installed. Run: winget install microsoft.azd"
    exit 1
}

# Default to dev environment
if (-not $Environment) {
    $Environment = "dev"
}

# First-time initialization
if ($Init) {
    Write-Step "Initializing Azure Developer CLI environment..."
    
    # Login if needed
    $authStatus = azd auth login --check-status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Step "Logging in to Azure..."
        azd auth login
    }
    
    # Initialize environment
    Write-Step "Creating environment '$Environment'..."
    azd env new $Environment
    
    # Provision infrastructure and deploy
    Write-Step "Provisioning Azure resources and deploying..."
    azd up
    
    Write-Success "Deployment complete! Your app URL is shown above."
    exit 0
}

# Deploy code changes only (fast iteration)
if ($Deploy) {
    Write-Step "Deploying code changes to Azure Container Apps..."
    azd deploy
    Write-Success "Deployment complete!"
    exit 0
}

# Provision infrastructure only
if ($Provision) {
    Write-Step "Provisioning/updating Azure infrastructure..."
    azd provision
    Write-Success "Infrastructure updated!"
    exit 0
}

# Tear down all resources
if ($Down) {
    Write-Warning "This will DELETE all Azure resources for environment '$Environment'"
    $confirm = Read-Host "Type 'yes' to confirm"
    if ($confirm -eq "yes") {
        Write-Step "Tearing down resources..."
        azd down --force --purge
        Write-Success "All resources deleted."
    } else {
        Write-Host "Cancelled."
    }
    exit 0
}

# Show logs
if ($Logs) {
    Write-Step "Streaming logs from container app..."
    $envValues = azd env get-values | ConvertFrom-StringData
    $rgName = "rg-$Environment"
    $appName = "ca-web-$Environment"
    
    az containerapp logs show --name $appName --resource-group $rgName --follow
    exit 0
}

# Show status
if ($Status) {
    Write-Step "Deployment Status"
    azd show
    exit 0
}

# Default: show help
Write-Host @"

╔═══════════════════════════════════════════════════════════════╗
║           Astervoids Azure Container Apps Deployment           ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  FIRST TIME SETUP:                                            ║
║    ./deploy.ps1 -Init                                         ║
║                                                               ║
║  ITERATIVE DEVELOPMENT:                                       ║
║    ./deploy.ps1 -Deploy      # Push code changes (fast)       ║
║    ./deploy.ps1 -Provision   # Update infrastructure          ║
║                                                               ║
║  OTHER COMMANDS:                                              ║
║    ./deploy.ps1 -Status      # Show deployment info           ║
║    ./deploy.ps1 -Logs        # Stream container logs          ║
║    ./deploy.ps1 -Down        # Delete all resources           ║
║                                                               ║
║  Or use azd commands directly:                                ║
║    azd up        # Provision + deploy                         ║
║    azd deploy    # Deploy only                                ║
║    azd monitor   # Open Azure Portal monitoring               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
"@
