$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "local-health.ps1")
$NodeDir = 'C:\codex_tools\node-v22.23.1-win-x64'
$NodeExe = Join-Path $NodeDir 'node.exe'
$StalwartExe = 'C:\codex_tools\stalwart-v0.15.5-windows\stalwart.exe'
$AgenticMailDir = Join-Path $env:USERPROFILE '.agenticmail'
$StalwartConfig = Join-Path $AgenticMailDir 'stalwart.toml'
$AgenticMailConfig = Join-Path $AgenticMailDir 'config.json'
$RuntimeLogDir = Join-Path $AgenticMailDir 'logs'
$ApiStdoutLog = Join-Path $RuntimeLogDir 'api.stdout.log'
$ApiStderrLog = Join-Path $RuntimeLogDir 'api.stderr.log'
$StalwartStdoutLog = Join-Path $RuntimeLogDir 'stalwart.stdout.log'
$StalwartStderrLog = Join-Path $RuntimeLogDir 'stalwart.stderr.log'

if (-not (Test-Path -LiteralPath $NodeExe)) {
  throw "Portable Node not found: $NodeExe"
}
if (-not (Test-Path -LiteralPath $StalwartExe)) {
  throw "Stalwart binary not found: $StalwartExe"
}
if (-not (Test-Path -LiteralPath $StalwartConfig)) {
  throw "AgenticMail config not found: $StalwartConfig"
}
if (-not (Test-Path -LiteralPath $AgenticMailConfig)) {
  throw "AgenticMail config not found: $AgenticMailConfig"
}

New-Item -ItemType Directory -Path $RuntimeLogDir -Force | Out-Null

$runtimeConfig = Get-Content -LiteralPath $AgenticMailConfig -Raw | ConvertFrom-Json
if (-not $runtimeConfig.inboundSecret) {
  throw "AgenticMail inboundSecret is missing in config.json"
}
$env:AGENTICMAIL_INBOUND_SECRET = [string]$runtimeConfig.inboundSecret

$env:Path = "$NodeDir;$env:Path"

function Stop-MatchingProcess {
  param(
    [string] $ProcessName,
    [string] $Pattern
  )
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -ieq $ProcessName `
        -and $_.CommandLine -like $Pattern `
        -and $_.CommandLine -notlike '*Stop-MatchingProcess*'
    } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force } catch {}
    }
}

Stop-MatchingProcess -ProcessName 'node.exe' -Pattern '*packages/api/dist/index.js*'
Stop-MatchingProcess -ProcessName 'stalwart.exe' -Pattern '*stalwart.exe*--config*'

Start-Process -FilePath $StalwartExe `
  -ArgumentList @('--config', $StalwartConfig) `
  -WorkingDirectory $AgenticMailDir `
  -WindowStyle Hidden | Out-Null

Start-Sleep -Seconds 3

Start-Process -FilePath $NodeExe `
  -ArgumentList @('packages/api/dist/index.js') `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden | Out-Null

Start-Sleep -Seconds 4

$health = Get-LocalJson -Uri 'http://127.0.0.1:3829/api/agenticmail/health' -TimeoutSeconds 10
Write-Host "AgenticMail local deployment is running."
Write-Host "Web UI:  http://127.0.0.1:3829/"
Write-Host "Health:  $($health.status)"
Write-Host "API:     $($health.services.api)"
Write-Host "Mail:    $($health.services.stalwart)"
