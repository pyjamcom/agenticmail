param(
  [string]$HealthUri = "http://127.0.0.1:3899/health",
  [string]$ApiHealthUri = "http://127.0.0.1:3829/api/agenticmail/health",
  [string]$ExchangeHealthUri = "http://127.0.0.1:3901/health",
  [int]$TimeoutSeconds = 5,
  [string]$ServiceProfile = $env:AGENTICMAIL_SERVICE_PROFILE
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "windows-service-common.ps1")
$ServiceProfile = Set-AgenticMailServiceEnvironment $ServiceProfile
$null = Write-AgenticMailServiceIdentity -Role "watchdog" -ServiceProfile $ServiceProfile
. (Join-Path $RepoRoot "local-health.ps1")
$StartScript = Join-Path $RepoRoot "start-sip-sidecar.ps1"
$StartLocalScript = Join-Path $RepoRoot "start-local.ps1"
$StartExchangeScript = Join-Path $RepoRoot "start-exchange-ews-sidecar.ps1"
$RuntimeDir = Join-Path $env:USERPROFILE ".agenticmail\sip-sidecar"
$WatchdogLog = Join-Path $RuntimeDir "watchdog.jsonl"
$FullRestartRequest = Join-Path $RuntimeDir "full-system-restart.request"
$Mutex = [Threading.Mutex]::new($false, "Local\AgenticMailSipSidecarWatchdog")
$HasMutex = $false

function Write-WatchdogEvent {
  param(
    [string]$Type,
    [hashtable]$Details = @{}
  )
  New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
  $record = [ordered]@{
    at = [DateTime]::UtcNow.ToString("o")
    type = $Type
  }
  foreach ($entry in $Details.GetEnumerator()) {
    $record[$entry.Key] = $entry.Value
  }
  $line = ($record | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine
  [IO.File]::AppendAllText($WatchdogLog, $line, [Text.UTF8Encoding]::new($false))
}

function Restart-ManagedTask {
  param([string]$TaskName)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { return $false }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process | Where-Object {
    ($TaskName -eq "AgenticMail-Stalwart-Service" -and $_.Name -ieq "stalwart.exe") -or
    ($TaskName -eq "AgenticMail-API-Service" -and $_.Name -ieq "node.exe" -and $_.CommandLine -like "*packages/api/dist/index.js*") -or
    ($TaskName -eq "AgenticMail-SIP-Sidecar-Service" -and $_.Name -ieq "node.exe" -and $_.CommandLine -like "*sip-sidecar.mjs*") -or
    ($TaskName -eq "AgenticMail-Exchange-EWS-Service" -and $_.Name -like "python*.exe" -and $_.CommandLine -like "*exchange-ews-sidecar.py*")
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-ScheduledTask -TaskName $TaskName
  return $true
}

function Stop-AgenticMailRuntimeProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -ieq "stalwart.exe") -or
    ($_.Name -ieq "node.exe" -and $_.CommandLine -like "*packages/api/dist/index.js*") -or
    ($_.Name -ieq "node.exe" -and $_.CommandLine -like "*sip-sidecar.mjs*") -or
    ($_.Name -like "python*.exe" -and $_.CommandLine -like "*exchange-ews-sidecar.py*")
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Wait-LocalHealth {
  param(
    [string]$Uri,
    [scriptblock]$Ready,
    [int]$WaitSeconds = 45
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  do {
    try {
      $value = Get-LocalJson -Uri $Uri -TimeoutSeconds $TimeoutSeconds
      if (& $Ready $value) { return $value }
    } catch {}
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for local service health: $Uri"
}

try {
  $HasMutex = $Mutex.WaitOne(0)
  if (-not $HasMutex) {
    [pscustomobject]@{ status = "skipped"; reason = "watchdog_already_running" } | ConvertTo-Json
    exit 0
  }

  if (Test-Path -LiteralPath $FullRestartRequest) {
    $liveSip = $null
    try { $liveSip = Get-LocalJson -Uri $HealthUri -TimeoutSeconds $TimeoutSeconds } catch {}
    if ($liveSip -and [int]$liveSip.activeCalls -gt 0) {
      Write-WatchdogEvent "full_system_restart_deferred" @{ activeCalls = [int]$liveSip.activeCalls }
      [pscustomobject]@{ status = "deferred"; reason = "active_call" } | ConvertTo-Json
      exit 0
    }

    Remove-Item -LiteralPath $FullRestartRequest -Force
    Write-WatchdogEvent "full_system_restart_started" @{}
    foreach ($taskName in @(
      "AgenticMail-SIP-Sidecar-Service",
      "AgenticMail-Exchange-EWS-Service",
      "AgenticMail-API-Service",
      "AgenticMail-Stalwart-Service"
    )) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
    Stop-AgenticMailRuntimeProcesses
    Start-ScheduledTask -TaskName "AgenticMail-Stalwart-Service"
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName "AgenticMail-API-Service"
    $apiHealth = Wait-LocalHealth -Uri $ApiHealthUri -WaitSeconds 60 -Ready {
      param($value)
      $value.status -eq "ok" -and $value.services.api -eq "ok" -and $value.services.stalwart -eq "ok"
    }
    Start-ScheduledTask -TaskName "AgenticMail-Exchange-EWS-Service"
    Start-ScheduledTask -TaskName "AgenticMail-SIP-Sidecar-Service"
    $exchangeHealth = Wait-LocalHealth -Uri $ExchangeHealthUri -WaitSeconds 60 -Ready {
      param($value)
      $value.status -eq "ok" -and ($value.callArchive.enabled -ne $true -or $value.callArchive.status -eq "ok")
    }
    $sipHealth = Wait-LocalHealth -Uri $HealthUri -WaitSeconds 60 -Ready {
      param($value)
      $value.status -eq "ok" -and $value.registered -eq $true -and $value.transcriptPersistence.ready -eq $true
    }
    Write-WatchdogEvent "full_system_restart_succeeded" @{ lastRegister = $sipHealth.lastRegister }
    [pscustomobject]@{
      status = "full_system_restart_succeeded"
      apiReady = $apiHealth.status -eq "ok"
      exchangeReady = $exchangeHealth.status -eq "ok"
      sipRegistered = [bool]$sipHealth.registered
    } | ConvertTo-Json
    exit 0
  }

  $apiRestarted = $false
  $apiHealth = $null
  try {
    $apiHealth = Get-LocalJson -Uri $ApiHealthUri -TimeoutSeconds $TimeoutSeconds
  } catch {
    $apiHealth = $null
  }
  $apiReady = $apiHealth `
    -and $apiHealth.status -eq "ok" `
    -and $apiHealth.services.api -eq "ok" `
    -and $apiHealth.services.stalwart -eq "ok"
  if (-not $apiReady) {
    Write-WatchdogEvent "api_restart_started" @{
      reason = if ($apiHealth) { "api_health_blocked" } else { "api_health_unreachable" }
    }
    $managedApi = Get-ScheduledTask -TaskName "AgenticMail-API-Service" -ErrorAction SilentlyContinue
    $managedStalwart = Get-ScheduledTask -TaskName "AgenticMail-Stalwart-Service" -ErrorAction SilentlyContinue
    if ($managedApi -and $managedStalwart) {
      $null = Restart-ManagedTask "AgenticMail-Stalwart-Service"
      Start-Sleep -Seconds 2
      $null = Restart-ManagedTask "AgenticMail-API-Service"
    } else {
      $null = & $StartLocalScript
    }
    $apiHealth = Wait-LocalHealth -Uri $ApiHealthUri -WaitSeconds 45 -Ready {
      param($value)
      $value.status -eq "ok" -and $value.services.api -eq "ok" -and $value.services.stalwart -eq "ok"
    }
    $apiRestarted = $true
    Write-WatchdogEvent "api_restart_succeeded" @{}
  }

  $exchangeRestarted = $false
  $exchangeHealth = $null
  try {
    $exchangeHealth = Get-LocalJson -Uri $ExchangeHealthUri -TimeoutSeconds $TimeoutSeconds
  } catch {
    $exchangeHealth = $null
  }
  if (-not $exchangeHealth -or $exchangeHealth.status -ne "ok") {
    Write-WatchdogEvent "exchange_restart_started" @{
      reason = if ($exchangeHealth) { "exchange_health_blocked" } else { "exchange_health_unreachable" }
    }
    if (-not (Restart-ManagedTask "AgenticMail-Exchange-EWS-Service")) {
      $null = & $StartExchangeScript
    }
    $exchangeHealth = Wait-LocalHealth -Uri $ExchangeHealthUri -WaitSeconds 45 -Ready {
      param($value)
      $value.status -eq "ok"
    }
    $exchangeRestarted = $true
    Write-WatchdogEvent "exchange_restart_succeeded" @{}
  }

  $health = $null
  try {
    $health = Get-LocalJson -Uri $HealthUri -TimeoutSeconds $TimeoutSeconds
  } catch {
    $health = $null
  }

  if (-not $apiRestarted -and $health -and $health.status -eq "ok" -and $health.registered -eq $true `
      -and $health.transcriptPersistence.ready -eq $true) {
    [pscustomobject]@{
      status = if ($exchangeRestarted) { "exchange_restarted" } else { "ok" }
      registered = $true
      lastRegister = $health.lastRegister
      exchangeReady = $true
    } | ConvertTo-Json
    exit 0
  }

  $reason = if ($apiRestarted) {
    "api_restarted"
  } elseif (-not $health) {
    "health_unreachable"
  } elseif ($health.registered -ne $true) {
    "registration_missing"
  } elseif ($health.transcriptPersistence.ready -ne $true) {
    "persistence_unavailable"
  } else {
    "health_blocked"
  }
  Write-WatchdogEvent "restart_started" @{ reason = $reason }

  if (-not (Restart-ManagedTask "AgenticMail-SIP-Sidecar-Service")) {
    $null = & $StartScript
  }
  $verified = Wait-LocalHealth -Uri $HealthUri -WaitSeconds 60 -Ready {
    param($value)
    $value.status -eq "ok" -and $value.registered -eq $true -and $value.transcriptPersistence.ready -eq $true
  }

  Write-WatchdogEvent "restart_succeeded" @{ reason = $reason; lastRegister = $verified.lastRegister }
  [pscustomobject]@{
    status = "restarted"
    reason = $reason
    registered = $true
    lastRegister = $verified.lastRegister
  } | ConvertTo-Json
} catch {
  Write-WatchdogEvent "restart_failed" @{ errorType = $_.Exception.GetType().Name }
  [pscustomobject]@{
    status = "failed"
    errorType = $_.Exception.GetType().Name
  } | ConvertTo-Json
  exit 1
} finally {
  if ($HasMutex) {
    try { $Mutex.ReleaseMutex() } catch {}
  }
  $Mutex.Dispose()
}
