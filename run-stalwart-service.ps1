$ErrorActionPreference = "Stop"
$StalwartExe = "C:\codex_tools\stalwart-v0.15.5-windows\stalwart.exe"
$AgenticMailDir = Join-Path $env:USERPROFILE ".agenticmail"
$ConfigPath = Join-Path $AgenticMailDir "stalwart.toml"
$LogDir = Join-Path $AgenticMailDir "logs"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location -LiteralPath $AgenticMailDir
$stdoutLog = Join-Path $LogDir "stalwart.service.stdout.log"
$stderrLog = Join-Path $LogDir "stalwart.service.stderr.log"
$process = Start-Process -FilePath $StalwartExe -ArgumentList @("--config", $ConfigPath) -WorkingDirectory $AgenticMailDir -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
