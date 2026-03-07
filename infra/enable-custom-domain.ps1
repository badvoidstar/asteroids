#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Configures custom domain with HTTPS for a Container App.

.DESCRIPTION
    This script adds a custom domain to a Container App and enables HTTPS with a managed certificate.
    Run this after the initial deployment has created DNS verification records and they have propagated.

    The script performs these steps:
    1. Verifies DNS records exist (CNAME + TXT verification)
    2. Adds the custom hostname to the Container App
    3. Creates a managed certificate for the domain
    4. Binds the certificate to enable HTTPS
    5. Verifies the domain is accessible

.PARAMETER ResourceGroup
    The name of the resource group containing the Container App.

.PARAMETER ContainerAppName
    The name of the Container App to update.

.PARAMETER EnvironmentName
    The name of the Container Apps Environment.

.PARAMETER CustomDomain
    The custom domain name (e.g., app.yourdomain.com).

.PARAMETER SkipDnsCheck
    Skip the DNS pre-check (use if you know DNS is configured via Azure DNS).

.PARAMETER CreateWildcard
    Also create a wildcard certificate (*.CustomDomain) for branch deployments.

.EXAMPLE
    .\enable-custom-domain.ps1 -ResourceGroup "rg-production" `
        -ContainerAppName "ca-web-production" `
        -EnvironmentName "cae-production" `
        -CustomDomain "app.yourdomain.com"

.EXAMPLE
    .\enable-custom-domain.ps1 -ResourceGroup "rg-production" `
        -ContainerAppName "ca-web-production" `
        -EnvironmentName "cae-production" `
        -CustomDomain "app.yourdomain.com" `
        -CreateWildcard
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory=$true)]
    [string]$ContainerAppName,

    [Parameter(Mandatory=$true)]
    [string]$EnvironmentName,

    [Parameter(Mandatory=$true)]
    [string]$CustomDomain,

    [switch]$SkipDnsCheck,

    [switch]$CreateWildcard
)

$ErrorActionPreference = "Stop"

Write-Host "`n=== Custom Domain Configuration ===" -ForegroundColor Cyan
Write-Host "Resource Group: $ResourceGroup"
Write-Host "Container App: $ContainerAppName"
Write-Host "Environment: $EnvironmentName"
Write-Host "Custom Domain: $CustomDomain"
Write-Host ""

# Step 0: Verify DNS records exist
if (-not $SkipDnsCheck) {
    Write-Host "[0/4] Verifying DNS records..." -ForegroundColor Yellow

    $cnameOk = $false
    $txtOk = $false

    try {
        $cnameResult = Resolve-DnsName -Name $CustomDomain -Type CNAME -ErrorAction SilentlyContinue
        if ($cnameResult) {
            Write-Host "  ✓ CNAME record found: $($cnameResult.NameHost)" -ForegroundColor Green
            $cnameOk = $true
        }
    } catch { }

    try {
        $txtResult = Resolve-DnsName -Name "asuid.$CustomDomain" -Type TXT -ErrorAction SilentlyContinue
        if ($txtResult) {
            Write-Host "  ✓ TXT verification record found" -ForegroundColor Green
            $txtOk = $true
        }
    } catch { }

    if (-not $cnameOk -or -not $txtOk) {
        if (-not $cnameOk) {
            Write-Host "  ✗ CNAME record not found for '$CustomDomain'" -ForegroundColor Red
        }
        if (-not $txtOk) {
            Write-Host "  ✗ TXT record not found for 'asuid.$CustomDomain'" -ForegroundColor Red
        }
        Write-Host "" -ForegroundColor Red
        Write-Host "DNS records are not yet visible. Possible causes:" -ForegroundColor Red
        Write-Host "  - DNS propagation is still in progress (wait 5-15 minutes)" -ForegroundColor Red
        Write-Host "  - Domain registrar NS records don't point to Azure DNS" -ForegroundColor Red
        Write-Host "  - Records were not created (run deployment first)" -ForegroundColor Red
        Write-Host "" -ForegroundColor Yellow
        Write-Host "Use -SkipDnsCheck to bypass this check if using Azure DNS (Azure can verify its own records)." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "✓ DNS records verified" -ForegroundColor Green
} else {
    Write-Host "[0/4] DNS pre-check skipped (-SkipDnsCheck)" -ForegroundColor DarkGray
}

# Step 1: Add custom hostname to container app
Write-Host "`n[1/4] Adding custom hostname to container app..." -ForegroundColor Yellow
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
Write-Host "`n[2/4] Creating managed certificate..." -ForegroundColor Yellow
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
Write-Host "`n[3/4] Binding certificate to enable HTTPS..." -ForegroundColor Yellow
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
Write-Host "✓ Certificate bound" -ForegroundColor Green

# Step 4: Verify domain is accessible
Write-Host "`n[4/4] Verifying domain is accessible..." -ForegroundColor Yellow
$maxAttempts = 6
$accessible = $false

for ($i = 1; $i -le $maxAttempts; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "https://$CustomDomain" -UseBasicParsing -TimeoutSec 10 -ErrorAction SilentlyContinue
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
            $accessible = $true
            break
        }
    } catch {
        Write-Host "  Attempt $i/$maxAttempts - not yet responding..." -ForegroundColor DarkGray
    }
    if ($i -lt $maxAttempts) { Start-Sleep -Seconds 5 }
}

Write-Host ""
if ($accessible) {
    Write-Host "✅ Successfully configured HTTPS for $CustomDomain" -ForegroundColor Green
    Write-Host "   https://$CustomDomain is accessible now." -ForegroundColor Green
} else {
    Write-Host "⚠ Certificate bound but https://$CustomDomain is not yet responding." -ForegroundColor Yellow
    Write-Host "  This is normal if DNS hasn't fully propagated to all resolvers." -ForegroundColor Yellow
    Write-Host "  The domain should become accessible within a few minutes." -ForegroundColor Yellow
}

# Optional: Create wildcard certificate for branch deployments
if ($CreateWildcard) {
    Write-Host "`n=== Wildcard Certificate for Branch Deployments ===" -ForegroundColor Cyan
    $wildcardHost = "*.$CustomDomain"
    $wildcardCertName = "cert-wildcard-$($CustomDomain -replace '\.', '-')"

    Write-Host "  Hostname: $wildcardHost"
    Write-Host "  Certificate name: $wildcardCertName"

    $existingWildcard = az containerapp env certificate list `
        --resource-group $ResourceGroup `
        --name $EnvironmentName `
        --query "[?name=='$wildcardCertName'].name" -o tsv 2>$null

    if ($existingWildcard) {
        Write-Host "✅ Wildcard certificate already exists: $wildcardCertName" -ForegroundColor Green
    } else {
        Write-Host "Creating wildcard managed certificate..." -ForegroundColor Yellow
        az containerapp env certificate create `
            --resource-group $ResourceGroup `
            --name $EnvironmentName `
            --certificate-name $wildcardCertName `
            --hostname $wildcardHost `
            --validation-method CNAME 2>&1 | Out-Null

        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Wildcard certificate created: $wildcardCertName" -ForegroundColor Green
            Write-Host "  Branch deployments (e.g., feature-login.$CustomDomain) will use this certificate." -ForegroundColor Green
        } else {
            Write-Host "⚠ Could not create managed wildcard certificate." -ForegroundColor Yellow
            Write-Host "  Upload a wildcard certificate for '$wildcardHost' manually." -ForegroundColor Yellow
            Write-Host "  See infra/CUSTOM_DOMAIN_SETUP.md for instructions." -ForegroundColor Yellow
        }
    }
}
