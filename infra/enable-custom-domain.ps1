#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Configures custom domain with HTTPS for a Container App.

.DESCRIPTION
    This script adds a custom domain to a Container App and enables HTTPS with a managed certificate.
    Run this after the initial deployment has created DNS verification records and they have propagated.

    The script performs these steps:
    1. Adds the custom hostname to the Container App
    2. Creates a managed certificate for the domain
    3. Binds the certificate to enable HTTPS

.PARAMETER ResourceGroup
    The name of the resource group containing the Container App.

.PARAMETER ContainerAppName
    The name of the Container App to update.

.PARAMETER EnvironmentName
    The name of the Container Apps Environment.

.PARAMETER CustomDomain
    The custom domain name (e.g., astervoids.example.com).

.EXAMPLE
    .\enable-custom-domain.ps1 -ResourceGroup "rg-production" `
        -ContainerAppName "ca-web-production" `
        -EnvironmentName "cae-production" `
        -CustomDomain "astervoids.example.com"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory=$true)]
    [string]$ContainerAppName,

    [Parameter(Mandatory=$true)]
    [string]$EnvironmentName,

    [Parameter(Mandatory=$true)]
    [string]$CustomDomain
)

$ErrorActionPreference = "Stop"

Write-Host "`n=== Custom Domain Configuration ===" -ForegroundColor Cyan
Write-Host "Resource Group: $ResourceGroup"
Write-Host "Container App: $ContainerAppName"
Write-Host "Environment: $EnvironmentName"
Write-Host "Custom Domain: $CustomDomain"
Write-Host ""

# Step 1: Add custom hostname to container app
Write-Host "[1/3] Adding custom hostname to container app..." -ForegroundColor Yellow
az containerapp hostname add `
    --resource-group $ResourceGroup `
    --name $ContainerAppName `
    --hostname $CustomDomain

if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Failed to add custom hostname. Ensure DNS TXT record exists." -ForegroundColor Red
    Write-Host "  Required: TXT record 'asuid.$CustomDomain' with the domain verification ID" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Custom hostname added" -ForegroundColor Green

# Step 2: Create managed certificate
Write-Host "`n[2/3] Creating managed certificate..." -ForegroundColor Yellow
$certName = "cert-$($CustomDomain -replace '\.', '-')"

az containerapp env certificate create `
    --resource-group $ResourceGroup `
    --name $EnvironmentName `
    --certificate-name $certName `
    --hostname $CustomDomain `
    --validation-method CNAME

if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Failed to create certificate" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Certificate created: $certName" -ForegroundColor Green

# Step 3: Bind certificate to hostname
Write-Host "`n[3/3] Binding certificate to enable HTTPS..." -ForegroundColor Yellow
az containerapp hostname bind `
    --resource-group $ResourceGroup `
    --name $ContainerAppName `
    --hostname $CustomDomain `
    --environment $EnvironmentName `
    --validation-method CNAME

if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Failed to bind certificate" -ForegroundColor Red
    exit 1
}

Write-Host "`n✓ Successfully configured HTTPS for $CustomDomain" -ForegroundColor Green
Write-Host "The custom domain is now accessible at https://$CustomDomain" -ForegroundColor Green
