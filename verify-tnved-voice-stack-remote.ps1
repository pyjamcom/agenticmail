[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExpectedSidecarHash,
    [Parameter(Mandatory = $true)][string]$ExpectedScenarioHash,
    [Parameter(Mandatory = $true)][string]$ExpectedReadmeHash,
    [Parameter(Mandatory = $true)][string]$ProductCardBase64,
    [string]$TnvedApiBase = "http://10.0.200.101:8100",
    [string]$SidecarHealthUrl = "http://127.0.0.1:3899/health",
    [string]$ConfigPath = "C:\Users\pavel\.agenticmail\pbx199.local.json",
    [string]$AgenticMailConfigPath = "C:\Users\pavel\.agenticmail\config.json"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$apiBase = $TnvedApiBase.TrimEnd("/")
$sidecarRoot = "C:\codex_tools\agenticmail\sip-sidecar"
$expectedHashes = @{
    "sip-sidecar.mjs" = $ExpectedSidecarHash
    "sales-call-scenario.json" = $ExpectedScenarioHash
    "README.md" = $ExpectedReadmeHash
}
foreach ($name in $expectedHashes.Keys) {
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $sidecarRoot $name)).Hash
    if ($actualHash -ne $expectedHashes[$name]) {
        throw "Deployed file hash mismatch: $name"
    }
}

$sidecarHealth = Invoke-RestMethod -Uri $SidecarHealthUrl -TimeoutSec 15
if (
    $sidecarHealth.status -ne "ok" -or
    $sidecarHealth.registered -ne $true -or
    [int]$sidecarHealth.salesScenario.version -ne 13 -or
    $sidecarHealth.tnvedConsultation.enabled -ne $true -or
    @($sidecarHealth.missing).Count -ne 0
) {
    throw "Sidecar health validation failed"
}

$taskChecks = @(
    "AgenticMail-SIP-Sidecar-Service",
    "AgenticMail-SIP-Sidecar-Watchdog"
) | ForEach-Object {
    $task = Get-ScheduledTask -TaskName $_ -ErrorAction Stop
    $sid = ([Security.Principal.NTAccount]$task.Principal.UserId).
        Translate([Security.Principal.SecurityIdentifier]).
        Value
    if ($sid -ne "S-1-5-18") {
        throw "$_ does not run as SYSTEM"
    }
    $taskInfo = Get-ScheduledTaskInfo -TaskName $_ -ErrorAction Stop
    [pscustomobject]@{
        name = $_
        sid = $sid
        state = [string]$task.State
        last_result = $taskInfo.LastTaskResult
    }
}

$listener = Get-NetTCPConnection -LocalPort 3899 -State Listen -ErrorAction Stop |
    Select-Object -First 1
$listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
$listenerOwner = Invoke-CimMethod -InputObject $listenerProcess -MethodName GetOwnerSid
if (
    $listenerOwner.Sid -ne "S-1-5-18" -or
    $listenerProcess.CommandLine -notlike "*sip-sidecar.mjs*"
) {
    throw "Port 3899 is not owned by the SYSTEM sidecar"
}

$tnvedHealth = Invoke-RestMethod -Uri "$apiBase/tnved/health" -TimeoutSec 20
if ($tnvedHealth.status -ne "ok" -or $tnvedHealth.preflight.ok -ne $true) {
    throw "TNVED API health validation failed"
}

$productCardJson = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($ProductCardBase64)
)
$classified = Invoke-RestMethod `
    -Method Post `
    -Uri "$apiBase/tnved/classify" `
    -ContentType "application/json; charset=utf-8" `
    -Body ([Text.Encoding]::UTF8.GetBytes($productCardJson)) `
    -TimeoutSec 60
$requestId = [string]$classified.draft.request_id
if ([string]::IsNullOrWhiteSpace($requestId)) {
    throw "TNVED classifier returned no request ID"
}

$advisory = (
    Invoke-RestMethod `
        -Method Post `
        -Uri "$apiBase/tnved/classify/$requestId/advisory" `
        -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes('{"customs_value_rub":100000}')) `
        -TimeoutSec 60
).advisory
if (
    $advisory.code -ne "3919900000" -or
    $advisory.payments.status -ne "calculated" -or
    $advisory.non_tariff.status -ne "ok" -or
    [string]::IsNullOrWhiteSpace([string]$advisory.non_tariff.spoken_summary)
) {
    throw "TNVED advisory smoke validation failed"
}

$agentConfig = Get-Content -Raw -LiteralPath $AgenticMailConfigPath | ConvertFrom-Json
$openAiKey = [string]$agentConfig.openaiApiKey
if (
    [string]::IsNullOrWhiteSpace($openAiKey) -and
    $null -ne $agentConfig.voiceProviderKeys
) {
    $openAiKey = [string]$agentConfig.voiceProviderKeys.openai
}
if ([string]::IsNullOrWhiteSpace($openAiKey)) {
    throw "OpenAI API key is missing"
}
$model = [string]$sidecarHealth.voice.model
$modelInfo = Invoke-RestMethod `
    -Uri "https://api.openai.com/v1/models/$model" `
    -Headers @{ Authorization = "Bearer $openAiKey" } `
    -TimeoutSec 30
if ([string]$modelInfo.id -ne $model) {
    throw "OpenAI model lookup returned an unexpected model"
}

$configBytes = [IO.File]::ReadAllBytes($ConfigPath)
$configHasBom = (
    $configBytes.Length -ge 3 -and
    $configBytes[0] -eq 0xEF -and
    $configBytes[1] -eq 0xBB -and
    $configBytes[2] -eq 0xBF
)
$stderrPath = "C:\Users\pavel\.agenticmail\logs\sip.service.stderr.log"
$stderrBytes = if (Test-Path -LiteralPath $stderrPath) {
    (Get-Item -LiteralPath $stderrPath).Length
} else {
    -1
}
if ($stderrBytes -gt 0) {
    throw "Sidecar stderr is not empty"
}

[pscustomobject]@{
    status = "ok"
    sip_registered = [bool]$sidecarHealth.registered
    sidecar_owner_sid = $listenerOwner.Sid
    tasks = @($taskChecks)
    scenario_version = [int]$sidecarHealth.salesScenario.version
    openai_model = $model
    openai_api_authenticated = $true
    tnved_kb = [string]$tnvedHealth.preflight.kb_version
    retrieval_noise_ratio = [double]$tnvedHealth.preflight.retrieval_noise_ratio
    smoke_code = [string]$advisory.code
    smoke_duty = [string]$advisory.duty.base.rate_text
    smoke_vat = [string]$advisory.vat.base.rate_text
    smoke_duty_plus_vat_rub = $advisory.payments.duty_plus_vat_rub
    non_tariff_status = [string]$advisory.non_tariff.status
    non_tariff_necessity = [string]$advisory.non_tariff.necessity
    non_tariff_categories = @($advisory.non_tariff.spoken_categories).Count
    config_has_utf8_bom = $configHasBom
    sidecar_stderr_bytes = $stderrBytes
    missing = @($sidecarHealth.missing)
} | ConvertTo-Json -Depth 8 -Compress
