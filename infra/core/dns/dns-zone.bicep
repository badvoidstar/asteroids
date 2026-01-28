@description('The domain name for the DNS zone')
param domainName string

@description('Tags for resources')
param tags object = {}

// DNS Zone
resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: domainName
  location: 'global'
  tags: tags
  properties: {
    zoneType: 'Public'
  }
}

output nameServers array = dnsZone.properties.nameServers
output zoneId string = dnsZone.id
output zoneName string = dnsZone.name
