# Custom Domain HTTPS Setup

## Overview
Custom domain configuration for Azure Container Apps requires DNS verification to be in place before the domain can be added. The deployment handles this in two phases:

1. **Phase 1 (Automated)**: Deploy the app without custom domain, create DNS zone and verification records
2. **Phase 2 (Automated with retry)**: Add custom domain and enable HTTPS after DNS propagates

## Prerequisites: GitHub Secrets

To enable custom domain support, you must configure these GitHub Secrets:

| Secret | Example Value | Description |
|--------|---------------|-------------|
| `CUSTOM_DOMAIN_NAME` | `yourdomain.com` | Your root domain name |
| `CUSTOM_SUBDOMAIN` | `app` | Subdomain for the application |

If these secrets are not set, the deployment will succeed but skip custom domain configuration entirely.

**To add secrets:** Go to your repo → Settings → Secrets and variables → Actions → New repository secret

## How It Works

### Initial Deployment
When you deploy to the `production` environment with secrets configured, the workflow:
1. Creates the Container App (without custom domain)
2. Creates the Azure DNS Zone for your domain
3. Creates DNS records:
   - CNAME record: `<subdomain>.<yourdomain.com>` → Container App FQDN
   - TXT record: `asuid.<subdomain>.<yourdomain.com>` → Domain verification ID

### Custom Domain Setup
After the base deployment, the workflow attempts to:
1. Add the custom hostname to the Container App
2. Create a managed SSL certificate for the production domain
3. Bind the certificate to enable HTTPS

**Note**: This step uses `continue-on-error: true` because DNS propagation may not be complete on the first deployment. Subsequent deployments will succeed once DNS has propagated.

### Branch Deployments
Branch deployments (e.g., `feature-login.app.yourdomain.com`) each get their own free managed certificate, just like production. No wildcard certificate is needed — the workflow automatically creates a per-branch managed certificate for each branch's specific subdomain.

When a branch is deleted, the cleanup workflow removes the branch's container app, DNS records, and managed certificate.

### Deployment Verification
After custom domain setup, the workflow verifies that all URLs are actually accessible:
- **Azure URL** (`*.azurecontainerapps.io`): Verified with HTTP request (retries up to 5 times)
- **Custom domain**: Checked for DNS resolution and HTTPS accessibility

The deployment summary uses status indicators to show what is ready:
- ✅ URL is accessible right now
- ⏳ URL is not yet accessible (DNS propagation or certificate provisioning in progress)

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
   - Name: `<your-subdomain>` (e.g., `app`)
   - Value: `<container-app-fqdn>` (e.g., `ca-web-production.redfield-xxxxx.eastus.azurecontainerapps.io`)

2. **TXT Record** (for domain verification):
   - Name: `asuid.<your-subdomain>` (e.g., `asuid.app`)
   - Value: The `DOMAIN_VERIFICATION_ID` from deployment output

## Manual Custom Domain Setup

If the automated setup fails (e.g., DNS not propagated yet), run manually:

```powershell
# From the repository root
.\infra\enable-custom-domain.ps1 `
    -ResourceGroup "rg-production" `
    -ContainerAppName "ca-web-production" `
    -EnvironmentName "cae-production" `
    -CustomDomain "app.yourdomain.com"
```

The script will:
1. **Pre-check DNS** — verifies CNAME and TXT records resolve before proceeding
2. Add the custom hostname
3. Create and bind a managed certificate
4. **Post-verify** — confirms `https://app.yourdomain.com` is actually accessible

If DNS is hosted in Azure DNS (same subscription), you can skip the DNS pre-check since Azure Container Apps can verify its own DNS directly:

```powershell
.\infra\enable-custom-domain.ps1 `
    -ResourceGroup "rg-production" `
    -ContainerAppName "ca-web-production" `
    -EnvironmentName "cae-production" `
    -CustomDomain "app.yourdomain.com" `
    -SkipDnsCheck
```

Or using Azure CLI directly:

```bash
# 1. Add hostname
az containerapp hostname add \
    --resource-group rg-production \
    --name ca-web-production \
    --hostname app.yourdomain.com

# 2. Create certificate
az containerapp env certificate create \
    --resource-group rg-production \
    --name cae-production \
    --certificate-name cert-app-yourdomain-com \
    --hostname app.yourdomain.com \
    --validation-method CNAME

# 3. Bind certificate
az containerapp hostname bind \
    --resource-group rg-production \
    --name ca-web-production \
    --hostname app.yourdomain.com \
    --environment cae-production \
    --validation-method CNAME
```

## Troubleshooting

### "TXT record not found" Error
This means DNS verification records haven't propagated yet. Solutions:
- Wait 5-15 minutes and re-run the deployment
- Verify DNS records are correctly configured at your registrar
- Check if you're using Azure DNS name servers

### Deployment Summary Shows ⏳ for Custom Domain
This means the deployment succeeded but the custom domain is not yet publicly accessible:
- **"waiting for DNS propagation"**: DNS record changes (CNAME/TXT) typically propagate in 5-30 minutes. If this is a first-time setup requiring NS record changes at your domain registrar, propagation can take up to 48 hours.
- **"certificate may still be provisioning"**: DNS resolves but the TLS certificate isn't ready. Usually resolves in 1-5 minutes.
- The Azure URL (`*.azurecontainerapps.io`) is always immediately accessible — use it in the meantime.

### Check DNS Propagation
```bash
# Check TXT record (replace with your domain)
nslookup -type=TXT asuid.app.yourdomain.com

# Check CNAME record  
nslookup app.yourdomain.com
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

## Manual Deployments with `azd`

When deploying manually with `azd` (instead of through the GitHub Actions workflow):

### `azd up` (Create)

`azd up` provisions all infrastructure via Bicep templates and deploys the application:
- **Standalone** (`azd up` with any non-production environment name): Creates its own resource group, Container Apps Environment, Container Registry, and Container App. No custom domain configuration.
- **Production** (`azd up` with `AZURE_ENV_NAME=production`): Creates `rg-production` with all shared infrastructure plus DNS zone and records.

The environment name determines the deployment path — see `isProduction = environmentName == 'production'` in `infra/main.bicep`.

Custom domain and certificates are **not** configured by `azd up` — they are handled by the GitHub Actions workflow. For manual deployments, run `enable-custom-domain.ps1` after `azd up`:

```powershell
azd up                                    # Creates infrastructure + deploys app
.\infra\enable-custom-domain.ps1 `        # Configures custom domain + certificates
    -ResourceGroup "rg-production" `
    -ContainerAppName "ca-web-production" `
    -EnvironmentName "cae-production" `
    -CustomDomain "app.yourdomain.com" `
    -SkipDnsCheck
```

### `azd down` (Destroy)

`azd down` deletes the resource group and all resources within it:
- All Container Apps (including any branch deployments sharing the resource group)
- Container Apps Environment (including all certificates — production and per-branch)
- Container Registry
- DNS Zone (including all DNS records)

No orphaned resources are left behind.

## Branch Deployment Certificates

Branch deployments each receive their own free Azure managed certificate. No wildcard certificate or manual certificate management is required.

### How It Works

1. When a branch is deployed, the workflow creates a DNS record for the branch subdomain (e.g., `feature-login.app.yourdomain.com`)
2. The workflow creates a managed certificate for that specific hostname using `az containerapp env certificate create`
3. The certificate is bound to the branch's Container App
4. When the branch is deleted, the cleanup workflow removes the certificate along with the Container App and DNS records

### Certificate Naming Convention

Each branch certificate follows this naming pattern:
- **Name:** `cert-{branch}-{subdomain}-{domain}` (e.g., `cert-feature-login-app-yourdomain-com`)
- **Hostname:** `{branch}.{subdomain}.{domain}` (e.g., `feature-login.app.yourdomain.com`)

### Why Not Wildcard Certificates?

Azure Container Apps managed certificates do **not** support wildcard hostnames (e.g., `*.app.yourdomain.com`). The `*` character is rejected by the API with an `InvalidCharactersInHostname` error. This is a documented platform limitation — see [Microsoft Learn: Custom domain names and free managed certificates](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates).

Per-branch managed certificates are the recommended approach because they are:
- **Free** — no certificate purchase required
- **Automatic** — created and bound by the workflow
- **Auto-renewed** — Azure handles renewal
- **Cleaned up** — removed when the branch is deleted
