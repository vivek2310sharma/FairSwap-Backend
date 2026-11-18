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

@description('Container image tag to deploy (used as fallback when specific image digest/reference is not provided)')
param imageTag string = 'latest'

@description('GHCR registry server')
param ghcrServer string = 'ghcr.io'

@description('GHCR username / organization with read access to private packages')
param ghcrUsername string = 'vivek2310sharma'

@description('Personal Access Token (classic with read:packages) or read-only credential for GHCR')
@secure()
param ghcrPullToken string

@description('Full image reference or digest for Moderation Controller')
param controllerImage string = 'ghcr.io/vivek2310sharma/fairswap-private-moderation-controller-v2:${imageTag}'

@description('Full image reference or digest for Node Vision')
param nodeVisionImage string = 'ghcr.io/vivek2310sharma/fairswap-private-node-vision-v2:${imageTag}'

@description('Full image reference or digest for Python OCR')
param pythonOcrImage string = 'ghcr.io/vivek2310sharma/fairswap-private-python-ocr-v2:${imageTag}'

var logAnalyticsWorkspaceName = 'law-fairswap-moderation-${environment}-${suffix}'
var containerAppEnvName = 'cae-fairswap-moderation-${environment}-${suffix}'

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

// 2. User Assigned Managed Identity (retained for identity continuity; AcrPull role decoupled)
resource acaIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-fairswap-moderation-${environment}'
  location: location
}

// 3. Container Apps Environment (Consumption Tier)
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

// 4. Container App: Node Vision Worker
resource nodeVisionApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-node-vision-${environment}'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acaIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      registries: [
        {
          server: ghcrServer
          username: ghcrUsername
          passwordSecretRef: 'ghcr-pull-token'
        }
      ]
      secrets: [
        {
          name: 'ghcr-pull-token'
          value: ghcrPullToken
        }
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
          image: nodeVisionImage
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

// 5. Container App: Python OCR Worker
resource pythonOcrApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-python-ocr-${environment}'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acaIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      registries: [
        {
          server: ghcrServer
          username: ghcrUsername
          passwordSecretRef: 'ghcr-pull-token'
        }
      ]
      secrets: [
        {
          name: 'ghcr-pull-token'
          value: ghcrPullToken
        }
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
          image: pythonOcrImage
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

// 6. Container App: Controller (External Ingress for Supabase Edge Worker)
resource controllerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-moderation-controller-${environment}'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acaIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      registries: [
        {
          server: ghcrServer
          username: ghcrUsername
          passwordSecretRef: 'ghcr-pull-token'
        }
      ]
      secrets: [
        {
          name: 'ghcr-pull-token'
          value: ghcrPullToken
        }
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
          image: controllerImage
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
              name: 'TIMEOUT_MS'
              value: '15000'
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
output containerAppEnvName string = containerAppEnv.name
output controllerAppId string = controllerApp.id
output nodeVisionAppId string = nodeVisionApp.id
output pythonOcrAppId string = pythonOcrApp.id
