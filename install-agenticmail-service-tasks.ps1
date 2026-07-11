param([string]$ServiceProfile = $env:USERPROFILE)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "windows-service-common.ps1")
$ServiceProfile = Resolve-AgenticMailServiceProfile $ServiceProfile

$definitions = @(
  @{ Name = "AgenticMail-Stalwart-Service"; Script = Join-Path $RepoRoot "run-stalwart-service.ps1"; Description = "Long-running Stalwart mail service for AgenticMail." }
  @{ Name = "AgenticMail-API-Service"; Script = Join-Path $RepoRoot "run-agenticmail-api-service.ps1"; Description = "Long-running AgenticMail API and persistence service." }
  @{ Name = "AgenticMail-SIP-Sidecar-Service"; Script = Join-Path $RepoRoot "run-sip-sidecar-service.ps1"; Description = "Long-running direct SIP service for PBX extension 199." }
  @{ Name = "AgenticMail-Exchange-EWS-Service"; Script = Join-Path $RepoRoot "run-exchange-ews-service.ps1"; Description = "Long-running Exchange EWS bridge for sales@nbr.ru." }
)

foreach ($definition in $definitions) {
  if (-not (Test-Path -LiteralPath $definition.Script)) { throw "Service runner not found: $($definition.Script)" }
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $definition.Script + '" -ServiceProfile "' + $ServiceProfile + '"'
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settingsArgs = @{
    StartWhenAvailable = $true
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    MultipleInstances = "IgnoreNew"
    RestartCount = 999
    RestartInterval = (New-TimeSpan -Minutes 1)
    ExecutionTimeLimit = (New-TimeSpan -Days 3650)
  }
  $settings = New-ScheduledTaskSettingsSet @settingsArgs
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $taskArgs = @{
    Action = $action
    Trigger = $trigger
    Settings = $settings
    Principal = $principal
    Description = $definition.Description
  }
  $task = New-ScheduledTask @taskArgs
  Register-ScheduledTask -TaskName $definition.Name -InputObject $task -Force | Out-Null
}

$definitions | ForEach-Object {
  Get-ScheduledTask -TaskName $_.Name | Select-Object TaskName, State
}
