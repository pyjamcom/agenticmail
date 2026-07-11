param(
  [string]$Server = "10.1.0.223",
  [string]$ServerAlias = "pbx.nbr.ru",
  [int]$Port = 5060,
  [ValidateSet("udp", "tcp")]
  [string]$Transport = "udp",
  [string]$Username = "199",
  [int]$SignalingPort = 5070,
  [int]$RtpPortMin = 40200,
  [int]$RtpPortMax = 40398,
  [int]$SidecarHttpPort = 3899,
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\pbx199.local.json",
  [string]$SecretPath = "$env:USERPROFILE\.agenticmail\pbx199.secret.dpapi",
  [switch]$EnableLiveAnswer,
  [switch]$EnableOutboundCalls,
  [switch]$NoSecret
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-service-common.ps1")

function Write-Utf8NoBom($Path, $Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Protect-LocalSecret($Path, [securestring]$Secret) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    Write-AgenticMailMachineSecretFile -Path $Path -Secret $plain
  } finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
}

$secretStored = Test-Path -LiteralPath $SecretPath
if (-not $NoSecret) {
  $secure = Read-Host -Prompt "PBX password for SIP extension $Username" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Length -eq 0) {
      throw "PBX password cannot be empty."
    }
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  Protect-LocalSecret -Path $SecretPath -Secret $secure
  $secretStored = $true
}

$payload = [ordered]@{
  profile = "sales-pbx-extension-199"
  provider = "nbr_internal_pbx"
  type = "sip_extension"
  server = $Server
  serverAlias = $ServerAlias
  port = $Port
  transport = $Transport
  username = $Username
  signalingPort = $SignalingPort
  rtpPortMin = $RtpPortMin
  rtpPortMax = $RtpPortMax
  sidecarHttpPort = $SidecarHttpPort
  secretRef = $SecretPath
  secretFormat = "windows_dpapi_local_machine_v1"
  secretStored = [bool]$secretStored
  liveAnswerEnabled = [bool]$EnableLiveAnswer
  liveOutboundEnabled = [bool]$EnableOutboundCalls
  agenticmailDirectSipSupported = $false
  sipSidecarSupported = $true
  sipSidecarScript = (Join-Path $PSScriptRoot "sip-sidecar\sip-sidecar.mjs")
  status = if ($secretStored) { "profile_and_secret_saved" } else { "profile_saved_secret_missing" }
  configuredAt = (Get-Date).ToString("o")
  notes = @(
    "AgenticMail core currently supports Twilio and 46elks phone providers, not direct SIP registration.",
    "This SIP profile is for a local PBX/SIP sidecar that registers extension 199 and bridges media to OpenAI Realtime.",
    "Live answering and outbound calls are controlled by liveAnswerEnabled and liveOutboundEnabled."
  )
}

Write-Utf8NoBom -Path $ConfigPath -Text ($payload | ConvertTo-Json -Depth 6)

[pscustomobject]@{
  status = "ok"
  configPath = $ConfigPath
  server = $Server
  serverAlias = $ServerAlias
  port = $Port
  transport = $Transport
  username = $Username
  secretStored = [bool]$secretStored
  liveAnswerEnabled = [bool]$EnableLiveAnswer
  liveOutboundEnabled = [bool]$EnableOutboundCalls
  agenticmailDirectSipSupported = $false
  sipSidecarSupported = $true
} | ConvertTo-Json -Depth 4
