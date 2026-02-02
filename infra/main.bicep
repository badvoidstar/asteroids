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

// Determine if this is production or a branch deployment
var isProduction = environmentName == 'production'

// For branch deployments, use production's shared infrastructure
var sharedEnvironmentName = 'production'
var sharedResourceGroupName = 'rg-${sharedEnvironmentName}'

// Determine if custom domain should be configured
var useCustomDomain = !empty(customDomainName) && !empty(customSubdomain)
var fullCustomDomain = useCustomDomain ? '${customSubdomain}.${customDomainName}' : ''

// Tags for all resources
var tags = {
  'azd-env-name': environmentName
}

// Resource group - production creates new, branches use production's
resource rg 'Microsoft.Resources/resourceGroups@2022-09-01' = if (isProduction) {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

// Reference to production resource group for branch deployments
resource sharedRg 'Microsoft.Resources/resourceGroups@2022-09-01' existing = if (!isProduction) {
  name: sharedResourceGroupName
}

// Effective resource group reference
var effectiveRgName = isProduction ? 'rg-${environmentName}' : sharedResourceGroupName

// Container Apps Environment with Azure Container Registry (only for production)
module containerApps 'core/host/container-apps.bicep' = if (isProduction) {
  name: 'container-apps'
  scope: rg
  params: {
    name: 'cae-${environmentName}'
    location: location
    tags: tags
    containerRegistryName: 'cr${replace(environmentName, '-', '')}${uniqueString(rg.id)}'
  }
}

// For branch deployments, reference existing shared infrastructure
module sharedContainerAppsRef 'core/host/container-apps-ref.bicep' = if (!isProduction) {
  name: 'container-apps-ref'
  scope: sharedRg
  params: {
    environmentName: 'cae-${sharedEnvironmentName}'
    registryNamePrefix: 'cr${replace(sharedEnvironmentName, '-', '')}'
  }
}

// Effective infrastructure values
var effectiveEnvironmentName = isProduction ? containerApps.outputs.environmentName : sharedContainerAppsRef.outputs.environmentName
var effectiveRegistryName = isProduction ? containerApps.outputs.registryName : sharedContainerAppsRef.outputs.registryName
var effectiveRegistryLoginServer = isProduction ? containerApps.outputs.registryLoginServer : sharedContainerAppsRef.outputs.registryLoginServer

// Container App - created in appropriate resource group
module web 'core/host/container-app.bicep' = {
  name: 'web-${environmentName}'
  scope: isProduction ? rg : sharedRg
  params: {
    name: !empty(webServiceName) ? webServiceName : 'ca-web-${environmentName}'
    location: location
    tags: union(tags, { 'azd-service-name': 'web' })
    containerAppsEnvironmentName: effectiveEnvironmentName
    containerRegistryName: effectiveRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: isProduction ? 3 : 1  // Limit branch deployments to 1 replica
    customDomainName: ''  // Don't add custom domain in initial deployment
  }
  dependsOn: isProduction ? [containerApps] : [sharedContainerAppsRef]
}

// DNS Zone for custom domain (only for production - branches reuse it)
module dnsZone 'core/dns/dns-zone.bicep' = if (isProduction && useCustomDomain) {
  name: 'dns-zone'
  scope: rg
  params: {
    domainName: customDomainName
    tags: tags
  }
}

// DNS records for custom domain
module dnsRecords 'core/dns/dns-records.bicep' = if (useCustomDomain) {
  name: 'dns-records-${environmentName}'
  scope: isProduction ? rg : sharedRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: web.outputs.fqdn
    verificationToken: web.outputs.verificationId
  }
  dependsOn: isProduction ? [dnsZone] : []
}

// Outputs for azd
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = effectiveRegistryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = effectiveRegistryName
output WEB_URI string = web.outputs.uri
output WEB_AZURE_URI string = web.outputs.uri
#disable-next-line BCP318
output DNS_NAME_SERVERS array = (isProduction && useCustomDomain) ? dnsZone.outputs.nameServers : []
output CONTAINER_APP_NAME string = web.outputs.name
output CONTAINER_APPS_ENVIRONMENT string = effectiveEnvironmentName
output RESOURCE_GROUP string = effectiveRgName
output CUSTOM_DOMAIN string = fullCustomDomain
output DOMAIN_VERIFICATION_ID string = web.outputs.verificationId
