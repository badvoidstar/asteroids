# Custom Domain HTTPS Setup

## Overview
Due to Azure Container Apps requirements, custom domain HTTPS setup requires a two-stage deployment:

1. **Stage 1 (Automated)**: Deploy the infrastructure with custom domain configured but without HTTPS
   - Container App is created with custom domain in "Disabled" binding mode
   - Managed certificate is provisioned
   - DNS records are configured

2. **Stage 2 (Manual)**: Enable HTTPS certificate binding after DNS propagation
   - Run the `enable-cert-binding.ps1` script to bind the certificate

## Why Two Stages?

Azure requires the custom hostname to be added to the Container App **before** a managed certificate can be created. However, the certificate must exist **before** it can be bound to the hostname with HTTPS enabled. This creates a dependency that cannot be resolved in a single deployment.

## Deployment Instructions

### Stage 1: Initial Deployment (Automated via GitHub Actions)

The GitHub Actions workflow handles this automatically:
```bash
azd up --no-prompt
```

This will:
- Create all Azure resources
- Add the custom domain to the Container App (HTTP only)
- Create the managed certificate
- Configure DNS records

### Stage 2: Enable HTTPS (Manual)

After the deployment completes and DNS has propagated (usually 5-15 minutes), enable HTTPS:

```powershell
# Get the output values from the deployment
$resourceGroup = "rg-production"
$containerAppName = "ca-web-production"
$customDomain = "asteroids.bootyblocks.com"
$certificateId = "/subscriptions/<sub-id>/resourceGroups/rg-production/providers/Microsoft.App/managedEnvironments/cae-production/managedCertificates/cert-asteroids-bootyblocks-com"

# Run the binding script
.\infra\enable-cert-binding.ps1 `
    -ResourceGroup $resourceGroup `
    -ContainerAppName $containerAppName `
    -CustomDomain $customDomain `
    -CertificateId $certificateId
```

Or use Azure CLI directly:
```bash
az containerapp hostname bind \
    --resource-group rg-production \
    --name ca-web-production \
    --hostname asteroids.bootyblocks.com \
    --environment-certificate <certificate-id> \
    --validation-method CNAME
```

## Automated Alternative (Future Enhancement)

To fully automate this in the GitHub Actions workflow, add a second step:

```yaml
- name: Enable HTTPS Certificate Binding
  shell: pwsh
  run: |
    # Wait for DNS propagation
    Start-Sleep -Seconds 300
    
    # Get deployment outputs
    $certId = azd env get-values | grep CERTIFICATE_ID | cut -d'=' -f2 | tr -d '"'
    $appName = azd env get-values | grep CONTAINER_APP_NAME | cut -d'=' -f2 | tr -d '"'
    
    # Enable certificate binding
    ./infra/enable-cert-binding.ps1 `
      -ResourceGroup "rg-production" `
      -ContainerAppName $appName `
      -CustomDomain "asteroids.bootyblocks.com" `
      -CertificateId $certId
```

## Troubleshooting

### Certificate Creation Fails
- Ensure DNS records are properly configured
- Verify the CNAME points to the Container App FQDN
- Check the TXT record for domain verification

### HTTPS Binding Fails
- Confirm the managed certificate status is "Succeeded"
- Verify DNS has fully propagated (use `nslookup`)
- Ensure the custom domain is already added to the Container App

### Certificate Status Check
```bash
az containerapp env certificate list \
    --resource-group rg-production \
    --name cae-production \
    --query "[?properties.subjectName=='asteroids.bootyblocks.com']" \
    --output table
```
