param([string]$ServiceProfile = $env:AGENTICMAIL_SERVICE_PROFILE)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "windows-service-common.ps1")
$ServiceProfile = Set-AgenticMailServiceEnvironment $ServiceProfile
$null = Write-AgenticMailServiceIdentity -Role "sip" -ServiceProfile $ServiceProfile
$NodeExe = "C:\codex_tools\node-v22.23.1-win-x64\node.exe"
$ScriptPath = Join-Path $RepoRoot "sip-sidecar\sip-sidecar.mjs"
$PbxConfig = Join-Path $env:AGENTICMAIL_DATA_DIR "pbx199.local.json"
$AgenticMailConfig = Join-Path $env:AGENTICMAIL_DATA_DIR "config.json"
$LogDir = Join-Path $env:AGENTICMAIL_DATA_DIR "logs"

$env:SIP_SIDECAR_HTTP_PORT = "3899"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location -LiteralPath $RepoRoot
$stdoutLog = Join-Path $LogDir "sip.service.stdout.log"
$stderrLog = Join-Path $LogDir "sip.service.stderr.log"
$arguments = @($ScriptPath, "--config", $PbxConfig, "--agenticmailConfig", $AgenticMailConfig)
$process = Start-Process -FilePath $NodeExe -ArgumentList $arguments -WorkingDirectory $RepoRoot -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
