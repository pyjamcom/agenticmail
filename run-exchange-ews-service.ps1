$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonExe = (Get-Command python.exe -ErrorAction Stop).Source
$ScriptPath = Join-Path $RepoRoot "exchange-ews-sidecar\exchange-ews-sidecar.py"
$ConfigPath = Join-Path $env:USERPROFILE ".agenticmail\exchange-sales.local.json"
$LogDir = Join-Path $env:USERPROFILE ".agenticmail\logs"
$env:INCOMING_CALL_MEMPALACE_PATH = "C:\codex_tools\Purchasing department\.runtime\mempalace\purchasing_department"
$env:INCOMING_CALL_MEMPALACE_WING = "purchasing department"
$env:INCOMING_CALL_MEMPALACE_ROOM = "incoming_calls"
$env:INCOMING_CALL_MEMPALACE_POLL_SECONDS = "2"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location -LiteralPath $RepoRoot
$stdoutLog = Join-Path $LogDir "exchange.service.stdout.log"
$stderrLog = Join-Path $LogDir "exchange.service.stderr.log"
$arguments = @($ScriptPath, "--config", $ConfigPath)
$process = Start-Process -FilePath $PythonExe -ArgumentList $arguments -WorkingDirectory $RepoRoot -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
