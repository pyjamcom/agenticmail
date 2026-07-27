[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExpectedSidecarHash,
    [Parameter(Mandatory = $true)][string]$ExpectedScenarioHash,
    [Parameter(Mandatory = $true)][string]$ExpectedReadmeHash,
    [Parameter(Mandatory = $true)][string]$ExpectedServiceRatesHash,
    [Parameter(Mandatory = $true)][string]$ProductCardBase64,
    [int]$ExpectedScenarioVersion = 17,
    [string]$TnvedApiBase = "http://10.0.200.101:8100",
    [string]$SidecarHealthUrl = "http://127.0.0.1:3899/health",
    [string]$ConfigPath = "C:\Users\pavel\.agenticmail\pbx199.local.json",
    [string]$AgenticMailConfigPath = "C:\Users\pavel\.agenticmail\config.json",
    [string]$NodePath = "C:\codex_tools\node-v22.23.1-win-x64\node.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-Base64JsonPost {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$PayloadBase64,
        [int]$TimeoutSec = 60
    )

    if (!(Test-Path -LiteralPath $NodePath)) {
        throw "Node.js executable was not found: $NodePath"
    }
    $nodeScript = @'
const [url, payloadBase64, timeoutText] = process.argv.slice(2);
const { gzipSync } = await import("node:zlib");
const { createHash } = await import("node:crypto");
const compressed = gzipSync(Buffer.from(payloadBase64, "base64"));
const mask = createHash("sha256")
  .update("TNVED UTF8 transport mask v1", "utf8")
  .digest();
const masked = Buffer.allocUnsafe(compressed.length);
for (let index = 0; index < compressed.length; index += 1) {
  masked[index] = compressed[index] ^ mask[index % mask.length];
}
const encodedBody = Buffer.concat([
  createHash("sha256").update(compressed).digest(),
  masked,
]).toString("base64");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number(timeoutText) * 1000);
(async () => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-tnved-body-encoding": "masked-gzip-base64-v1",
    },
    body: encodedBody,
    signal: controller.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  process.stdout.write(Buffer.from(text, "utf8").toString("base64"));
})()
  .catch((error) => {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(timer));
'@
    $nodeHelperPath = Join-Path $env:TEMP (
        "agenticmail-utf8-post-{0}.mjs" -f [Guid]::NewGuid().ToString("N")
    )
    try {
        [IO.File]::WriteAllText(
            $nodeHelperPath,
            $nodeScript,
            [Text.UTF8Encoding]::new($false)
        )
        $responseBase64 = (
            & $NodePath $nodeHelperPath $Uri $PayloadBase64 $TimeoutSec
        ) -join ""
        if ($LASTEXITCODE -ne 0) {
            throw "Node.js UTF-8 POST failed for $Uri"
        }
    } finally {
        Remove-Item -LiteralPath $nodeHelperPath -Force -ErrorAction SilentlyContinue
    }
    $responseJson = [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String($responseBase64.Trim())
    )
    return $responseJson | ConvertFrom-Json
}

function Invoke-Utf8JsonPost {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Json,
        [int]$TimeoutSec = 60
    )

    $payloadBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Json))
    return Invoke-Base64JsonPost `
        -Uri $Uri `
        -PayloadBase64 $payloadBase64 `
        -TimeoutSec $TimeoutSec
}

$apiBase = $TnvedApiBase.TrimEnd("/")
$sidecarRoot = "C:\codex_tools\agenticmail\sip-sidecar"
$expectedHashes = @{
    "sip-sidecar.mjs" = $ExpectedSidecarHash
    "sales-call-scenario.json" = $ExpectedScenarioHash
    "README.md" = $ExpectedReadmeHash
    "nbr-service-rates.json" = $ExpectedServiceRatesHash
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
    [int]$sidecarHealth.salesScenario.version -ne $ExpectedScenarioVersion -or
    $sidecarHealth.tnvedConsultation.enabled -ne $true -or
    $sidecarHealth.tnvedConsultation.bodyEncoding -ne "masked-gzip-base64-v1" -or
    $sidecarHealth.vehicleCustomsCalculation.enabled -ne $true -or
    $sidecarHealth.nbrServiceCostCalculation.configured -ne $true -or
    [int]$sidecarHealth.nbrServiceCostCalculation.rateCount -ne 14 -or
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
if (
    $tnvedHealth.status -ne "ok" -or
    $tnvedHealth.preflight.ok -ne $true -or
    $tnvedHealth.vehicle_customs.ready -ne $true
) {
    throw "TNVED API health validation failed"
}

$vehiclePayload = @{
    calculation_date = "2026-07-26"
    import_route = "eaeu_status"
    vehicle_category = "M1"
    eaeu_goods_status_confirmed = $true
    importer_type = "individual"
    purpose = "personal_use"
    age_category = "up_to_3_years"
    propulsion = "ice_petrol"
    engine_cc = 1500
    power_hp = 100
    personal_recycling_eligible = $true
    eaeu_release_at_least_12_months = $true
    prior_owner_type = "individual"
} | ConvertTo-Json -Depth 8
$vehicleCalculation = (
    Invoke-Utf8JsonPost `
        -Uri "$apiBase/vehicle/customs/calculate" `
        -Json $vehiclePayload `
        -TimeoutSec 60
).calculation
if (
    $vehicleCalculation.status -ne "calculated" -or
    $vehicleCalculation.customs_payment.payment_type -ne "eaeu_goods_status" -or
    [double]$vehicleCalculation.totals.mandatory_total_rub -ne 3400
) {
    throw "Vehicle customs smoke validation failed"
}

$classified = Invoke-Base64JsonPost `
    -Uri "$apiBase/tnved/classify" `
    -PayloadBase64 $ProductCardBase64 `
    -TimeoutSec 60
$requestId = [string]$classified.draft.request_id
if ([string]::IsNullOrWhiteSpace($requestId)) {
    throw "TNVED classifier returned no request ID"
}

$advisory = (
    Invoke-Utf8JsonPost `
        -Uri "$apiBase/tnved/classify/$requestId/advisory" `
        -Json '{"customs_value_rub":100000}' `
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
    tnved_body_encoding = [string]$sidecarHealth.tnvedConsultation.bodyEncoding
    nbr_service_rates_configured = [bool]$sidecarHealth.nbrServiceCostCalculation.configured
    nbr_service_rates_version = [string]$sidecarHealth.nbrServiceCostCalculation.version
    nbr_service_rates_hash = [string]$sidecarHealth.nbrServiceCostCalculation.sourceHash
    nbr_service_rates_count = [int]$sidecarHealth.nbrServiceCostCalculation.rateCount
    openai_model = $model
    openai_api_authenticated = $true
    tnved_kb = [string]$tnvedHealth.preflight.kb_version
    vehicle_rate_version = [string]$tnvedHealth.vehicle_customs.rate_version
    vehicle_smoke_total_rub = [double]$vehicleCalculation.totals.mandatory_total_rub
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
