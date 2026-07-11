param(
  [string]$TaskName = "AgenticMail-SIP-Sidecar-Watchdog",
  [string]$ServiceProfile = $env:USERPROFILE,
  [switch]$DoNotStart
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$WatchdogScript = Join-Path $RepoRoot "ensure-sip-sidecar.ps1"
. (Join-Path $RepoRoot "windows-service-common.ps1")
$ServiceProfile = Resolve-AgenticMailServiceProfile $ServiceProfile

if (-not (Test-Path -LiteralPath $WatchdogScript)) {
  throw "Watchdog script not found: $WatchdogScript"
}

$arguments = @(
  "-NoProfile"
  "-NonInteractive"
  "-ExecutionPolicy Bypass"
  "-WindowStyle Hidden"
  "-File `"$WatchdogScript`""
  "-ServiceProfile `"$ServiceProfile`""
) -join " "

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$repeatTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal `
  -UserId "SYSTEM" `
  -LogonType ServiceAccount `
  -RunLevel Highest
$task = New-ScheduledTask `
  -Action $action `
  -Trigger @($repeatTrigger, $startupTrigger) `
  -Settings $settings `
  -Principal $principal `
  -Description "Keeps AgenticMail SIP extension 199 registered and restarts the sidecar when health is unavailable."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
if (-not $DoNotStart) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
}

$registered = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  taskName = $registered.TaskName
  state = [string]$registered.State
  lastRunTime = $info.LastRunTime
  lastTaskResult = $info.LastTaskResult
  nextRunTime = $info.NextRunTime
} | ConvertTo-Json
