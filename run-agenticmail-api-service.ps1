param([string]$ServiceProfile = $env:AGENTICMAIL_SERVICE_PROFILE)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "windows-service-common.ps1")
$ServiceProfile = Set-AgenticMailServiceEnvironment $ServiceProfile
$null = Write-AgenticMailServiceIdentity -Role "api" -ServiceProfile $ServiceProfile
$NodeExe = "C:\codex_tools\node-v22.23.1-win-x64\node.exe"
$ConfigPath = Join-Path $env:AGENTICMAIL_DATA_DIR "config.json"
$LogDir = Join-Path $env:AGENTICMAIL_DATA_DIR "logs"

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not $config.inboundSecret) { throw "AgenticMail inboundSecret is missing." }
$env:AGENTICMAIL_INBOUND_SECRET = [string]$config.inboundSecret
$env:Path = "$(Split-Path -Parent $NodeExe);$env:Path"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location -LiteralPath $RepoRoot
$stdoutLog = Join-Path $LogDir "api.service.stdout.log"
$stderrLog = Join-Path $LogDir "api.service.stderr.log"
$process = Start-Process -FilePath $NodeExe -ArgumentList @("packages/api/dist/index.js") -WorkingDirectory $RepoRoot -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
