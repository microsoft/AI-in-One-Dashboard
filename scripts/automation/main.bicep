@description('Name prefix for resources')
param namePrefix string = 'allinonedash'

@description('Location for all resources')
param location string = resourceGroup().location

@description('SKU for Storage Account')
param storageSku string = 'Standard_LRS'

@description('Kind for Storage Account')
param storageKind string = 'StorageV2'

@description('Queue name to create')
param queueName string = 'auditsearchidqueue'

@description('Automation account name')
param automationAccountName string = '${namePrefix}-automation'

@description('Automation runtime environment name (PowerShell 7.4)')
param runtimeEnvironmentName string = 'ps74'

@description('List of PowerShell modules to import into Automation Account')
param automationModules array = [
  'Az.Accounts'
  'Az.Storage'
  'Az.Resources'
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

resource stg 'Microsoft.Storage/storageAccounts@2025-06-01' = {
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

resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01' = {
  name: '${stg.name}/default/${queueName}'
  dependsOn: [stg]
}

resource automation 'Microsoft.Automation/automationAccounts@2023-11-01' = {
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

// PowerShell 7.4 Runtime Environment (used by runbooks)
resource runtimeEnv 'Microsoft.Automation/automationAccounts/runtimeEnvironments@2024-10-23' = {
  name: '${automation.name}/${runtimeEnvironmentName}'
  location: location
  properties: {
    runtime: {
      language: 'PowerShell'
      version: '7.4'
    }
  }
  dependsOn: [automation]
}


//
resource runtimePackages 'Microsoft.Automation/automationAccounts/runtimeEnvironments/packages@2024-10-23' = [ for mod in automationModules: {
    name: '${automation.name}/${runtimeEnvironmentName}/${mod}'
    properties: {
      contentLink: {
        uri: 'https://www.powershellgallery.com/api/v2/package/${mod}'
      }
    }
    dependsOn: [
      runtimeEnv
    ]
  }]

// Create runbooks and link them to the PowerShell 7.4 runtime environment.
resource runbookResources 'Microsoft.Automation/automationAccounts/runbooks@2024-10-23' = [for rb in items(runbooks): {
  name: '${automation.name}/${rb.key}'
  location: location
  properties: {
    runbookType: 'PowerShell'
    runtimeEnvironment: runtimeEnvironmentName
    logProgress: true
    logVerbose: true
    draft: {
      inEdit: true
      description: rb.value
    }
  }
  dependsOn: [automation, runtimeEnv]
}]

// Grant the Automation Account's system-assigned managed identity permission to access the storage account's queue
// Role: Storage Queue Data Contributor. If you prefer a different role, replace the roleDefinitionId below.
// Built-in role definition ID for Storage Queue Data Contributor
var storageQueueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'

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
output automationAccountName string = automation.name
output automationIdentityPrincipalId string = automation.identity.principalId
output automationIdentityTenantId string = automation.identity.tenantId
