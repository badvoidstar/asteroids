# GitHub Actions CI/CD Setup Guide

This document explains how to configure the GitHub Actions workflow for automatic build and deployment to Azure.

## Overview

The CI/CD pipeline automatically:
- **Builds** the .NET application on every push and pull request
- **Tests** the application to ensure code quality
- **Deploys** to Azure Container Apps when code is pushed to the `main` branch

## Prerequisites

Before the workflow can run successfully, you need to:

1. An Azure subscription
2. Azure CLI installed locally (for setup)
3. Appropriate permissions to create service principals or configure workload identity federation

## Setup Instructions

### Option 1: Using Workload Identity Federation (OIDC) - Recommended

Workload Identity Federation is the modern, more secure approach that doesn't require managing secrets.

#### Step 1: Create an Azure AD App Registration

```bash
# Login to Azure
az login

# Set your subscription
az account set --subscription "<your-subscription-id>"

# Create an App Registration
az ad app create --display-name "GitHub-Asteroids-Deploy"
```

Note the `appId` from the output - this is your `AZURE_CLIENT_ID`.

#### Step 2: Create a Service Principal

```bash
# Create service principal (replace <app-id> with the appId from step 1)
az ad sp create --id <app-id>
```

#### Step 3: Assign Contributor Role

```bash
# Get your subscription ID
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Assign Contributor role to the service principal
az role assignment create \
  --role Contributor \
  --assignee <app-id> \
  --scope /subscriptions/$SUBSCRIPTION_ID
```

#### Step 4: Configure Federated Credentials

```bash
# Get your GitHub repository information
GITHUB_ORG="badvoidstar"
GITHUB_REPO="asteroids"

# Create federated credential for main branch
az ad app federated-credential create \
  --id <app-id> \
  --parameters '{
    "name": "github-main-branch",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:'"$GITHUB_ORG/$GITHUB_REPO"':ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'

# Optional: Create federated credential for pull requests
az ad app federated-credential create \
  --id <app-id> \
  --parameters '{
    "name": "github-pull-requests",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:'"$GITHUB_ORG/$GITHUB_REPO"':pull_request",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

#### Step 5: Add GitHub Secrets

Add the following secrets to your GitHub repository (Settings → Secrets and variables → Actions):

1. `AZURE_CLIENT_ID` - The appId from step 1
2. `AZURE_TENANT_ID` - Your Azure AD tenant ID (get it with `az account show --query tenantId -o tsv`)
3. `AZURE_SUBSCRIPTION_ID` - Your subscription ID (get it with `az account show --query id -o tsv`)

### Option 2: Using Service Principal with Secret (Legacy)

If you prefer to use a client secret instead of OIDC:

```bash
# Create service principal with contributor role
az ad sp create-for-rbac \
  --name "GitHub-Asteroids-Deploy" \
  --role Contributor \
  --scopes /subscriptions/<subscription-id> \
  --sdk-auth
```

This will output JSON. Add the following to GitHub Secrets:
- `AZURE_CREDENTIALS` - The entire JSON output
- `AZURE_SUBSCRIPTION_ID` - Your subscription ID

Then update the workflow file to use `azure/login@v2` with the credentials parameter:

```yaml
- name: Log in to Azure
  uses: azure/login@v2
  with:
    creds: ${{ secrets.AZURE_CREDENTIALS }}
```

## Testing the Workflow

### Automatic Trigger

The workflow will automatically run when:
- Code is pushed to the `main` branch (builds, tests, and deploys)
- A pull request is opened against `main` (builds and tests only)

### Manual Trigger

You can manually trigger the workflow:
1. Go to the "Actions" tab in your GitHub repository
2. Select the "Build and Deploy to Azure" workflow
3. Click "Run workflow"

## Monitoring Deployments

After deployment:
- Check the "Actions" tab to view workflow runs
- View deployment logs in the workflow run details
- Access the deployed application at the URL shown in the deployment summary
- Monitor the application in the [Azure Portal](https://portal.azure.com)

## Workflow Configuration

The workflow is defined in `.github/workflows/azure-deploy.yml` and includes:

### Build Job
- Checks out the code
- Sets up .NET 8.0
- Restores dependencies
- Builds the solution
- Runs tests

### Deploy Job (main branch only)
- Installs Azure Developer CLI (azd)
- Authenticates to Azure using OIDC
- Provisions infrastructure (if needed) using Bicep templates
- Deploys the containerized application to Azure Container Apps
- Outputs the deployment URL

## Customization

### Environment Variables

You can customize the deployment by modifying these variables in the workflow file:

- `AZURE_ENV_NAME`: The environment name (default: `production`)
- `DOTNET_VERSION`: The .NET SDK version (default: `8.0.x`)
- `AZURE_LOCATION`: The Azure region (default: `eastus`)

### Infrastructure

The infrastructure is defined using Bicep templates in the `/infra` directory:
- `main.bicep` - Main infrastructure definition
- `main.parameters.json` - Parameters for the Bicep template

To modify the infrastructure, edit these files and the changes will be applied on the next deployment.

## Troubleshooting

### Authentication Errors

If you see authentication errors:
1. Verify that all GitHub secrets are correctly set
2. Ensure the service principal has the correct permissions
3. For OIDC, verify the federated credentials are correctly configured

### Deployment Failures

If deployment fails:
1. Check the workflow logs in the Actions tab
2. Verify that your Azure subscription has enough quota for Container Apps
3. Review the Azure Developer CLI logs for detailed error messages

### Build Failures

If the build fails:
1. Ensure the .NET SDK version matches the project requirements
2. Check for any missing dependencies
3. Run the build locally to reproduce the issue: `dotnet build agentic.sln`

## Additional Resources

- [Azure Developer CLI Documentation](https://learn.microsoft.com/azure/developer/azure-developer-cli/)
- [GitHub Actions Documentation](https://docs.github.com/actions)
- [Azure Container Apps Documentation](https://learn.microsoft.com/azure/container-apps/)
- [Workload Identity Federation](https://learn.microsoft.com/azure/active-directory/develop/workload-identity-federation)
