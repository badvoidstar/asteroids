# Custom Domain HTTPS Setup

## Overview
Custom domain configuration for Azure Container Apps requires DNS verification to be in place before the domain can be added. The deployment handles this in two phases:

1. **Phase 1 (Automated)**: Deploy the app without custom domain, create DNS zone and verification records
2. **Phase 2 (Automated with retry)**: Add custom domain and enable HTTPS after DNS propagates

## How It Works

### Initial Deployment
When you deploy to the `production` environment, the workflow:
1. Creates the Container App (without custom domain)
2. Creates the Azure DNS Zone for `example.com`
3. Creates DNS records:
   - CNAME record: `astervoids.example.com` → Container App FQDN
   - TXT record: `asuid.astervoids.example.com` → Domain verification ID

### Custom Domain Setup
After the base deployment, the workflow attempts to:
1. Add the custom hostname to the Container App
2. Create a managed SSL certificate
3. Bind the certificate to enable HTTPS

**Note**: This step uses `continue-on-error: true` because DNS propagation may not be complete on the first deployment. Subsequent deployments will succeed once DNS has propagated.

## DNS Configuration

### If Using Azure DNS (Recommended)
The deployment automatically creates the DNS zone and records. You need to configure your domain registrar to use Azure's name servers:

```
ns1-XX.azure-dns.com
ns2-XX.azure-dns.net
ns3-XX.azure-dns.org
ns4-XX.azure-dns.info
```

The name servers are output after deployment as `DNS_NAME_SERVERS`.

### If Using External DNS
If your domain is hosted elsewhere, you need to manually create:

1. **CNAME Record**:
   - Name: `astervoids` (or your subdomain)
   - Value: `<container-app-fqdn>` (e.g., `ca-web-production.redfield-xxxxx.eastus.azurecontainerapps.io`)

2. **TXT Record** (for domain verification):
   - Name: `asuid.astervoids` (or `asuid.<your-subdomain>`)
   - Value: The `DOMAIN_VERIFICATION_ID` from deployment output

## Manual Custom Domain Setup

If the automated setup fails (e.g., DNS not propagated yet), run manually:

```powershell
# From the repository root
.\infra\enable-custom-domain.ps1 `
    -ResourceGroup "rg-production" `
    -ContainerAppName "ca-web-production" `
    -EnvironmentName "cae-production" `
    -CustomDomain "astervoids.example.com"
```

Or using Azure CLI:

```bash
# 1. Add hostname
az containerapp hostname add \
    --resource-group rg-production \
    --name ca-web-production \
    --hostname astervoids.example.com

# 2. Create certificate
az containerapp env certificate create \
    --resource-group rg-production \
    --name cae-production \
    --certificate-name cert-astervoids-bootyblocks-com \
    --hostname astervoids.example.com \
    --validation-method CNAME

# 3. Bind certificate
az containerapp hostname bind \
    --resource-group rg-production \
    --name ca-web-production \
    --hostname astervoids.example.com \
    --environment cae-production \
    --validation-method CNAME
```

## Troubleshooting

### "TXT record not found" Error
This means DNS verification records haven't propagated yet. Solutions:
- Wait 5-15 minutes and re-run the deployment
- Verify DNS records are correctly configured at your registrar
- Check if you're using Azure DNS name servers

### Check DNS Propagation
```bash
# Check TXT record
nslookup -type=TXT asuid.astervoids.example.com

# Check CNAME record  
nslookup astervoids.example.com
```

### View Current Configuration
```bash
# List hostnames on container app
az containerapp hostname list \
    --resource-group rg-production \
    --name ca-web-production

# List certificates in environment
az containerapp env certificate list \
    --resource-group rg-production \
    --name cae-production
```
