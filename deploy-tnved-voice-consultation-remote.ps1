[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StagePath,
    [Parameter(Mandatory = $true)][string]$Stamp,
    [Parameter(Mandatory = $true)][string]$ExpectedSidecarHash,
    [Parameter(Mandatory = $true)][string]$ExpectedScenarioHash,
    [Parameter(Mandatory = $true)][string]$ExpectedReadmeHash,
    [string]$TnvedApiBase = "http://10.0.200.101:8100",
    [string]$TaskName = "AgenticMail-SIP-Sidecar-Service",
    [string]$WatchdogTaskName = "AgenticMail-SIP-Sidecar-Watchdog",
    [string]$TargetRoot = "C:\codex_tools\agenticmail\sip-sidecar",
    [string]$ConfigPath = "C:\Users\pavel\.agenticmail\pbx199.local.json"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$expected = @{
    "sip-sidecar.mjs" = $ExpectedSidecarHash
    "sales-call-scenario.json" = $ExpectedScenarioHash
    "README.md" = $ExpectedReadmeHash
}
$apiBase = $TnvedApiBase.TrimEnd("/")

$sourceHealth = Invoke-RestMethod -Uri "$apiBase/tnved/health" -TimeoutSec 20
if ($sourceHealth.status -ne "ok" -or $sourceHealth.preflight.ok -ne $true) {
    throw "TNVED API is not healthy from the voice host"
}

$currentHealth = Invoke-RestMethod -Uri "http://127.0.0.1:3899/health" -TimeoutSec 10
if ([int]$currentHealth.activeCalls -gt 0) {
    throw "Refusing deployment while a call is active"
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$taskSid = ([Security.Principal.NTAccount]$task.Principal.UserId).
    Translate([Security.Principal.SecurityIdentifier]).
    Value
if ($taskSid -ne "S-1-5-18") {
    throw "Sidecar task must run as SYSTEM, actual SID: $taskSid"
}
$watchdogTask = Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction Stop
$watchdogSid = ([Security.Principal.NTAccount]$watchdogTask.Principal.UserId).
    Translate([Security.Principal.SecurityIdentifier]).
    Value
if ($watchdogSid -ne "S-1-5-18") {
    throw "Sidecar watchdog task must run as SYSTEM, actual SID: $watchdogSid"
}

foreach ($name in $expected.Keys) {
    $stagedPath = Join-Path $StagePath $name
    if (!(Test-Path -LiteralPath $stagedPath)) {
        throw "Missing staged file: $name"
    }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedPath).Hash
    if ($actualHash -ne $expected[$name]) {
        throw "Staged hash mismatch: $name"
    }
}

Stop-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
    Start-Sleep -Milliseconds 500
    $listener = Get-NetTCPConnection -LocalPort 3899 -State Listen -ErrorAction SilentlyContinue
} while ($listener -and [DateTime]::UtcNow -lt $deadline)
if ($listener) {
    $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $listenerOwner = Invoke-CimMethod -InputObject $listenerProcess -MethodName GetOwnerSid
    if (
        $listenerOwner.Sid -ne "S-1-5-18" -or
        $listenerProcess.CommandLine -notlike "*$TargetRoot\sip-sidecar.mjs*"
    ) {
        throw "Refusing to stop an unexpected process listening on port 3899"
    }
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
    $listener = Get-NetTCPConnection -LocalPort 3899 -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        throw "Sidecar listener did not stop"
    }
}

foreach ($name in $expected.Keys) {
    $targetPath = Join-Path $TargetRoot $name
    if (Test-Path -LiteralPath $targetPath) {
        Copy-Item -LiteralPath $targetPath -Destination "$targetPath.tnved-$Stamp.bak" -Force
    }
    Copy-Item -LiteralPath (Join-Path $StagePath $name) -Destination $targetPath -Force
}

Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.tnved-$Stamp.bak" -Force
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$config | Add-Member -NotePropertyName tnvedApiBase -NotePropertyValue $apiBase -Force
$config | Add-Member -NotePropertyName tnvedConsultationEnabled -NotePropertyValue $true -Force
$configJson = $config | ConvertTo-Json -Depth 100
[IO.File]::WriteAllText($ConfigPath, $configJson, [Text.UTF8Encoding]::new($false))

Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$deadline = [DateTime]::UtcNow.AddSeconds(90)
$health = $null
$lastHealthError = $null
do {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:3899/health" -TimeoutSec 10
        $lastHealthError = $null
    } catch {
        $health = $null
        $lastHealthError = $_.Exception.Message
    }
} while (
    (
        !$health -or
        $health.status -ne "ok" -or
        $health.registered -ne $true
    ) -and
    [DateTime]::UtcNow -lt $deadline
)

if (!$health -or $health.status -ne "ok" -or $health.registered -ne $true) {
    throw "Sidecar failed health/registration: $lastHealthError"
}
if ([int]$health.salesScenario.version -ne 13) {
    throw "Expected scenario v13, got $($health.salesScenario.version)"
}
if ($health.tnvedConsultation.enabled -ne $true) {
    throw "TNVED consultation is not enabled"
}
if ($health.tnvedConsultation.apiBase -ne $apiBase) {
    throw "Unexpected TNVED API base"
}
if (@($health.missing).Count -ne 0) {
    throw "Sidecar reports missing dependencies: $($health.missing -join ', ')"
}

$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
[pscustomobject]@{
    status = "ok"
    task_sid = $taskSid
    task_state = [string](Get-ScheduledTask -TaskName $TaskName).State
    task_last_result = $taskInfo.LastTaskResult
    registered = [bool]$health.registered
    openai_key_present = [bool]$health.openaiApiKeyPresent
    scenario_id = [string]$health.salesScenario.id
    scenario_version = [int]$health.salesScenario.version
    tnved_enabled = [bool]$health.tnvedConsultation.enabled
    tnved_api = [string]$health.tnvedConsultation.apiBase
    tnved_kb = [string]$sourceHealth.preflight.kb_version
    retrieval_noise_ratio = [double]$sourceHealth.preflight.retrieval_noise_ratio
    missing = @($health.missing)
} | ConvertTo-Json -Compress
