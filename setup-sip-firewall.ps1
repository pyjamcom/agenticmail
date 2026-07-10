param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\pbx199.local.json"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "PBX config not found: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$signalingPort = if ($config.signalingPort) { [int]$config.signalingPort } else { 5070 }
$rtpMin = if ($config.rtpPortMin) { [int]$config.rtpPortMin } else { 40200 }
$rtpMax = if ($config.rtpPortMax) { [int]$config.rtpPortMax } else { 40398 }
$localAddress = if ($config.localIp) { [string]$config.localIp } else { "Any" }

$pbxAddresses = @()
if ([System.Net.IPAddress]::TryParse([string]$config.server, [ref]([System.Net.IPAddress]$null))) {
  $pbxAddresses = @([string]$config.server)
} else {
  $pbxAddresses = @(Resolve-DnsName -Name ([string]$config.server) -Type A -ErrorAction Stop |
    Select-Object -ExpandProperty IPAddress -Unique)
}
if ($pbxAddresses.Count -eq 0) {
  throw "PBX server did not resolve to an IPv4 address"
}

function Set-AgenticMailUdpRule {
  param(
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [string]$DisplayName,
    [Parameter(Mandatory)] [string]$LocalPort,
    [Parameter(Mandatory)] [string[]]$RemoteAddress
  )

  $rule = Get-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue
  if (-not $rule) {
    New-NetFirewallRule `
      -Name $Name `
      -DisplayName $DisplayName `
      -Description "Managed by AgenticMail SIP sidecar setup" `
      -Enabled True `
      -Profile Domain `
      -Direction Inbound `
      -Action Allow `
      -Protocol UDP `
      -LocalAddress $localAddress `
      -LocalPort $LocalPort `
      -RemoteAddress $RemoteAddress `
      -ErrorAction Stop | Out-Null
    return
  }

  $rule | Set-NetFirewallRule -Enabled True -Profile Domain -Direction Inbound -Action Allow -ErrorAction Stop | Out-Null
  $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol UDP -LocalPort $LocalPort -ErrorAction Stop | Out-Null
  $rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -LocalAddress $localAddress -RemoteAddress $RemoteAddress -ErrorAction Stop | Out-Null
}

Set-AgenticMailUdpRule `
  -Name "AgenticMail-SIP-Signaling-In" `
  -DisplayName "AgenticMail SIP signaling (inbound)" `
  -LocalPort ([string]$signalingPort) `
  -RemoteAddress $pbxAddresses

# Media relays can use addresses other than the PBX signaling host.
Set-AgenticMailUdpRule `
  -Name "AgenticMail-SIP-RTP-In" `
  -DisplayName "AgenticMail SIP RTP media (inbound)" `
  -LocalPort "$rtpMin-$rtpMax" `
  -RemoteAddress @("Any")

Get-NetFirewallRule -Name "AgenticMail-SIP-Signaling-In", "AgenticMail-SIP-RTP-In" |
  Select-Object Name, Enabled, Profile, Direction, Action
