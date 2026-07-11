param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\exchange-sales.local.json",
  [int]$HealthPort = 3901
)

. (Join-Path $PSScriptRoot "local-health.ps1")

$processes = @(Get-CimInstance Win32_Process |
  Where-Object { $_.Name -like 'python*.exe' -and $_.CommandLine -like '*exchange-ews-sidecar.py*' })
$managedTask = Get-ScheduledTask -TaskName "AgenticMail-Exchange-EWS-Service" -ErrorAction SilentlyContinue
$managedTaskRunning = $managedTask -and [string]$managedTask.State -eq "Running"
$health = $null
try { $health = Get-LocalJson -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSeconds 5 } catch {}
$processRunning = $processes.Count -gt 0 -or $managedTaskRunning -or $null -ne $health

[pscustomobject]@{
  ConfigFound = (Test-Path -LiteralPath $ConfigPath)
  ProcessRunning = $processRunning
  HealthReachable = ($null -ne $health)
  Health = $health
  Blocking = @(
    if (-not (Test-Path -LiteralPath $ConfigPath)) { "config_missing" }
    if (-not $processRunning) { "process_not_running" }
    if ($null -eq $health) { "health_unreachable" }
    elseif ($health.status -ne "ok") { "ews_poll_degraded" }
    elseif ($health.callArchive.enabled -eq $true -and $health.callArchive.status -ne "ok") {
      "incoming_call_archive_degraded"
    }
  )
} | ConvertTo-Json -Depth 6
