param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\pbx199.local.json",
  [string]$AgenticMailConfigPath = "$env:USERPROFILE\.agenticmail\config.json",
  [string]$NodeDir = "C:\codex_tools\node-v22.23.1-win-x64",
  [int]$HealthPort = 3899
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "local-health.ps1")
$NodeExe = Join-Path $NodeDir "node.exe"
$SidecarScript = Join-Path $RepoRoot "sip-sidecar\sip-sidecar.mjs"
$RuntimeDir = Join-Path $env:USERPROFILE ".agenticmail\sip-sidecar"
$StdoutLog = Join-Path $RuntimeDir "sidecar.stdout.log"
$StderrLog = Join-Path $RuntimeDir "sidecar.stderr.log"

if (-not (Test-Path -LiteralPath $NodeExe)) {
  throw "Portable Node not found: $NodeExe"
}
if (-not (Test-Path -LiteralPath $SidecarScript)) {
  throw "SIP sidecar script not found: $SidecarScript"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "PBX config not found: $ConfigPath"
}

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

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
    $health = Get-LocalJson -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSeconds 5
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
