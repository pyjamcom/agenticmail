param([string]$ServiceProfile = $env:AGENTICMAIL_SERVICE_PROFILE)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "windows-service-common.ps1")
$ServiceProfile = Set-AgenticMailServiceEnvironment $ServiceProfile
$null = Write-AgenticMailServiceIdentity -Role "stalwart" -ServiceProfile $ServiceProfile
$StalwartExe = "C:\codex_tools\stalwart-v0.15.5-windows\stalwart.exe"
$AgenticMailDir = $env:AGENTICMAIL_DATA_DIR
$ConfigPath = Join-Path $AgenticMailDir "stalwart.toml"
$LogDir = Join-Path $AgenticMailDir "logs"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location -LiteralPath $AgenticMailDir
$stdoutLog = Join-Path $LogDir "stalwart.service.stdout.log"
$stderrLog = Join-Path $LogDir "stalwart.service.stderr.log"
$process = Start-Process -FilePath $StalwartExe -ArgumentList @("--config", $ConfigPath) -WorkingDirectory $AgenticMailDir -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
