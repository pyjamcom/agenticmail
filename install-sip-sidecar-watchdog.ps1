param(
  [string]$TaskName = "AgenticMail-SIP-Sidecar-Watchdog"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$WatchdogScript = Join-Path $RepoRoot "ensure-sip-sidecar.ps1"
$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $WatchdogScript)) {
  throw "Watchdog script not found: $WatchdogScript"
}

$arguments = @(
  "-NoProfile"
  "-NonInteractive"
  "-ExecutionPolicy Bypass"
  "-WindowStyle Hidden"
  "-File `"$WatchdogScript`""
) -join " "

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$repeatTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal `
  -UserId $CurrentUser `
  -LogonType Interactive `
  -RunLevel Limited
$task = New-ScheduledTask `
  -Action $action `
  -Trigger @($repeatTrigger, $logonTrigger) `
  -Settings $settings `
  -Principal $principal `
  -Description "Keeps AgenticMail SIP extension 199 registered and restarts the sidecar when health is unavailable."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$registered = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  taskName = $registered.TaskName
  state = [string]$registered.State
  lastRunTime = $info.LastRunTime
  lastTaskResult = $info.LastTaskResult
  nextRunTime = $info.NextRunTime
} | ConvertTo-Json
