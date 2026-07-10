param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\exchange-sales.local.json",
  [int]$HealthPort = 3901
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptPath = Join-Path $RepoRoot "exchange-ews-sidecar\exchange-ews-sidecar.py"
$PythonExe = (Get-Command python.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Exchange EWS config not found: $ConfigPath" }
if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "Exchange EWS sidecar not found: $ScriptPath" }

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
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSec 3
    $health | ConvertTo-Json -Depth 5
    exit 0
  } catch {}
} while ([DateTime]::UtcNow -lt $deadline)

throw "Exchange EWS sidecar did not expose health on port $HealthPort"
