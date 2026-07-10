param(
  [string]$ApiBase = "http://127.0.0.1:3829",
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\config.json",
  [string]$Email = "sales@nbr.ru",
  [string]$AgentName = "sales",
  [string]$AuthUsername = "",
  [string]$SmtpHost = "mail.vdostup.ru",
  [int]$SmtpPort = 587,
  [string]$ImapHost = "mail.vdostup.ru",
  [int]$ImapPort = 993
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "AgenticMail config not found: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not $config.masterKey) {
  throw "AgenticMail masterKey is missing in config."
}

$securePassword = Read-Host "Exchange password/app-password for $Email" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if (-not $password) {
    throw "Empty password was entered."
  }

  $body = @{
    provider = "custom"
    email = $Email
    authUsername = if ($AuthUsername) { $AuthUsername } else { $Email }
    password = $password
    smtpHost = $SmtpHost
    smtpPort = $SmtpPort
    imapHost = $ImapHost
    imapPort = $ImapPort
    agentName = $AgentName
    agentRole = "assistant"
    useSubaddressing = $false
  } | ConvertTo-Json -Depth 5

  $response = Invoke-RestMethod `
    -Method Post `
    -Uri "$ApiBase/api/agenticmail/gateway/relay" `
    -Headers @{ Authorization = "Bearer $($config.masterKey)" } `
    -ContentType "application/json" `
    -Body $body

  [pscustomobject]@{
    Status = $response.status
    Mode = $response.mode
    RelayEmail = $response.email
    Provider = $response.provider
    AgentName = $response.agent.name
    AgentEmail = $response.agent.email
    SenderAddress = $response.agent.subAddress
    ApiKey = "[redacted]"
  } | ConvertTo-Json
}
finally {
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if (Get-Variable -Name password -Scope Local -ErrorAction SilentlyContinue) {
    Remove-Variable -Name password -Scope Local -Force
  }
}
