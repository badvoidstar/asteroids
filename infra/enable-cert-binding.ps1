#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Enables HTTPS certificate binding for a custom domain on a Container App.

.DESCRIPTION
    This script updates a Container App to bind a managed certificate to a custom domain.
    Run this after the initial deployment has created the certificate.

.PARAMETER ResourceGroup
    The name of the resource group containing the Container App.

.PARAMETER ContainerAppName
    The name of the Container App to update.

.PARAMETER CustomDomain
    The custom domain name (e.g., asteroids.bootyblocks.com).

.PARAMETER CertificateId
    The resource ID of the managed certificate.

.EXAMPLE
    .\enable-cert-binding.ps1 -ResourceGroup "rg-production" `
        -ContainerAppName "ca-web-production" `
        -CustomDomain "asteroids.bootyblocks.com" `
        -CertificateId "/subscriptions/.../managedCertificates/cert-asteroids-bootyblocks-com"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory=$true)]
    [string]$ContainerAppName,

    [Parameter(Mandatory=$true)]
    [string]$CustomDomain,

    [Parameter(Mandatory=$true)]
    [string]$CertificateId
)

Write-Host "Enabling HTTPS certificate binding for $CustomDomain on $ContainerAppName..." -ForegroundColor Cyan

# Update the container app to enable SNI certificate binding
az containerapp hostname bind `
    --resource-group $ResourceGroup `
    --name $ContainerAppName `
    --hostname $CustomDomain `
    --environment-certificate $CertificateId `
    --validation-method CNAME

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Successfully enabled HTTPS for $CustomDomain" -ForegroundColor Green
    Write-Host "The custom domain is now accessible at https://$CustomDomain" -ForegroundColor Green
} else {
    Write-Host "✗ Failed to enable certificate binding" -ForegroundColor Red
    exit 1
}
