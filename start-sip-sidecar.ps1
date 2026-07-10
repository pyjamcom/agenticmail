param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\pbx199.local.json",
  [string]$AgenticMailConfigPath = "$env:USERPROFILE\.agenticmail\config.json",
  [string]$NodeDir = "C:\codex_tools\node-v22.23.1-win-x64",
  [int]$HealthPort = 3899
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = Join-Path $NodeDir "node.exe"
$SidecarScript = Join-Path $RepoRoot "sip-sidecar\sip-sidecar.mjs"

if (-not (Test-Path -LiteralPath $NodeExe)) {
  throw "Portable Node not found: $NodeExe"
}
if (-not (Test-Path -LiteralPath $SidecarScript)) {
  throw "SIP sidecar script not found: $SidecarScript"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "PBX config not found: $ConfigPath"
}

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -like "*sip-sidecar.mjs*" } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force } catch {}
  }

$env:SIP_SIDECAR_HTTP_PORT = [string]$HealthPort

Start-Process -FilePath $NodeExe `
  -ArgumentList @($SidecarScript, "--config", $ConfigPath, "--agenticmailConfig", $AgenticMailConfigPath) `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden | Out-Null

$health = $null
$lastError = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSec 5
    if ($health.registered -and $health.transcriptPersistence.ready -and $health.status -eq "ok") {
      break
    }
    $lastError = $health.lastRegisterError
  } catch {
    $lastError = $_.Exception.Message
  }
}

if (-not $health -or -not $health.registered -or -not $health.transcriptPersistence.ready) {
  throw "SIP sidecar failed readiness on port ${HealthPort}: $lastError"
}

$health | ConvertTo-Json -Depth 6
