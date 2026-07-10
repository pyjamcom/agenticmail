param(
  [string]$TwilioEnvPath = "C:\codex_tools\Purchasing department\config\twilio_runtime.local.env",
  [string]$AgenticMailConfigPath = "$env:USERPROFILE\.agenticmail\config.json",
  [string]$ApiBase = "http://127.0.0.1:3829",
  [string]$AgentName = "sales"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $TwilioEnvPath)) {
  throw "Twilio env file not found: $TwilioEnvPath"
}
if (-not (Test-Path -LiteralPath $AgenticMailConfigPath)) {
  throw "AgenticMail config not found: $AgenticMailConfigPath"
}

function Read-DotEnv($Path) {
  $map = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    $map[$key] = $value
  }
  return $map
}

$twilio = Read-DotEnv $TwilioEnvPath
$required = @(
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_VOICE_FROM",
  "TWILIO_PUBLIC_WEBHOOK_BASE_URL",
  "SECURE_CONTACT_ENCRYPTION_KEY"
)

$missing = @($required | Where-Object { -not $twilio[$_] })
if ($missing.Count -gt 0) {
  throw "Missing required Twilio fields for safe AgenticMail live voice setup: $($missing -join ', ')"
}

$amConfig = Get-Content -LiteralPath $AgenticMailConfigPath -Raw | ConvertFrom-Json
if (-not $amConfig.masterKey) {
  throw "AgenticMail masterKey is missing."
}

$accounts = Invoke-RestMethod `
  -Method Get `
  -Uri "$ApiBase/api/agenticmail/accounts" `
  -Headers @{ Authorization = "Bearer $($amConfig.masterKey)" }

$agent = @($accounts.agents | Where-Object { $_.name -eq $AgentName } | Select-Object -First 1)
if (-not $agent) {
  throw "Agent '$AgentName' not found in AgenticMail."
}

$body = @{
  provider = "twilio"
  phoneNumber = $twilio["TWILIO_VOICE_FROM"]
  accountSid = $twilio["TWILIO_ACCOUNT_SID"]
  authToken = $twilio["TWILIO_AUTH_TOKEN"]
  webhookBaseUrl = $twilio["TWILIO_PUBLIC_WEBHOOK_BASE_URL"]
  webhookSecret = $twilio["SECURE_CONTACT_ENCRYPTION_KEY"]
  capabilities = @("call_control", "realtime_media")
  supportedRegions = @("WORLD")
} | ConvertTo-Json -Depth 5

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$ApiBase/api/agenticmail/phone/transport/setup" `
  -Headers @{ Authorization = "Bearer $($agent.apiKey)" } `
  -ContentType "application/json" `
  -Body $body

[pscustomobject]@{
  Status = if ($response.success) { "ok" } else { "failed" }
  Provider = $response.transport.provider
  PhoneNumber = $response.transport.phoneNumber
  WebhookBaseUrl = $response.transport.webhookBaseUrl
  Password = "[redacted]"
  WebhookSecret = "[redacted]"
} | ConvertTo-Json
