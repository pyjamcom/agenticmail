param(
  [string]$ServiceProfile = $env:USERPROFILE,
  [string]$PurchasingRepository = "C:\codex_tools\Purchasing department"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "windows-service-common.ps1")
. (Join-Path $RepoRoot "local-health.ps1")
$ServiceProfile = Resolve-AgenticMailServiceProfile $ServiceProfile
$AgenticMailDir = Join-Path $ServiceProfile ".agenticmail"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Administrator elevation is required to install SYSTEM scheduled tasks."
}

$taskNames = @(
  "AgenticMail-SIP-Sidecar-Watchdog",
  "AgenticMail-SIP-Sidecar-Service",
  "AgenticMail-Exchange-EWS-Service",
  "AgenticMail-API-Service",
  "AgenticMail-Stalwart-Service"
)

$sipHealth = $null
try { $sipHealth = Get-LocalJson -Uri "http://127.0.0.1:3899/health" -TimeoutSeconds 5 } catch {}
if ($sipHealth -and [int]$sipHealth.activeCalls -gt 0) {
  throw "Refusing SYSTEM migration while a SIP call is active."
}

$stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$backupDir = Join-Path $AgenticMailDir "secret-backups\system-migration-$stamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

$secretDefinitions = @(
  @{
    Config = Join-Path $AgenticMailDir "pbx199.local.json"
    Secret = Join-Path $AgenticMailDir "pbx199.secret.dpapi"
  },
  @{
    Config = Join-Path $AgenticMailDir "exchange-sales.local.json"
    Secret = Join-Path $AgenticMailDir "exchange-sales.secret.dpapi"
  }
)

foreach ($definition in $secretDefinitions) {
  if (-not (Test-Path -LiteralPath $definition.Config)) { throw "Config missing: $($definition.Config)" }
  if (-not (Test-Path -LiteralPath $definition.Secret)) { throw "Secret missing: $($definition.Secret)" }
  Copy-Item -LiteralPath $definition.Config -Destination $backupDir -Force
  Copy-Item -LiteralPath $definition.Secret -Destination $backupDir -Force

  $clearSecret = ConvertFrom-AgenticMailSecretFile -Path $definition.Secret
  try {
    Write-AgenticMailMachineSecretFile -Path $definition.Secret -Secret $clearSecret -OperatorSid $identity.User.Value
  } finally {
    $clearSecret = $null
  }

  $config = Get-Content -LiteralPath $definition.Config -Raw | ConvertFrom-Json
  $config.secretFormat = "windows_dpapi_local_machine_v1"
  [IO.File]::WriteAllText(
    $definition.Config,
    ($config | ConvertTo-Json -Depth 12),
    [Text.UTF8Encoding]::new($false)
  )
}

& icacls.exe $backupDir /inheritance:r /grant:r `
  "*$($identity.User.Value):(OI)(CI)F" `
  '*S-1-5-18:(OI)(CI)F' `
  '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to protect migration backup directory ACL." }

foreach ($taskName in $taskNames) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -ieq "stalwart.exe") -or
  ($_.Name -ieq "node.exe" -and $_.CommandLine -like "*packages/api/dist/index.js*") -or
  ($_.Name -ieq "node.exe" -and $_.CommandLine -like "*sip-sidecar.mjs*") -or
  ($_.Name -like "python*.exe" -and $_.CommandLine -like "*exchange-ews-sidecar.py*")
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

& (Join-Path $RepoRoot "install-agenticmail-service-tasks.ps1") -ServiceProfile $ServiceProfile | Out-Null
& (Join-Path $RepoRoot "install-sip-sidecar-watchdog.ps1") -ServiceProfile $ServiceProfile -DoNotStart | Out-Null

$auditInstaller = Join-Path $PurchasingRepository "scripts\install_nevsky_broker_voice_readonly_audit_task.ps1"
if (-not (Test-Path -LiteralPath $auditInstaller)) { throw "Voice audit task installer missing: $auditInstaller" }
& $auditInstaller -ServiceProfile $ServiceProfile | Out-Null

Start-ScheduledTask -TaskName "AgenticMail-Stalwart-Service"
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "AgenticMail-API-Service"

$apiHealth = $null
for ($attempt = 1; $attempt -le 45; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    $apiHealth = Get-LocalJson -Uri "http://127.0.0.1:3829/api/agenticmail/health" -TimeoutSeconds 5
    if ($apiHealth.status -eq "ok" -and $apiHealth.services.stalwart -eq "ok") { break }
  } catch {}
}
if (-not $apiHealth -or $apiHealth.status -ne "ok" -or $apiHealth.services.stalwart -ne "ok") {
  throw "SYSTEM AgenticMail API/Stalwart failed readiness."
}

Start-ScheduledTask -TaskName "AgenticMail-Exchange-EWS-Service"
Start-ScheduledTask -TaskName "AgenticMail-SIP-Sidecar-Service"

$exchangeHealth = $null
$sipHealth = $null
for ($attempt = 1; $attempt -le 60; $attempt++) {
  Start-Sleep -Seconds 1
  try { $exchangeHealth = Get-LocalJson -Uri "http://127.0.0.1:3901/health" -TimeoutSeconds 5 } catch {}
  try { $sipHealth = Get-LocalJson -Uri "http://127.0.0.1:3899/health" -TimeoutSeconds 5 } catch {}
  if ($exchangeHealth.status -eq "ok" -and $sipHealth.status -eq "ok" -and $sipHealth.registered -eq $true) { break }
}
if (-not $exchangeHealth -or $exchangeHealth.status -ne "ok") { throw "SYSTEM Exchange service failed readiness." }
if (-not $sipHealth -or $sipHealth.status -ne "ok" -or $sipHealth.registered -ne $true) {
  throw "SYSTEM SIP service failed readiness."
}

Start-ScheduledTask -TaskName "AgenticMail-SIP-Sidecar-Watchdog"
Start-Sleep -Seconds 2

$allTasks = @($taskNames + "AgenticMail-NevskyBroker-Voice-ReadOnly-Audit")
$snapshots = foreach ($taskName in $allTasks) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  [pscustomobject]@{
    taskName = $task.TaskName
    state = [string]$task.State
    userId = $task.Principal.UserId
    logonType = [string]$task.Principal.LogonType
    runLevel = [string]$task.Principal.RunLevel
  }
}

[pscustomobject]@{
  status = "ok"
  serviceProfile = $ServiceProfile
  secretBackupDirectory = $backupDir
  secretFormat = "windows_dpapi_local_machine_v1"
  api = $apiHealth.status
  stalwart = $apiHealth.services.stalwart
  exchange = $exchangeHealth.status
  sip = $sipHealth.status
  sipRegistered = [bool]$sipHealth.registered
  tasks = $snapshots
} | ConvertTo-Json -Depth 6
