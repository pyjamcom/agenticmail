param(
  [int]$HealthPort = 3899,
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\pbx199.local.json"
)

$ErrorActionPreference = "Stop"

$packet = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  scriptFound = Test-Path -LiteralPath "$PSScriptRoot\sip-sidecar\sip-sidecar.mjs"
  configFound = Test-Path -LiteralPath $ConfigPath
  processRunning = $false
  healthReachable = $false
  health = $null
  blocking = @()
}

$proc = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*sip-sidecar.mjs*" })
$packet.processRunning = $proc.Count -gt 0

if (-not $packet.scriptFound) { $packet.blocking += "sip_sidecar_script_missing" }
if (-not $packet.configFound) { $packet.blocking += "pbx_config_missing" }
if (-not $packet.processRunning) { $packet.blocking += "sip_sidecar_not_running" }

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSec 5
  $packet.healthReachable = $true
  $packet.health = $health
  if ($health.status -ne "ok") {
    $packet.blocking += "sip_sidecar_health_blocked"
    foreach ($item in @($health.missing)) {
      if ($item) { $packet.blocking += $item }
    }
  }
} catch {
  $packet.blocking += "sip_sidecar_health_unreachable"
}

$packet.blocking = @($packet.blocking | Select-Object -Unique)
$packet | ConvertTo-Json -Depth 8
