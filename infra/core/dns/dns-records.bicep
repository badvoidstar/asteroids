@description('Name of the DNS zone')
param dnsZoneName string

@description('Subdomain name (e.g., "astervoids" for astervoids.domain.com)')
param subdomain string

@description('Target hostname for the CNAME record')
param targetHostname string

@description('Domain verification token from Container App')
param verificationToken string

// Reference existing DNS zone
resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: dnsZoneName
}

// CNAME record for the subdomain
resource cnameRecord 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = {
  parent: dnsZone
  name: subdomain
  properties: {
    TTL: 3600
    CNAMERecord: {
      cname: targetHostname
    }
  }
}

// TXT record for domain verification
resource txtRecord 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: dnsZone
  name: 'asuid.${subdomain}'
  properties: {
    TTL: 3600
    TXTRecords: [
      {
        value: [verificationToken]
      }
    ]
  }
}

output fqdn string = '${subdomain}.${dnsZoneName}'
