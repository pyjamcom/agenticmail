$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = "C:\codex_tools\node-v22.23.1-win-x64\node.exe"
$ConfigPath = Join-Path $env:USERPROFILE ".agenticmail\config.json"
$LogDir = Join-Path $env:USERPROFILE ".agenticmail\logs"

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
