param(
  [string]$ServiceProfile = $env:AGENTICMAIL_SERVICE_PROFILE,
  [string]$PythonExe = "C:\Program Files\Python314\python.exe"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "windows-service-common.ps1")
$ServiceProfile = Set-AgenticMailServiceEnvironment $ServiceProfile
$null = Write-AgenticMailServiceIdentity -Role "exchange" -ServiceProfile $ServiceProfile
if (-not (Test-Path -LiteralPath $PythonExe)) { throw "Python executable not found: $PythonExe" }
$null = Add-AgenticMailPythonPath -AdditionalPaths @(
  "C:\codex_tools\Purchasing department\.runtime\mempalace-src"
)
$ScriptPath = Join-Path $RepoRoot "exchange-ews-sidecar\exchange-ews-sidecar.py"
$ConfigPath = Join-Path $env:AGENTICMAIL_DATA_DIR "exchange-sales.local.json"
$LogDir = Join-Path $env:AGENTICMAIL_DATA_DIR "logs"
$env:INCOMING_CALL_MEMPALACE_PATH = "C:\codex_tools\Purchasing department\.runtime\mempalace\purchasing_department"
$env:INCOMING_CALL_MEMPALACE_WING = "purchasing department"
$env:INCOMING_CALL_MEMPALACE_ROOM = "incoming_calls"
$env:INCOMING_CALL_MEMPALACE_POLL_SECONDS = "2"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location -LiteralPath $RepoRoot
$stdoutLog = Join-Path $LogDir "exchange.service.stdout.log"
$stderrLog = Join-Path $LogDir "exchange.service.stderr.log"

$healthPort = 3901
try {
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if ($config.healthPort) { $healthPort = [int]$config.healthPort }
} catch {
  $healthPort = 3901
}
try {
  $listeners = Get-NetTCPConnection -LocalPort $healthPort -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $owner = [int]$listener.OwningProcess
    if ($owner -gt 0 -and $owner -ne $PID) {
      Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    }
  }
} catch {
  # Starting the sidecar will fail clearly if the port is still occupied.
}

$arguments = @($ScriptPath, "--config", $ConfigPath)
$process = Start-Process -FilePath $PythonExe -ArgumentList $arguments -WorkingDirectory $RepoRoot -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
