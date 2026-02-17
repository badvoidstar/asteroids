targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment (used to generate resource names)')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

@description('Name of the container app')
param webServiceName string = ''

@description('Container image tag')
param webImageTag string = ''

@description('Custom domain name for the web app (e.g., yourdomain.com)')
param customDomainName string = ''

@description('Subdomain for the web app (e.g., app)')
param customSubdomain string = ''

@description('Use shared production infrastructure (for CI/CD branch deployments). When false, creates standalone infra.')
param useSharedInfra bool = false

// Determine deployment path
var isProduction = environmentName == 'production'
var isBranch = !isProduction && useSharedInfra
var isStandalone = !isProduction && !useSharedInfra

// For branch deployments, use production's shared infrastructure
var sharedResourceGroupName = 'rg-production'

// Resource naming per deployment path
var containerRegistryName = isStandalone
  ? 'cr${environmentName}${uniqueString(subscription().subscriptionId, 'rg-${environmentName}')}'
  : 'crproduction${uniqueString(subscription().subscriptionId, sharedResourceGroupName)}'
var containerAppsEnvironmentName = isStandalone ? 'cae-${environmentName}' : 'cae-production'

// Determine if custom domain should be configured
var useCustomDomain = !empty(customDomainName) && !empty(customSubdomain)
var fullCustomDomain = useCustomDomain ? '${customSubdomain}.${customDomainName}' : ''

// Tags for all resources
var tags = {
  'azd-env-name': environmentName
}

// ============================================================================
// PRODUCTION DEPLOYMENT PATH
// ============================================================================

// Resource group for production
resource productionRg 'Microsoft.Resources/resourceGroups@2022-09-01' = if (isProduction) {
  name: 'rg-production'
  location: location
  tags: tags
}

// Container Apps Environment with Azure Container Registry (production only)
module containerAppsProduction 'core/host/container-apps.bicep' = if (isProduction) {
  name: 'container-apps'
  scope: productionRg
  params: {
    name: containerAppsEnvironmentName
    location: location
    tags: tags
    containerRegistryName: containerRegistryName
  }
}

// Production Container App
module webProduction 'core/host/container-app.bicep' = if (isProduction) {
  name: 'web-production'
  scope: productionRg
  params: {
    name: !empty(webServiceName) ? webServiceName : 'ca-web-production'
    location: location
    tags: union(tags, { 'azd-service-name': 'web' })
    containerAppsEnvironmentName: containerAppsEnvironmentName
    containerRegistryName: containerRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: 1
    customDomainName: ''
  }
  dependsOn: [containerAppsProduction]
}

// DNS Zone for custom domain (production only)
module dnsZone 'core/dns/dns-zone.bicep' = if (isProduction && useCustomDomain) {
  name: 'dns-zone'
  scope: productionRg
  params: {
    domainName: customDomainName
    tags: tags
  }
}

// DNS records for production custom domain
module dnsRecordsProduction 'core/dns/dns-records.bicep' = if (isProduction && useCustomDomain) {
  name: 'dns-records-production'
  scope: productionRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: webProduction.outputs.fqdn
    verificationToken: webProduction.outputs.verificationId
  }
  dependsOn: [dnsZone]
}

// ============================================================================
// STANDALONE DEPLOYMENT PATH (local dev via azd up)
// ============================================================================

// Resource group for standalone deployments
resource standaloneRg 'Microsoft.Resources/resourceGroups@2022-09-01' = if (isStandalone) {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

// Container Apps Environment with Azure Container Registry (standalone)
module containerAppsStandalone 'core/host/container-apps.bicep' = if (isStandalone) {
  name: 'container-apps-standalone'
  scope: standaloneRg
  params: {
    name: containerAppsEnvironmentName
    location: location
    tags: tags
    containerRegistryName: containerRegistryName
  }
}

// Standalone Container App
module webStandalone 'core/host/container-app.bicep' = if (isStandalone) {
  name: 'web-standalone'
  scope: standaloneRg
  params: {
    name: !empty(webServiceName) ? webServiceName : 'ca-web-${environmentName}'
    location: location
    tags: union(tags, { 'azd-service-name': 'web' })
    containerAppsEnvironmentName: containerAppsEnvironmentName
    containerRegistryName: containerRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: 1
    customDomainName: ''
  }
  dependsOn: [containerAppsStandalone]
}

// ============================================================================
// BRANCH DEPLOYMENT PATH (CI/CD, uses shared production infra)
// ============================================================================

// Reference to existing production resource group for branch deployments
resource sharedRg 'Microsoft.Resources/resourceGroups@2022-09-01' existing = if (isBranch) {
  name: sharedResourceGroupName
}

// Branch Container App (uses existing shared infrastructure)
module webBranch 'core/host/container-app.bicep' = if (isBranch) {
  name: 'web-${environmentName}'
  scope: sharedRg
  params: {
    name: !empty(webServiceName) ? webServiceName : 'ca-web-${environmentName}'
    location: location
    tags: union(tags, { 'azd-service-name': 'web-${environmentName}' })  // Unique tag per branch
    containerAppsEnvironmentName: containerAppsEnvironmentName
    containerRegistryName: containerRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: 1  // Limit branch deployments
    customDomainName: ''
  }
}

// DNS records for branch custom domain (uses existing DNS zone in production RG)
module dnsRecordsBranch 'core/dns/dns-records.bicep' = if (isBranch && useCustomDomain) {
  name: 'dns-records-${environmentName}'
  scope: sharedRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: webBranch.outputs.fqdn
    verificationToken: webBranch.outputs.verificationId
  }
}

// ============================================================================
// OUTPUTS
// ============================================================================

// Use conditional outputs based on deployment type
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = isProduction ? containerAppsProduction.outputs.registryLoginServer : (isStandalone ? containerAppsStandalone.outputs.registryLoginServer : '${containerRegistryName}.azurecr.io')
output AZURE_CONTAINER_REGISTRY_NAME string = containerRegistryName
output WEB_URI string = isProduction ? webProduction.outputs.uri : (isStandalone ? webStandalone.outputs.uri : webBranch.outputs.uri)
output WEB_AZURE_URI string = isProduction ? webProduction.outputs.uri : (isStandalone ? webStandalone.outputs.uri : webBranch.outputs.uri)
#disable-next-line BCP318
output DNS_NAME_SERVERS array = (isProduction && useCustomDomain) ? dnsZone.outputs.nameServers : []
output CONTAINER_APP_NAME string = isProduction ? webProduction.outputs.name : (isStandalone ? webStandalone.outputs.name : webBranch.outputs.name)
output CONTAINER_APPS_ENVIRONMENT string = containerAppsEnvironmentName
output RESOURCE_GROUP string = isProduction ? 'rg-production' : (isStandalone ? 'rg-${environmentName}' : sharedResourceGroupName)
output CUSTOM_DOMAIN string = fullCustomDomain
output DOMAIN_VERIFICATION_ID string = isProduction ? webProduction.outputs.verificationId : (isStandalone ? webStandalone.outputs.verificationId : webBranch.outputs.verificationId)
