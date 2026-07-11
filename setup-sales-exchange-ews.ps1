param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\exchange-sales.local.json",
  [string]$SecretPath = "$env:USERPROFILE\.agenticmail\exchange-sales.secret.dpapi",
  [string]$Username = "NB\ai_sales",
  [string]$Mailbox = "sales@nbr.ru",
  [string]$Server = "ex2.vdostup.ru",
  [string]$AgentRecipient = "sales@localhost",
  [string]$CaBundlePath = "C:\codex_tools\Purchasing department\artifacts\exchange_tls\ad4-ca.pem",
  [int]$PollSeconds = 30,
  [int]$HealthPort = 3901,
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-service-common.ps1")

$dir = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Path $dir -Force | Out-Null

if ($NonInteractive) {
  if (-not $env:EXCHANGE_SALES_PASSWORD) {
    throw "EXCHANGE_SALES_PASSWORD is required in non-interactive mode."
  }
  $securePassword = ConvertTo-SecureString $env:EXCHANGE_SALES_PASSWORD -AsPlainText -Force
} else {
  $securePassword = Read-Host "Exchange password for $Username" -AsSecureString
}

$utf8NoBom = [Text.UTF8Encoding]::new($false)
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  Write-AgenticMailMachineSecretFile -Path $SecretPath -Secret $plainPassword
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$config = [ordered]@{
  profile = "exchange-sales-ews"
  enabled = $true
  server = $Server
  username = $Username
  mailbox = $Mailbox
  agentRecipient = $AgentRecipient
  apiBase = "http://127.0.0.1:3829"
  agenticmailConfigPath = "$env:USERPROFILE\.agenticmail\config.json"
  secretRef = $SecretPath
  secretFormat = "windows_dpapi_local_machine_v1"
  caBundlePath = $CaBundlePath
  verifyTls = $true
  pollSeconds = $PollSeconds
  healthPort = $HealthPort
  statePath = "$env:USERPROFILE\.agenticmail\exchange-sales\state.json"
  auditPath = "$env:USERPROFILE\.agenticmail\exchange-sales\events.jsonl"
  importExistingOnFirstRun = $false
  configuredAt = [DateTimeOffset]::Now.ToString("o")
}
[IO.File]::WriteAllText($ConfigPath, ($config | ConvertTo-Json -Depth 5), $utf8NoBom)

function Protect-SecretFile([string]$Path) {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Path /inheritance:r /grant:r `
    "*${currentSid}:F" `
    '*S-1-5-18:F' `
    '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to protect secret file: $Path" }
}

function Protect-SecretDirectory([string]$Path) {
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Path /inheritance:r /grant:r `
    "*${currentSid}:(OI)(CI)F" `
    '*S-1-5-18:(OI)(CI)F' `
    '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to protect secret directory: $Path" }
}

Protect-SecretFile $SecretPath
Protect-SecretFile $ConfigPath
Protect-SecretDirectory (Split-Path -Parent $config.statePath)

[pscustomobject]@{
  Status = "configured"
  Mailbox = $Mailbox
  Server = $Server
  Username = $Username
  SecretStored = (Test-Path -LiteralPath $SecretPath)
  VerifyTls = $true
  AgentRecipient = $AgentRecipient
} | ConvertTo-Json
