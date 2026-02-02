// Reference existing Container Apps infrastructure (for branch deployments)
// This module finds and returns references to existing shared infrastructure

@description('Name of the existing Container Apps Environment')
param environmentName string

@description('Prefix of the Container Registry name')
param registryNamePrefix string

// Reference existing Container Apps Environment
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: environmentName
}

// Reference existing Container Registry (name includes unique suffix based on resource group)
var registryName = '${registryNamePrefix}${uniqueString(resourceGroup().id)}'

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

output environmentName string = containerAppsEnvironment.name
output environmentId string = containerAppsEnvironment.id
output registryName string = containerRegistry.name
output registryLoginServer string = containerRegistry.properties.loginServer
