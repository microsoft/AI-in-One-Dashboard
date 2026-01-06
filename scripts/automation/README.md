Automation deployment helper
===========================

Quick notes:

- Deploy the Bicep template using the included `deploy.ps1` (uses Az PowerShell)

Commands:

```powershell
cd .\scripts\automation
.\deploy.ps1
.\upload-runbooks.ps1 -ResourceGroup '<rg>' -AutomationAccount '<namePrefix>-automation' -RunbooksPath .\runbooks
```


