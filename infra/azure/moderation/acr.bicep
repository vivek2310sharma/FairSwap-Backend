@description('Deployment environment: test or prod')
@allowed([
  'test'
  'prod'
])
param environment string = 'test'

@description('Azure location (Central India)')
param location string = 'centralindia'

@description('Unique suffix for resource names')
param suffix string = uniqueString(resourceGroup().id)

var acrName = 'crfairswapmod${environment}${suffix}'

// Azure Container Registry
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output acrId string = acr.id

