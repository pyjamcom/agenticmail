param(
  [string]$ApiBase = "http://127.0.0.1:3829",
  [string]$AgenticMailConfigPath = "$env:USERPROFILE\.agenticmail\config.json",
  [string]$WorkspaceRoot = "C:\codex_tools\Purchasing department",
  [string]$TwilioEnvPath = "C:\codex_tools\Purchasing department\config\twilio_runtime.local.env",
  [string]$PbxConfigPath = "$env:USERPROFILE\.agenticmail\pbx199.local.json",
  [int]$SidecarHealthPort = 3899,
  [int]$ExchangeEwsSidecarHealthPort = 3901,
  [string]$Mailbox = "sales@nbr.ru",
  [string]$AgentName = "sales"
)

$ErrorActionPreference = "Stop"

function Read-DotEnv($Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $map[$line.Substring(0, $idx).Trim()] = $line.Substring($idx + 1).Trim()
  }
  return $map
}

function Invoke-JsonNode($Script) {
  $tmp = [System.IO.Path]::GetTempFileName() + ".mjs"
  try {
    [System.IO.File]::WriteAllText($tmp, $Script, [System.Text.UTF8Encoding]::new($false))
    & "C:\codex_tools\node-v22.23.1-win-x64\node.exe" $tmp
  }
  finally {
    Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
}

$packet = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  agenticmail = [ordered]@{}
  exchange = [ordered]@{}
  openai = [ordered]@{}
  twilio = [ordered]@{}
  pbx = [ordered]@{}
  blocking = @()
  warnings = @()
  nextActions = @()
}

if (-not (Test-Path -LiteralPath $AgenticMailConfigPath)) {
  $packet.agenticmail.configFound = $false
  $packet.blocking += "agenticmail_config_missing"
} else {
  $configRaw = Get-Content -LiteralPath $AgenticMailConfigPath -Raw
  $config = $configRaw | ConvertFrom-Json
  $packet.agenticmail.configFound = $true
  $packet.openai.voiceRuntime = $config.voiceRuntime
  $packet.openai.hasApiKey = [bool]$config.openaiApiKey
  if (-not $config.openaiApiKey) {
    $packet.blocking += "openai_api_key_missing"
    $packet.nextActions += "Run setup-openai-voice.ps1 with OPENAI_API_KEY or hidden prompt."
  }

  try {
    $health = Invoke-RestMethod -Method Get -Uri "$ApiBase/api/agenticmail/health" -Headers @{ Authorization = "Bearer $($config.masterKey)" }
    $packet.agenticmail.health = $health.status
    $packet.agenticmail.services = $health.services
  } catch {
    $packet.agenticmail.health = "unreachable"
    $packet.blocking += "agenticmail_api_unreachable"
  }

  try {
    $accounts = Invoke-RestMethod -Method Get -Uri "$ApiBase/api/agenticmail/accounts" -Headers @{ Authorization = "Bearer $($config.masterKey)" }
    $agent = @($accounts.agents | Where-Object { $_.name -eq $AgentName } | Select-Object -First 1)
    $packet.agenticmail.salesAgentExists = [bool]$agent
    if ($agent) {
      $packet.agenticmail.salesAgentEmail = $agent.email
      $phone = Invoke-RestMethod -Method Get -Uri "$ApiBase/api/agenticmail/phone/transport/config" -Headers @{ Authorization = "Bearer $($agent.apiKey)" }
      $packet.twilio.agentPhoneConfigured = [bool]$phone.configured
      if ($phone.configured) {
        $packet.twilio.provider = $phone.transport.provider
        $packet.twilio.phoneNumber = $phone.transport.phoneNumber
      }
    } else {
      $packet.blocking += "sales_agent_missing"
    }
  } catch {
    $packet.agenticmail.accountCheckError = $_.Exception.GetType().Name
  }
}

$twilio = Read-DotEnv $TwilioEnvPath
$packet.twilio.envFound = (Test-Path -LiteralPath $TwilioEnvPath)
$packet.twilio.hasAccountSid = [bool]$twilio["TWILIO_ACCOUNT_SID"]
$packet.twilio.hasAuthToken = [bool]$twilio["TWILIO_AUTH_TOKEN"]
$packet.twilio.hasVoiceFrom = [bool]$twilio["TWILIO_VOICE_FROM"]
$packet.twilio.hasWebhookBaseUrl = [bool]$twilio["TWILIO_PUBLIC_WEBHOOK_BASE_URL"]
$packet.twilio.hasWebhookSecret = [bool]$twilio["SECURE_CONTACT_ENCRYPTION_KEY"]
if (-not $packet.twilio.hasAuthToken) {
  $packet.warnings += "twilio_auth_token_missing"
  $packet.nextActions += "Fill TWILIO_AUTH_TOKEN, then run setup-twilio-phone-from-local-config.ps1."
}

try {
  $pbxJson = & powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\check-pbx-extension199.ps1" -ConfigPath $PbxConfigPath -SidecarHealthPort $SidecarHealthPort
  $pbx = $pbxJson | ConvertFrom-Json
  $packet.pbx.configFound = [bool]$pbx.configFound
  $packet.pbx.server = $pbx.server
  $packet.pbx.serverAlias = $pbx.serverAlias
  $packet.pbx.port = $pbx.port
  $packet.pbx.transport = $pbx.transport
  $packet.pbx.username = $pbx.username
  $packet.pbx.secretStored = [bool]$pbx.secretStored
  $packet.pbx.tcpPortOpen = [bool]$pbx.tcpPortOpen
  $packet.pbx.readyForRegistrationTest = [bool]$pbx.readyForRegistrationTest
  $packet.pbx.readyForLiveAnswer = [bool]$pbx.readyForLiveAnswer
  $packet.pbx.agenticmailDirectSipSupported = [bool]$pbx.agenticmailDirectSipSupported
  $packet.pbx.sipSidecarSupported = [bool]$pbx.sipSidecarSupported
  $packet.pbx.sipSidecarScriptFound = [bool]$pbx.sipSidecarScriptFound
  $packet.pbx.sipSidecarRunning = [bool]$pbx.sipSidecarRunning
  $packet.pbx.liveAnswerEnabled = [bool]$pbx.liveAnswerEnabled
  $packet.pbx.liveOutboundEnabled = [bool]$pbx.liveOutboundEnabled
  if (-not $pbx.configFound) {
    $packet.blocking += "pbx_config_missing"
    $packet.nextActions += "Run setup-pbx-extension199.ps1 and enter the PBX password in the hidden prompt."
  } elseif (-not $pbx.secretStored) {
    $packet.blocking += "pbx_secret_missing"
    $packet.nextActions += "Run setup-pbx-extension199.ps1 without -NoSecret to store the PBX password with Windows DPAPI."
  }
  if ($pbx.configFound -and -not $pbx.readyForLiveAnswer) {
    $packet.blocking += "pbx_live_answer_not_ready"
    $packet.nextActions += "Run start-sip-sidecar.ps1 after PBX secret and OPENAI_API_KEY are configured."
  }
} catch {
  $packet.pbx.checkError = $_.Exception.GetType().Name
  $packet.blocking += "pbx_check_failed"
}

try {
  $ewsSidecarJson = & powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\check-exchange-ews-sidecar.ps1" -HealthPort $ExchangeEwsSidecarHealthPort
  $ewsSidecar = $ewsSidecarJson | ConvertFrom-Json
  $packet.exchange.ewsSidecarRunning = [bool]$ewsSidecar.ProcessRunning
  $packet.exchange.ewsSidecarHealthReachable = [bool]$ewsSidecar.HealthReachable
  $packet.exchange.ewsSidecarStatus = $ewsSidecar.Health.status
  $packet.exchange.ewsSidecarInitialized = [bool]$ewsSidecar.Health.initialized
  $packet.exchange.ewsSidecarReady = [bool](
    $ewsSidecar.ProcessRunning -and
    $ewsSidecar.HealthReachable -and
    $ewsSidecar.Health.status -eq "ok" -and
    $ewsSidecar.Health.initialized
  )
} catch {
  $packet.exchange.ewsSidecarReady = $false
  $packet.exchange.ewsSidecarCheckError = $_.Exception.GetType().Name
}

try {
  $ewsJson = & powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\check-sales-current-user-ews.ps1" -Mailbox $Mailbox -WorkspaceRoot $WorkspaceRoot
  $ews = $ewsJson | ConvertFrom-Json
  $packet.exchange.currentUserCanOpenMailbox = [bool]$ews.current_user_can_open
  $packet.exchange.rootFolderSampleCount = $ews.root_folder_sample_count
  $packet.exchange.inboxOk = [bool]$ews.inbox_ok
  $packet.exchange.inboxErrorType = $ews.inbox_error_type
  if (-not $ews.current_user_can_open) {
    $packet.warnings += "sales_mailbox_not_accessible_via_current_user_sspi"
  }
} catch {
  $packet.exchange.currentUserCheckError = $_.Exception.GetType().Name
  $packet.blocking += "sales_mailbox_check_failed"
}

try {
  $adJson = & powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\check-sales-ad-recipient.ps1" -Email $Mailbox
  $ad = $adJson | ConvertFrom-Json
  $packet.exchange.adRecipientFound = [bool]$ad.Mail
  $packet.exchange.adRecipientSamAccountName = $ad.SamAccountName
  $packet.exchange.adRecipientUpn = $ad.UserPrincipalName
  $packet.exchange.adRecipientHasMailboxDatabase = [bool]$ad.HasMailboxDatabase
} catch {
  $packet.exchange.adCheckError = $_.Exception.GetType().Name
}

$packet.readyForInboundExchange = [bool](
  ($packet.exchange.currentUserCanOpenMailbox -or $false) -or
  ($packet.exchange.ewsSidecarReady -or $false)
)
if (-not $packet.readyForInboundExchange) {
  $packet.blocking += "sales_mailbox_inbound_not_ready"
  $packet.nextActions += "Start exchange-ews-sidecar or restore a verified Exchange mailbox access path."
}
$packet.readyForRealtimeVoice = [bool](
  $packet.openai.hasApiKey -and
  (($packet.twilio.agentPhoneConfigured -or $false) -or ($packet.pbx.readyForLiveAnswer -or $false))
)
$packet.readyForPbxRegistrationTest = [bool]($packet.pbx.readyForRegistrationTest -or $false)
$packet.readyForPbxLiveAnswer = [bool]($packet.pbx.readyForLiveAnswer -or $false)
$packet.readyForSalesAgentLiveTest = [bool]($packet.readyForInboundExchange -and $packet.readyForRealtimeVoice)

$packet | ConvertTo-Json -Depth 8
