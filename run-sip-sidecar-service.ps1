$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = "C:\codex_tools\node-v22.23.1-win-x64\node.exe"
$ScriptPath = Join-Path $RepoRoot "sip-sidecar\sip-sidecar.mjs"
$PbxConfig = Join-Path $env:USERPROFILE ".agenticmail\pbx199.local.json"
$AgenticMailConfig = Join-Path $env:USERPROFILE ".agenticmail\config.json"
$LogDir = Join-Path $env:USERPROFILE ".agenticmail\logs"

$env:SIP_SIDECAR_HTTP_PORT = "3899"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location -LiteralPath $RepoRoot
$stdoutLog = Join-Path $LogDir "sip.service.stdout.log"
$stderrLog = Join-Path $LogDir "sip.service.stderr.log"
$arguments = @($ScriptPath, "--config", $PbxConfig, "--agenticmailConfig", $AgenticMailConfig)
$process = Start-Process -FilePath $NodeExe -ArgumentList $arguments -WorkingDirectory $RepoRoot -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
