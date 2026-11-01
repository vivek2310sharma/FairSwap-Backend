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

@description('OpenAI API Key for Moderation')
@secure()
param openAiApiKey string

@description('Shared Moderation Secret between Supabase and Azure Container Apps (min 16 chars)')
@secure()
param moderationSecret string

@description('Allowed Supabase project storage host (e.g. wpppxlnbzqynvhpeuavd.supabase.co for test, kriuhwppxgxsyyrbjsau.supabase.co for prod)')
param allowedStorageHost string

@description('Container image tag to deploy')
param imageTag string = 'latest'

var logAnalyticsWorkspaceName = 'law-fairswap-moderation-${environment}-${suffix}'
var containerAppEnvName = 'cae-fairswap-moderation-${environment}-${suffix}'
var acrName = 'crfairswapmod${environment}${suffix}'

// 1. Log Analytics Workspace
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// 2. Azure Container Registry reference
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

// 3. User Assigned Managed Identity
resource acaIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-fairswap-moderation-${environment}'
  location: location
}

// Role definition: AcrPull (7f951dda-4ed3-4680-a7ca-43fe172d538d)
resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, acaIdentity.id, 'AcrPull')
  scope: acr
  properties: {
    principalId: acaIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalType: 'ServicePrincipal'
  }
}

// 4. Container Apps Environment (Consumption Tier)
resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppEnvName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

// 5. Container App: Node Vision Worker
resource nodeVisionApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-node-vision-${environment}'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acaIdentity.id}': {}
    }
  }
  dependsOn: [
    acrPullRole
  ]
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      registries: [
        {
          server: acr.properties.loginServer
          identity: acaIdentity.id
        }
      ]
      secrets: [
        {
          name: 'mod-secret'
          value: moderationSecret
        }
      ]
      ingress: {
        external: false
        targetPort: 8081
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: 'node-vision'
          image: '${acr.properties.loginServer}/node-vision:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '8081'
            }
            {
              name: 'MODERATION_SECRET'
              secretRef: 'mod-secret'
            }
            {
              name: 'ALLOWED_STORAGE_HOST'
              value: allowedStorageHost
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8081
              }
              initialDelaySeconds: 15
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: environment == 'prod' ? 5 : 2
      }
    }
  }
}

// 6. Container App: Python OCR Worker
resource pythonOcrApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-python-ocr-${environment}'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acaIdentity.id}': {}
    }
  }
  dependsOn: [
    acrPullRole
  ]
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      registries: [
        {
          server: acr.properties.loginServer
          identity: acaIdentity.id
        }
      ]
      secrets: [
        {
          name: 'mod-secret'
          value: moderationSecret
        }
      ]
      ingress: {
        external: false
        targetPort: 8082
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: 'python-ocr'
          image: '${acr.properties.loginServer}/python-ocr:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '8082'
            }
            {
              name: 'MODERATION_SECRET'
              secretRef: 'mod-secret'
            }
            {
              name: 'ALLOWED_STORAGE_HOST'
              value: allowedStorageHost
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8082
              }
              initialDelaySeconds: 20
              periodSeconds: 20
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: environment == 'prod' ? 5 : 2
      }
    }
  }
}

// 7. Container App: Controller (External Ingress for Supabase Edge Worker)
resource controllerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-moderation-controller-${environment}'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acaIdentity.id}': {}
    }
  }
  dependsOn: [
    acrPullRole
  ]
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      registries: [
        {
          server: acr.properties.loginServer
          identity: acaIdentity.id
        }
      ]
      secrets: [
        {
          name: 'openai-key'
          value: openAiApiKey
        }
        {
          name: 'mod-secret'
          value: moderationSecret
        }
      ]
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'moderation-controller'
          image: '${acr.properties.loginServer}/moderation-controller:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'ENVIRONMENT'
              value: environment
            }
            {
              name: 'ALLOWED_STORAGE_HOST'
              value: allowedStorageHost
            }
            {
              name: 'OPENAI_API_KEY'
              secretRef: 'openai-key'
            }
            {
              name: 'MODERATION_SECRET'
              secretRef: 'mod-secret'
            }
            {
              name: 'NODE_VISION_SERVICE_URL'
              value: 'http://${nodeVisionApp.properties.configuration.ingress.fqdn}'
            }
            {
              name: 'PYTHON_OCR_SERVICE_URL'
              value: 'http://${pythonOcrApp.properties.configuration.ingress.fqdn}'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: environment == 'prod' ? 5 : 2
      }
    }
  }
}

output controllerFqdn string = controllerApp.properties.configuration.ingress.fqdn
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
