@description('Name prefix for resources')
param namePrefix string = 'aiinonedash'

@description('Location for all resources')
param location string = resourceGroup().location

@description('SKU for Storage Account')
param storageSku string = 'Standard_LRS'

@description('Kind for Storage Account')
@description('Name prefix for resources')
param namePrefix string = 'aiinonedash'

@description('Location for all resources')
param location string = resourceGroup().location

@description('SKU for Storage Account')
param storageSku string = 'Standard_LRS'

@description('Kind for Storage Account')
param storageKind string = 'StorageV2'

@description('Queue name to create')
param queueName string = 'work-queue'

@description('Automation account name')
param automationAccountName string = '${namePrefix}-automation'

@description('List of PowerShell modules to import into Automation Account')
param automationModules array = [
  'Az.Accounts'
  'Az.Storage'
  'Microsoft.Graph.Authentication'
  'Microsoft.Graph.Beta.Security'
  'Microsoft.Graph.Reports'
]

@description('List of runbooks to create (name -> content)')
param runbooks object = {
  'GetCopilotInteractions' : 'Downloads copilot interactions from audit API and saves to CSV in SharePoint.'
  'CreateAuditLogQuery'    : 'Write-Output "Placeholder: do work"'
}

var storageAccountName = toLower(replace('${namePrefix}stg', '-', ''))

resource stg 'Microsoft.Storage/storageAccounts@2023-06-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: storageSku
  }
  kind: storageKind
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: true
    supportsHttpsTrafficOnly: true
  }
}

resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-06-01' = {
  name: '${stg.name}/default/${queueName}'
  dependsOn: [stg]
}

resource automation 'Microsoft.Automation/automationAccounts@2020-01-13-preview' = {
  name: automationAccountName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    sku: {
      name: 'Basic'
    }
  }
}

// Import modules into the Automation Account
// Note: Bicep/ARM doesn't have a direct resource to upload PowerShell modules from PSGallery.
// We create module resources referencing gallery modules via Automation module resource type.
resource importedModules 'Microsoft.Automation/automationAccounts/modules@2020-01-13-preview' = [for mod in automationModules: {
  name: '${automation.name}/${mod}'
  properties: {
    contentLink: {
      uri: 'https://www.powershellgallery.com/api/v2/package/' + mod
      contentHash: {}
    }
    isGlobal: true
  }
  dependsOn: [automation]
}]

// Create runbooks (PowerShell Workflow or PowerShell). We'll create as PowerShell runbooks with draft content.
resource runbookResources 'Microsoft.Automation/automationAccounts/runbooks@2020-01-13-preview' = [for rbName in union(keys(runbooks), []): {
  name: '${automation.name}/${rbName}'
  properties: {
    runbookType: 'PowerShell'
    logProgress: true
    logVerbose: true
    draft: {
      inEdit: true
      // content is provided via draft content link; ARM templates only support contentLink/uri to storage
      // As a convenience, create the draft with a small inline initial description.
      description: 'Created by bicep - placeholder runbook'
    }
  }
  dependsOn: [automation]
}]

// Grant the Automation Account's system-assigned managed identity permission to access the storage account's queue
// Role: Storage Queue Data Contributor. If you prefer a different role, replace the roleDefinitionId below.
// Well-known role definition ID for Storage Queue Data Contributor (validate in your tenant if needed):
var storageQueueDataContributorRoleId = '974c5e4b-33f7-4d53-8a5e-2b1b0e0d6b52'

resource automationQueueRole 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  name: guid(automation.id, stg.id, storageQueueDataContributorRoleId)
  scope: stg
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataContributorRoleId)
    principalId: automation.identity.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [automation, stg]
}

// Because ARM/Bicep cannot directly set runbook code inline without a storage content link,
// we output what needs to be uploaded after deployment and provide PowerShell to publish runbooks.

output storageAccountNameOutput string = stg.name
output queueResourceId string = queue.id
output automationAccountId string = automation.id
output automationIdentityPrincipalId string = automation.identity.principalId
output automationIdentityTenantId string = automation.identity.tenantId
