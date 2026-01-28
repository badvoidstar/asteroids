@description('Name of the Container App')
param name string

@description('Location for resources')
param location string = resourceGroup().location

@description('Tags for resources')
param tags object = {}

@description('Name of the Container Apps Environment')
param containerAppsEnvironmentName string

@description('Name of the Container Registry')
param containerRegistryName string

@description('Container image name (leave empty for initial deployment)')
param imageName string = ''

@description('Target port for the container')
param targetPort int = 8080

@description('Allow external ingress')
param external bool = true

@description('Minimum number of replicas')
param minReplicas int = 0

@description('Maximum number of replicas')
param maxReplicas int = 3

@description('CPU cores allocated to the container')
param cpu string = '0.25'

@description('Memory allocated to the container')
param memory string = '0.5Gi'

@description('Environment variables for the container')
param env array = []

@description('Custom domain name (optional, e.g., astervoids.example.com)')
param customDomainName string = ''

// Reference existing Container Apps Environment
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: containerAppsEnvironmentName
}

// Reference existing Container Registry
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

// Container App
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: external
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
        customDomains: !empty(customDomainName) ? [
          {
            name: customDomainName
            bindingType: 'SniEnabled'
            certificateId: managedCertificate.id
          }
        ] : []
      }
      registries: [
        {
          server: containerRegistry.properties.loginServer
          username: containerRegistry.listCredentials().username
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: [
        {
          name: 'registry-password'
          value: containerRegistry.listCredentials().passwords[0].value
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'main'
          image: !empty(imageName) ? '${containerRegistry.properties.loginServer}/${imageName}' : 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: env
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-rule'
            http: {
              metadata: {
                concurrentRequests: '100'
              }
            }
          }
        ]
      }
    }
  }
}

// Managed certificate for custom domain (only created if custom domain is specified)
resource managedCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2023-05-01' = if (!empty(customDomainName)) {
  name: 'cert-${replace(customDomainName, '.', '-')}'
  parent: containerAppsEnvironment
  location: location
  tags: tags
  properties: {
    subjectName: customDomainName
    domainControlValidation: 'CNAME'
  }
}

output name string = containerApp.name
output uri string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output customUri string = !empty(customDomainName) ? 'https://${customDomainName}' : ''
output id string = containerApp.id
output fqdn string = containerApp.properties.configuration.ingress.fqdn
output verificationId string = containerApp.properties.customDomainVerificationId
