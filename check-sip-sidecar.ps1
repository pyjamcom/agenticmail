param(
  [int]$HealthPort = 3899,
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\pbx199.local.json"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "local-health.ps1")

$packet = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  scriptFound = Test-Path -LiteralPath "$PSScriptRoot\sip-sidecar\sip-sidecar.mjs"
  configFound = Test-Path -LiteralPath $ConfigPath
  processRunning = $false
  healthReachable = $false
  health = $null
  tnvedHealthReachable = $false
  tnvedHealth = $null
  blocking = @()
}

$proc = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*sip-sidecar.mjs*" })
$managedTask = Get-ScheduledTask -TaskName "AgenticMail-SIP-Sidecar-Service" -ErrorAction SilentlyContinue
$managedTaskRunning = $managedTask -and [string]$managedTask.State -eq "Running"
$signalingPort = 5070
$tnvedApiBase = "http://127.0.0.1:8099"
$tnvedEnabled = $true
if (Test-Path -LiteralPath $ConfigPath) {
  try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $signalingPort = [int]$config.signalingPort
    if ($config.tnvedApiBase) { $tnvedApiBase = ([string]$config.tnvedApiBase).TrimEnd("/") }
    if ($null -ne $config.tnvedConsultationEnabled) {
      $tnvedEnabled = [bool]$config.tnvedConsultationEnabled
    }
  } catch {}
}
$udpListener = Get-NetUDPEndpoint -LocalPort $signalingPort -ErrorAction SilentlyContinue | Select-Object -First 1
$packet.processRunning = $proc.Count -gt 0 -or $managedTaskRunning -or $null -ne $udpListener

if (-not $packet.scriptFound) { $packet.blocking += "sip_sidecar_script_missing" }
if (-not $packet.configFound) { $packet.blocking += "pbx_config_missing" }
if (-not $packet.processRunning) { $packet.blocking += "sip_sidecar_not_running" }

try {
  $health = Get-LocalJson -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSeconds 5
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

if ($tnvedEnabled) {
  try {
    $tnvedHealth = Get-LocalJson -Uri "$tnvedApiBase/tnved/health" -TimeoutSeconds 10
    $packet.tnvedHealthReachable = $true
    $packet.tnvedHealth = $tnvedHealth
    if ($tnvedHealth.status -ne "ok" -or $tnvedHealth.preflight.ok -ne $true) {
      $packet.blocking += "tnved_api_health_blocked"
    }
  } catch {
    $packet.blocking += "tnved_api_health_unreachable"
  }
}

$packet.blocking = @($packet.blocking | Select-Object -Unique)
$packet | ConvertTo-Json -Depth 8
