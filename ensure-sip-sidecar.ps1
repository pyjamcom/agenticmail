param(
  [string]$HealthUri = "http://127.0.0.1:3899/health",
  [string]$ApiHealthUri = "http://127.0.0.1:3829/api/agenticmail/health",
  [string]$ApiLiveUri = "http://127.0.0.1:3829/api/agenticmail/health/live",
  [string]$ExchangeHealthUri = "http://127.0.0.1:3901/health",
  [string]$TnvedHealthUri = "http://127.0.0.1:8111/tnved/health",
  [int]$TimeoutSeconds = 10,
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
$PbxConfigPath = Join-Path $env:AGENTICMAIL_DATA_DIR "pbx199.local.json"
$WatchdogLog = Join-Path $RuntimeDir "watchdog.jsonl"
$AlertSpoolPath = Join-Path $RuntimeDir "service-alerts.pending.jsonl"
$AlertStatePath = Join-Path $RuntimeDir "service-alerts.state.json"
$ServiceAlertUri = $ExchangeHealthUri -replace "/health$", "/alerts/service-failure"
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

function Read-ServiceAlertState {
  if (-not (Test-Path -LiteralPath $AlertStatePath)) { return @{} }
  try {
    $raw = Get-Content -LiteralPath $AlertStatePath -Raw | ConvertFrom-Json
    $state = @{}
    foreach ($property in $raw.PSObject.Properties) {
      $state[$property.Name] = [string]$property.Value
    }
    return $state
  } catch {
    return @{}
  }
}

function Write-ServiceAlertState {
  param([hashtable]$State)
  New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
  $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $AlertStatePath -Encoding UTF8
}

function Test-ServiceAlertCooldown {
  param(
    [string]$DedupeKey,
    [int]$MinRepeatSeconds = 1800
  )
  if ([string]::IsNullOrWhiteSpace($DedupeKey)) { return $false }
  $state = Read-ServiceAlertState
  $lastText = ""
  if ($state.ContainsKey($DedupeKey)) {
    $lastText = [string]$state[$DedupeKey]
  }
  if ([string]::IsNullOrWhiteSpace($lastText)) { return $false }
  try {
    $last = [DateTime]::Parse($lastText).ToUniversalTime()
    return ([DateTime]::UtcNow - $last).TotalSeconds -lt $MinRepeatSeconds
  } catch {
    return $false
  }
}

function Set-ServiceAlertCooldown {
  param([string]$DedupeKey)
  if ([string]::IsNullOrWhiteSpace($DedupeKey)) { return }
  $state = Read-ServiceAlertState
  $state[$DedupeKey] = [DateTime]::UtcNow.ToString("o")
  Write-ServiceAlertState $state
}

function Flush-ServiceFailureAlerts {
  if (-not (Test-Path -LiteralPath $AlertSpoolPath)) { return }
  $lines = @(Get-Content -LiteralPath $AlertSpoolPath -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
  if ($lines.Count -eq 0) { return }
  $remaining = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    try {
      $payload = $line | ConvertFrom-Json
      $body = $payload | ConvertTo-Json -Depth 10 -Compress
      $result = Invoke-RestMethod -Uri $ServiceAlertUri -Method Post -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 8
      if ($result.ok -ne $true) {
        $remaining.Add($line)
      }
    } catch {
      $remaining.Add($line)
    }
  }
  $tempPath = "$AlertSpoolPath.tmp"
  if ($remaining.Count -gt 0) {
    Set-Content -LiteralPath $tempPath -Value $remaining -Encoding UTF8
  } else {
    Set-Content -LiteralPath $tempPath -Value "" -Encoding UTF8
  }
  Move-Item -LiteralPath $tempPath -Destination $AlertSpoolPath -Force
}

function Write-ServiceFailureAlert {
  param(
    [string]$Component,
    [string]$EventType,
    [string]$Severity = "critical",
    [string]$Reason = "unknown",
    [string]$Action = "",
    [hashtable]$Details = @{}
  )
  $dedupeKey = "$Component`:$EventType`:$Reason"
  if (Test-ServiceAlertCooldown -DedupeKey $dedupeKey) {
    Flush-ServiceFailureAlerts
    return
  }
  New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
  $payload = [ordered]@{
    id = [guid]::NewGuid().ToString("N")
    at = [DateTime]::UtcNow.ToString("o")
    host = $env:COMPUTERNAME
    component = $Component
    eventType = $EventType
    severity = $Severity
    reason = $Reason
    action = $Action
    details = $Details
    dedupeKey = $dedupeKey
  }
  $line = ($payload | ConvertTo-Json -Compress -Depth 10) + [Environment]::NewLine
  [IO.File]::AppendAllText($AlertSpoolPath, $line, [Text.UTF8Encoding]::new($false))
  Set-ServiceAlertCooldown -DedupeKey $dedupeKey
  Flush-ServiceFailureAlerts
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
    ($TaskName -eq "AgenticMail-SIP-Sidecar-Service" -and $_.Name -like "python*.exe" -and $_.CommandLine -like "*tnved_api_server.py*" -and $_.CommandLine -like "*--port 8111*") -or
    ($TaskName -eq "AgenticMail-Exchange-EWS-Service" -and $_.Name -like "python*.exe" -and $_.CommandLine -like "*exchange-ews-sidecar.py*")
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($TaskName -eq "AgenticMail-SIP-Sidecar-Service") {
    Get-NetUDPEndpoint -LocalPort 5060 -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { $_ -and $_ -ne $PID } |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Get-NetTCPConnection -LocalPort 3899,8111 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { $_ -and $_ -ne $PID } |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  }
  Start-ScheduledTask -TaskName $TaskName
  return $true
}

function Stop-AgenticMailRuntimeProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -ieq "stalwart.exe") -or
    ($_.Name -ieq "node.exe" -and $_.CommandLine -like "*packages/api/dist/index.js*") -or
    ($_.Name -ieq "node.exe" -and $_.CommandLine -like "*sip-sidecar.mjs*") -or
    ($_.Name -like "python*.exe" -and $_.CommandLine -like "*exchange-ews-sidecar.py*") -or
    ($_.Name -like "python*.exe" -and $_.CommandLine -like "*tnved_api_server.py*" -and $_.CommandLine -like "*--port 8111*")
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-TnvedRuntimeProcess {
  return Get-CimInstance Win32_Process | Where-Object {
    $_.Name -like "python*.exe" -and
    $_.CommandLine -like "*tnved_api_server.py*" -and
    $_.CommandLine -like "*--port 8111*"
  } | Select-Object -First 1
}

function Test-SystemProcess {
  param($Process)
  if (-not $Process) { return $false }
  try {
    $owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid
    return $owner.Sid -eq "S-1-5-18"
  } catch {
    return $false
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

function Get-ActiveSipCallCount {
  try {
    $value = Get-LocalJson -Uri $HealthUri -TimeoutSeconds $TimeoutSeconds
    return [int]$value.activeCalls
  } catch {
    return 0
  }
}

function Test-RecoveryAllowed {
  param([string]$Reason)
  $activeCalls = Get-ActiveSipCallCount
  if ($activeCalls -le 0) { return $true }
  Write-WatchdogEvent "recovery_deferred" @{
    reason = $Reason
    activeCalls = $activeCalls
  }
  Write-ServiceFailureAlert -Component "watchdog" -EventType "recovery_deferred_active_call" -Severity "warning" -Reason $Reason -Action "defer_recovery_until_call_finishes" -Details @{ activeCalls = $activeCalls }
  return $false
}

function Ensure-SipFirewallRules {
  if (-not (Test-Path -LiteralPath $PbxConfigPath)) { return }
  $config = Get-Content -LiteralPath $PbxConfigPath -Raw | ConvertFrom-Json
  $server = [string]$config.server
  $signalingPort = [int]$config.signalingPort
  $rtpPortMin = [int]$config.rtpPortMin
  $rtpPortMax = [int]$config.rtpPortMax
  if ([string]::IsNullOrWhiteSpace($server) -or $signalingPort -le 0) { return }

  $signalRule = "AgenticMail SIP signaling (inbound)"
  $rtpRule = "AgenticMail SIP RTP media (inbound)"
  $rtpRange = if ($rtpPortMin -gt 0 -and $rtpPortMax -ge $rtpPortMin) {
    "$rtpPortMin-$rtpPortMax"
  } else {
    $null
  }

  & netsh advfirewall firewall set rule name="$signalRule" new dir=in action=allow protocol=UDP localport="$signalingPort" remoteip="$server" profile=domain enable=yes | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & netsh advfirewall firewall add rule name="$signalRule" dir=in action=allow protocol=UDP localport="$signalingPort" remoteip="$server" profile=domain enable=yes | Out-Null
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to reconcile SIP signaling firewall rule"
  }

  if ($rtpRange) {
    & netsh advfirewall firewall set rule name="$rtpRule" new dir=in action=allow protocol=UDP localport="$rtpRange" remoteip="$server" profile=domain enable=yes | Out-Null
    if ($LASTEXITCODE -ne 0) {
      & netsh advfirewall firewall add rule name="$rtpRule" dir=in action=allow protocol=UDP localport="$rtpRange" remoteip="$server" profile=domain enable=yes | Out-Null
    }
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to reconcile SIP RTP firewall rule"
    }
  }

  Write-WatchdogEvent "firewall_reconciled" @{
    signalingPort = $signalingPort
    rtpPortRange = if ($rtpRange) { $rtpRange } else { "" }
    remoteIp = $server
  }
}

try {
  $HasMutex = $Mutex.WaitOne(0)
  if (-not $HasMutex) {
    [pscustomobject]@{ status = "skipped"; reason = "watchdog_already_running" } | ConvertTo-Json
    exit 0
  }

  try {
    Ensure-SipFirewallRules
    Flush-ServiceFailureAlerts
  } catch {
    Write-WatchdogEvent "firewall_reconcile_failed" @{ errorType = $_.Exception.GetType().Name }
    Write-ServiceFailureAlert -Component "windows-firewall" -EventType "firewall_reconcile_failed" -Reason $_.Exception.GetType().Name -Action "watchdog_will_continue_other_checks"
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
    Write-ServiceFailureAlert -Component "agenticmail-stack" -EventType "full_system_restart_requested" -Severity "warning" -Reason "full_system_restart_request_marker" -Action "restart_all_agenticmail_services"
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
    $tnvedHealth = Wait-LocalHealth -Uri $TnvedHealthUri -WaitSeconds 60 -Ready {
      param($value)
      $value.status -eq "ok" -and $value.preflight.ok -eq $true
    }
    Write-WatchdogEvent "full_system_restart_succeeded" @{ lastRegister = $sipHealth.lastRegister }
    [pscustomobject]@{
      status = "full_system_restart_succeeded"
      apiReady = $apiHealth.status -eq "ok"
      exchangeReady = $exchangeHealth.status -eq "ok"
      sipRegistered = [bool]$sipHealth.registered
      tnvedReady = $tnvedHealth.status -eq "ok"
    } | ConvertTo-Json
    exit 0
  }

  if (-not (Test-RecoveryAllowed -Reason "active_call_in_progress")) {
    [pscustomobject]@{ status = "deferred"; reason = "active_call" } | ConvertTo-Json
    exit 0
  }

  $tnvedHealth = $null
  $tnvedProcess = Get-TnvedRuntimeProcess
  try {
    $tnvedHealth = Get-LocalJson -Uri $TnvedHealthUri -TimeoutSeconds $TimeoutSeconds
  } catch {
    $tnvedHealth = $null
  }
  $tnvedReady = $tnvedHealth -and
    $tnvedHealth.status -eq "ok" -and
    $tnvedHealth.preflight.ok -eq $true -and
    (Test-SystemProcess $tnvedProcess)
  if (-not $tnvedReady) {
    Write-WatchdogEvent "tnved_transient_wait_started" @{
      reason = if ($tnvedHealth) { "wrong_identity_or_blocked" } else { "health_unreachable" }
    }
    try {
      $tnvedHealth = Wait-LocalHealth -Uri $TnvedHealthUri -WaitSeconds 30 -Ready {
        param($value)
        $value.status -eq "ok" -and $value.preflight.ok -eq $true
      }
      $tnvedProcess = Get-TnvedRuntimeProcess
      $tnvedReady = $tnvedHealth -and
        $tnvedHealth.status -eq "ok" -and
        $tnvedHealth.preflight.ok -eq $true -and
        (Test-SystemProcess $tnvedProcess)
      if ($tnvedReady) {
        Write-WatchdogEvent "tnved_transient_wait_succeeded" @{
          kbVersion = [string]$tnvedHealth.preflight.kb_version
        }
      }
    } catch {
      $tnvedReady = $false
    }
  }
  if (-not $tnvedReady) {
    $liveSip = $null
    try { $liveSip = Get-LocalJson -Uri $HealthUri -TimeoutSeconds $TimeoutSeconds } catch {}
    if ($liveSip -and [int]$liveSip.activeCalls -gt 0) {
      Write-WatchdogEvent "tnved_restart_deferred" @{ activeCalls = [int]$liveSip.activeCalls }
    } else {
      Write-WatchdogEvent "tnved_restart_started" @{
        reason = if ($tnvedHealth) { "wrong_identity_or_blocked" } else { "health_unreachable" }
      }
      Write-ServiceFailureAlert -Component "tnved-api" -EventType "tnved_not_ready" -Reason $(if ($tnvedHealth) { "wrong_identity_or_blocked" } else { "health_unreachable" }) -Action "restart_sip_sidecar_and_tnved"
      $null = Restart-ManagedTask "AgenticMail-SIP-Sidecar-Service"
      $tnvedHealth = Wait-LocalHealth -Uri $TnvedHealthUri -WaitSeconds 60 -Ready {
        param($value)
        $value.status -eq "ok" -and $value.preflight.ok -eq $true
      }
      $null = Wait-LocalHealth -Uri $HealthUri -WaitSeconds 60 -Ready {
        param($value)
        $value.status -eq "ok" -and $value.registered -eq $true -and $value.transcriptPersistence.ready -eq $true
      }
      $tnvedProcess = Get-TnvedRuntimeProcess
      if (-not (Test-SystemProcess $tnvedProcess)) {
        throw "TNVED API is healthy but is not running as NT AUTHORITY\SYSTEM"
      }
      Write-WatchdogEvent "tnved_restart_succeeded" @{
        kbVersion = [string]$tnvedHealth.preflight.kb_version
      }
    }
  }

  $apiRestarted = $false
  $apiLive = $null
  try {
    $apiLive = Get-LocalJson -Uri $ApiLiveUri -TimeoutSeconds $TimeoutSeconds
  } catch {
    $apiLive = $null
  }
  $apiProcessReady = $apiLive `
    -and $apiLive.status -eq "ok" `
    -and $apiLive.services.api -eq "ok"
  if (-not $apiProcessReady) {
    if (-not (Test-RecoveryAllowed -Reason "api_liveness_unreachable")) {
      [pscustomobject]@{ status = "deferred"; reason = "active_call" } | ConvertTo-Json
      exit 0
    }
    Write-WatchdogEvent "api_restart_started" @{ reason = "api_liveness_unreachable" }
    Write-ServiceFailureAlert -Component "agenticmail-api" -EventType "api_liveness_unreachable" -Reason "health_live_check_failed" -Action "restart_agenticmail_api"
    if (-not (Restart-ManagedTask "AgenticMail-API-Service")) {
      $null = & $StartLocalScript
    }
    $apiLive = Wait-LocalHealth -Uri $ApiLiveUri -WaitSeconds 45 -Ready {
      param($value)
      $value.status -eq "ok" -and $value.services.api -eq "ok"
    }
    $apiRestarted = $true
    Write-WatchdogEvent "api_restart_succeeded" @{ reason = "api_liveness_unreachable" }
  }

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
    if (-not (Test-RecoveryAllowed -Reason "stalwart_health_unavailable")) {
      [pscustomobject]@{ status = "deferred"; reason = "active_call" } | ConvertTo-Json
      exit 0
    }
    Write-WatchdogEvent "stalwart_restart_started" @{
      reason = if ($apiHealth) { "stalwart_health_degraded" } else { "api_dependency_health_timeout" }
    }
    Write-ServiceFailureAlert -Component "stalwart-mail" -EventType "stalwart_health_unavailable" -Reason $(if ($apiHealth) { "stalwart_health_degraded" } else { "api_dependency_health_timeout" }) -Action "restart_stalwart"
    if (-not (Restart-ManagedTask "AgenticMail-Stalwart-Service")) {
      $null = & $StartLocalScript
    }
    $apiHealth = Wait-LocalHealth -Uri $ApiHealthUri -WaitSeconds 45 -Ready {
      param($value)
      $value.status -eq "ok" -and $value.services.api -eq "ok" -and $value.services.stalwart -eq "ok"
    }
    Write-WatchdogEvent "stalwart_restart_succeeded" @{}
  }

  $exchangeRestarted = $false
  $exchangeHealth = $null
  try {
    $exchangeHealth = Get-LocalJson -Uri $ExchangeHealthUri -TimeoutSeconds $TimeoutSeconds
  } catch {
    $exchangeHealth = $null
  }
  if (-not $exchangeHealth -or $exchangeHealth.status -ne "ok") {
    if (-not (Test-RecoveryAllowed -Reason "exchange_health_unavailable")) {
      [pscustomobject]@{ status = "deferred"; reason = "active_call" } | ConvertTo-Json
      exit 0
    }
    Write-WatchdogEvent "exchange_restart_started" @{
      reason = if ($exchangeHealth) { "exchange_health_blocked" } else { "exchange_health_unreachable" }
    }
    Write-ServiceFailureAlert -Component "exchange-ews-sidecar" -EventType "exchange_health_unavailable" -Reason $(if ($exchangeHealth) { "exchange_health_blocked" } else { "exchange_health_unreachable" }) -Action "restart_exchange_ews_sidecar"
    if (-not (Restart-ManagedTask "AgenticMail-Exchange-EWS-Service")) {
      $null = & $StartExchangeScript
    }
    $exchangeHealth = Wait-LocalHealth -Uri $ExchangeHealthUri -WaitSeconds 45 -Ready {
      param($value)
      $value.status -eq "ok"
    }
    $exchangeRestarted = $true
    Write-WatchdogEvent "exchange_restart_succeeded" @{}
    Flush-ServiceFailureAlerts
  }

  $health = $null
  try {
    $health = Get-LocalJson -Uri $HealthUri -TimeoutSeconds $TimeoutSeconds
  } catch {
    $health = $null
  }

  if ($apiRestarted -and (-not $health -or $health.transcriptPersistence.ready -ne $true)) {
    try {
      $health = Wait-LocalHealth -Uri $HealthUri -WaitSeconds 35 -Ready {
        param($value)
        $value.status -eq "ok" -and $value.registered -eq $true -and $value.transcriptPersistence.ready -eq $true
      }
    } catch {
      $health = $null
    }
  }

  if ($health -and $health.status -eq "ok" -and $health.registered -eq $true `
      -and $health.transcriptPersistence.ready -eq $true) {
    [pscustomobject]@{
      status = if ($exchangeRestarted) { "exchange_restarted" } else { "ok" }
      registered = $true
      lastRegister = $health.lastRegister
      exchangeReady = $true
    } | ConvertTo-Json
    exit 0
  }

  $reason = if (-not $health) {
    "health_unreachable"
  } elseif ($health.registered -ne $true) {
    "registration_missing"
  } elseif ($health.transcriptPersistence.ready -ne $true) {
    "persistence_unavailable"
  } else {
    "health_blocked"
  }
  if (-not (Test-RecoveryAllowed -Reason "sip_$reason")) {
    [pscustomobject]@{ status = "deferred"; reason = "active_call" } | ConvertTo-Json
    exit 0
  }
  Write-WatchdogEvent "restart_started" @{ reason = $reason }
  Write-ServiceFailureAlert -Component "sip-sidecar-199" -EventType "sip_health_unavailable" -Reason $reason -Action "restart_sip_sidecar"

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
  Write-ServiceFailureAlert -Component "watchdog" -EventType "recovery_failed" -Reason $_.Exception.GetType().Name -Action "manual_attention_required"
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
