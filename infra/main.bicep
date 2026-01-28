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

@description('Custom domain name for the web app (e.g., example.com)')
param customDomainName string = ''

@description('Subdomain for the web app (e.g., asteroids)')
param customSubdomain string = ''

// Determine if custom domain should be configured (only for production)
var useCustomDomain = environmentName == 'production' && !empty(customDomainName) && !empty(customSubdomain)
var fullCustomDomain = useCustomDomain ? '${customSubdomain}.${customDomainName}' : ''

// Tags for all resources
var tags = {
  'azd-env-name': environmentName
}

// Resource group
resource rg 'Microsoft.Resources/resourceGroups@2022-09-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

// Container Apps Environment with Azure Container Registry
module containerApps 'core/host/container-apps.bicep' = {
  name: 'container-apps'
  scope: rg
  params: {
    name: 'cae-${environmentName}'
    location: location
    tags: tags
    containerRegistryName: 'cr${replace(environmentName, '-', '')}${uniqueString(rg.id)}'
  }
}

// Asteroids Web Container App
module web 'core/host/container-app.bicep' = {
  name: 'web'
  scope: rg
  params: {
    name: !empty(webServiceName) ? webServiceName : 'ca-web-${environmentName}'
    location: location
    tags: union(tags, { 'azd-service-name': 'web' })
    containerAppsEnvironmentName: containerApps.outputs.environmentName
    containerRegistryName: containerApps.outputs.registryName
    imageName: !empty(webImageTag) ? 'asteroids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: 3
    customDomainName: fullCustomDomain
  }
}

// DNS Zone for custom domain (only for production)
module dnsZone 'core/dns/dns-zone.bicep' = if (useCustomDomain) {
  name: 'dns-zone'
  scope: rg
  params: {
    domainName: customDomainName
    tags: tags
  }
}

// DNS records for custom domain (only for production)
module dnsRecords 'core/dns/dns-records.bicep' = if (useCustomDomain) {
  name: 'dns-records'
  scope: rg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: web.outputs.fqdn
    verificationToken: web.outputs.verificationId
  }
  dependsOn: [dnsZone]
}

// Outputs for azd
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerApps.outputs.registryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = containerApps.outputs.registryName
output WEB_URI string = !empty(fullCustomDomain) ? 'https://${fullCustomDomain}' : web.outputs.uri
output WEB_AZURE_URI string = web.outputs.uri
output DNS_NAME_SERVERS array = useCustomDomain ? dnsZone.outputs.nameServers : []
