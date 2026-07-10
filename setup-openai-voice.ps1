param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\config.json",
  [string]$Voice = "marin",
  [switch]$SetRuntimeOnly
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "AgenticMail config not found: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

if (-not $config.PSObject.Properties["voiceProviderVoices"]) {
  $config | Add-Member -NotePropertyName voiceProviderVoices -NotePropertyValue ([pscustomobject]@{})
}
if (-not $config.PSObject.Properties["voiceRuntime"]) {
  $config | Add-Member -NotePropertyName voiceRuntime -NotePropertyValue "openai"
} else {
  $config.voiceRuntime = "openai"
}
$config.voiceProviderVoices | Add-Member -NotePropertyName openai -NotePropertyValue $Voice -Force

if (-not $SetRuntimeOnly) {
  $apiKey = $env:OPENAI_API_KEY
  if (-not $apiKey) {
    $secureKey = Read-Host "OPENAI_API_KEY" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
      $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
      if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      }
    }
  }
  if (-not $apiKey) {
    throw "OPENAI_API_KEY is required unless -SetRuntimeOnly is used."
  }
  if (-not $config.PSObject.Properties["openaiApiKey"]) {
    $config | Add-Member -NotePropertyName openaiApiKey -NotePropertyValue $apiKey
  } else {
    $config.openaiApiKey = $apiKey
  }
}

$json = $config | ConvertTo-Json -Depth 12
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $ConfigPath), $json, $utf8NoBom)

[pscustomobject]@{
  Status = "ok"
  VoiceRuntime = $config.voiceRuntime
  OpenAIApiKey = if ($config.openaiApiKey) { "[present]" } else { "[missing]" }
  OpenAIVoice = $config.voiceProviderVoices.openai
} | ConvertTo-Json
