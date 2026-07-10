param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\exchange-sales.local.json",
  [int]$HealthPort = 3901
)

$processes = @(Get-CimInstance Win32_Process |
  Where-Object { $_.Name -like 'python*.exe' -and $_.CommandLine -like '*exchange-ews-sidecar.py*' })
$health = $null
try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSec 5 } catch {}

[pscustomobject]@{
  ConfigFound = (Test-Path -LiteralPath $ConfigPath)
  ProcessRunning = ($processes.Count -gt 0)
  HealthReachable = ($null -ne $health)
  Health = $health
  Blocking = @(
    if (-not (Test-Path -LiteralPath $ConfigPath)) { "config_missing" }
    if ($processes.Count -eq 0) { "process_not_running" }
    if ($null -eq $health) { "health_unreachable" }
    elseif ($health.status -ne "ok") { "ews_poll_degraded" }
  )
} | ConvertTo-Json -Depth 6
