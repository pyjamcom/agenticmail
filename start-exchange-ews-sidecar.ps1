param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\exchange-sales.local.json",
  [int]$HealthPort = 3901
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "local-health.ps1")
$ScriptPath = Join-Path $RepoRoot "exchange-ews-sidecar\exchange-ews-sidecar.py"
$PythonExe = (Get-Command python.exe -ErrorAction Stop).Source
$RuntimeLogDir = Join-Path $env:USERPROFILE ".agenticmail\logs"
$StdoutLog = Join-Path $RuntimeLogDir "exchange-ews.stdout.log"
$StderrLog = Join-Path $RuntimeLogDir "exchange-ews.stderr.log"
$env:INCOMING_CALL_MEMPALACE_PATH = "C:\codex_tools\Purchasing department\.runtime\mempalace\purchasing_department"
$env:INCOMING_CALL_MEMPALACE_WING = "purchasing department"
$env:INCOMING_CALL_MEMPALACE_ROOM = "incoming_calls"
$env:INCOMING_CALL_MEMPALACE_POLL_SECONDS = "2"

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Exchange EWS config not found: $ConfigPath" }
if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "Exchange EWS sidecar not found: $ScriptPath" }
New-Item -ItemType Directory -Path $RuntimeLogDir -Force | Out-Null

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -like 'python*.exe' -and $_.CommandLine -like '*exchange-ews-sidecar.py*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }

Start-Process -FilePath $PythonExe `
  -ArgumentList @($ScriptPath, '--config', $ConfigPath) `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  Start-Sleep -Milliseconds 500
  try {
    $health = Get-LocalJson -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSeconds 3
    if ($health.status -eq "ok") {
      $health | ConvertTo-Json -Depth 5
      exit 0
    }
  } catch {}
} while ([DateTime]::UtcNow -lt $deadline)

throw "Exchange EWS sidecar did not expose health on port $HealthPort"
