param(
  [string]$ConfigPath = "$env:USERPROFILE\.agenticmail\pbx199.local.json",
  [int]$SidecarHealthPort = 3899,
  [switch]$RegisterCheck
)

$ErrorActionPreference = "Stop"

function Add-Blocking([System.Collections.ArrayList]$List, [string]$Code) {
  if (-not $List.Contains($Code)) {
    [void]$List.Add($Code)
  }
}

function ConvertFrom-LocalSecret($Path) {
  $secure = (Get-Content -LiteralPath $Path -Raw).Trim() | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Get-Md5Hex([string]$Text) {
  $md5 = [System.Security.Cryptography.MD5]::Create()
  try {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($Text)
    $hash = $md5.ComputeHash($bytes)
    return -join ($hash | ForEach-Object { $_.ToString("x2") })
  }
  finally {
    $md5.Dispose()
  }
}

function Get-DigestParam([string]$Header, [string]$Name) {
  $pattern = '(?i)(?:^|,\s*)' + [regex]::Escape($Name) + '\s*=\s*(?:"([^"]*)"|([^,\s]+))'
  $match = [regex]::Match($Header, $pattern)
  if (-not $match.Success) { return "" }
  if ($match.Groups[1].Success) { return $match.Groups[1].Value }
  return $match.Groups[2].Value
}

function New-SipBranch {
  return "z9hG4bK" + ([guid]::NewGuid().ToString("N").Substring(0, 16))
}

function New-SipRegisterRequest(
  [string]$Server,
  [int]$Port,
  [string]$Username,
  [string]$LocalIp,
  [int]$LocalPort,
  [string]$CallId,
  [string]$Tag,
  [int]$CSeq,
  [int]$Expires,
  [string]$Authorization
) {
  $uri = "sip:$Server"
  $hostPort = if ($Port -eq 5060) { $Server } else { "${Server}:${Port}" }
  $localHostPort = "${LocalIp}:${LocalPort}"
  $lines = @(
    "REGISTER $uri SIP/2.0",
    "Via: SIP/2.0/UDP $localHostPort;rport;branch=$(New-SipBranch)",
    "Max-Forwards: 70",
    "From: <sip:$Username@$hostPort>;tag=$Tag",
    "To: <sip:$Username@$hostPort>",
    "Call-ID: $CallId",
    "CSeq: $CSeq REGISTER",
    "Contact: <sip:$Username@$localHostPort;transport=udp>",
    "Expires: $Expires",
    "User-Agent: AgenticMail-PBX-Readiness",
    "Content-Length: 0"
  )
  if ($Authorization) {
    $beforeContentLength = $lines[0..($lines.Count - 2)]
    $lines = @($beforeContentLength + @("Authorization: $Authorization", $lines[-1]))
  }
  return ($lines -join "`r`n") + "`r`n`r`n"
}

function Invoke-UdpSip([System.Net.Sockets.UdpClient]$Client, [string]$Request) {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($Request)
  [void]$Client.Send($bytes, $bytes.Length)
  $remote = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Any, 0)
  $responseBytes = $Client.Receive([ref]$remote)
  return [System.Text.Encoding]::ASCII.GetString($responseBytes)
}

function Get-SipStatus([string]$Response) {
  $line = ($Response -split "`r?`n" | Select-Object -First 1)
  $code = $null
  if ($line -match 'SIP/2.0\s+(\d{3})') { $code = [int]$matches[1] }
  return [pscustomobject]@{ code = $code; line = $line }
}

function Test-SipRegisterUdp([string]$Server, [int]$Port, [string]$Username, [string]$Password) {
  $client = [System.Net.Sockets.UdpClient]::new(0)
  try {
    $client.Client.ReceiveTimeout = 5000
    $client.Connect($Server, $Port)
    $local = [System.Net.IPEndPoint]$client.Client.LocalEndPoint
    $localIp = $local.Address.ToString()
    $localPort = $local.Port
    $callId = ([guid]::NewGuid().ToString("N")) + "@agenticmail"
    $tag = [guid]::NewGuid().ToString("N").Substring(0, 10)

    $first = New-SipRegisterRequest -Server $Server -Port $Port -Username $Username -LocalIp $localIp -LocalPort $localPort -CallId $callId -Tag $tag -CSeq 1 -Expires 60 -Authorization ""
    $firstResponse = Invoke-UdpSip -Client $client -Request $first
    $firstStatus = Get-SipStatus $firstResponse

    if ($firstStatus.code -eq 200) {
      return [pscustomobject]@{
        attempted = $true
        ok = $true
        statusCode = 200
        statusLine = $firstStatus.line
        authChallenge = $false
        deregisterAttempted = $false
      }
    }

    if ($firstStatus.code -notin @(401, 407)) {
      return [pscustomobject]@{
        attempted = $true
        ok = $false
        statusCode = $firstStatus.code
        statusLine = $firstStatus.line
        authChallenge = $false
        deregisterAttempted = $false
      }
    }

    $authLine = ($firstResponse -split "`r?`n" | Where-Object { $_ -match '^(WWW-Authenticate|Proxy-Authenticate):' } | Select-Object -First 1)
    if (-not $authLine) {
      throw "SIP auth challenge did not include an authenticate header."
    }
    $challenge = $authLine -replace '^[^:]+:\s*Digest\s*', ''
    $realm = Get-DigestParam $challenge "realm"
    $nonce = Get-DigestParam $challenge "nonce"
    $qopRaw = Get-DigestParam $challenge "qop"
    $opaque = Get-DigestParam $challenge "opaque"
    $algorithm = Get-DigestParam $challenge "algorithm"
    if (-not $algorithm) { $algorithm = "MD5" }
    if ($algorithm.ToUpperInvariant() -ne "MD5") {
      throw "Unsupported SIP digest algorithm: $algorithm"
    }
    if (-not $realm -or -not $nonce) {
      throw "SIP auth challenge is missing realm or nonce."
    }

    $uri = "sip:$Server"
    $ha1 = Get-Md5Hex "$Username`:$realm`:$Password"
    $ha2 = Get-Md5Hex "REGISTER`:$uri"
    $qop = ""
    if ($qopRaw) {
      $qop = @(($qopRaw -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -eq "auth" } | Select-Object -First 1)
    }
    $cnonce = [guid]::NewGuid().ToString("N").Substring(0, 16)
    $nc = "00000001"
    if ($qop) {
      $digest = Get-Md5Hex "$ha1`:$nonce`:$nc`:$cnonce`:$qop`:$ha2"
      $authorization = "Digest username=`"$Username`", realm=`"$realm`", nonce=`"$nonce`", uri=`"$uri`", response=`"$digest`", algorithm=MD5, qop=$qop, nc=$nc, cnonce=`"$cnonce`""
    } else {
      $digest = Get-Md5Hex "$ha1`:$nonce`:$ha2"
      $authorization = "Digest username=`"$Username`", realm=`"$realm`", nonce=`"$nonce`", uri=`"$uri`", response=`"$digest`", algorithm=MD5"
    }
    if ($opaque) { $authorization += ", opaque=`"$opaque`"" }

    $second = New-SipRegisterRequest -Server $Server -Port $Port -Username $Username -LocalIp $localIp -LocalPort $localPort -CallId $callId -Tag $tag -CSeq 2 -Expires 60 -Authorization $authorization
    $secondResponse = Invoke-UdpSip -Client $client -Request $second
    $secondStatus = Get-SipStatus $secondResponse
    $ok = $secondStatus.code -eq 200

    $deregisterAttempted = $false
    if ($ok) {
      try {
        $nc2 = "00000002"
        if ($qop) {
          $digest2 = Get-Md5Hex "$ha1`:$nonce`:$nc2`:$cnonce`:$qop`:$ha2"
          $authorization2 = "Digest username=`"$Username`", realm=`"$realm`", nonce=`"$nonce`", uri=`"$uri`", response=`"$digest2`", algorithm=MD5, qop=$qop, nc=$nc2, cnonce=`"$cnonce`""
        } else {
          $digest2 = Get-Md5Hex "$ha1`:$nonce`:$ha2"
          $authorization2 = "Digest username=`"$Username`", realm=`"$realm`", nonce=`"$nonce`", uri=`"$uri`", response=`"$digest2`", algorithm=MD5"
        }
        if ($opaque) { $authorization2 += ", opaque=`"$opaque`"" }
        $third = New-SipRegisterRequest -Server $Server -Port $Port -Username $Username -LocalIp $localIp -LocalPort $localPort -CallId $callId -Tag $tag -CSeq 3 -Expires 0 -Authorization $authorization2
        [void](Invoke-UdpSip -Client $client -Request $third)
        $deregisterAttempted = $true
      } catch {
        $deregisterAttempted = $false
      }
    }

    return [pscustomobject]@{
      attempted = $true
      ok = $ok
      statusCode = $secondStatus.code
      statusLine = $secondStatus.line
      authChallenge = $true
      realm = $realm
      deregisterAttempted = $deregisterAttempted
    }
  }
  finally {
    $client.Close()
  }
}

$blocking = [System.Collections.ArrayList]::new()
$packet = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  configFound = Test-Path -LiteralPath $ConfigPath
  configPath = $ConfigPath
  server = $null
  serverAlias = $null
  port = $null
  transport = $null
  username = $null
  secretStored = $false
  tcpPortOpen = $false
  registerCheck = [ordered]@{ requested = [bool]$RegisterCheck; attempted = $false; ok = $false }
  agenticmailDirectSipSupported = $false
  sipSidecarSupported = $false
  sipSidecarScriptFound = $false
  sipSidecarRunning = $false
  sipSidecarHealth = $null
  liveAnswerEnabled = $false
  liveOutboundEnabled = $false
  readyForRegistrationTest = $false
  readyForLiveAnswer = $false
  blocking = @()
}

if (-not $packet.configFound) {
  Add-Blocking $blocking "pbx_config_missing"
  $packet.blocking = @($blocking)
  $packet | ConvertTo-Json -Depth 8
  exit 0
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$packet.server = $config.server
$packet.serverAlias = $config.serverAlias
$packet.port = [int]$config.port
$packet.transport = $config.transport
$packet.username = $config.username
$packet.agenticmailDirectSipSupported = [bool]$config.agenticmailDirectSipSupported
$packet.sipSidecarSupported = [bool]$config.sipSidecarSupported
$packet.sipSidecarScriptFound = [bool]($config.sipSidecarScript -and (Test-Path -LiteralPath $config.sipSidecarScript))
$packet.liveAnswerEnabled = [bool]$config.liveAnswerEnabled
$packet.liveOutboundEnabled = [bool]$config.liveOutboundEnabled
$secretPath = [string]$config.secretRef
$packet.secretStored = [bool]($secretPath -and (Test-Path -LiteralPath $secretPath))

try {
  $tcp = Test-NetConnection -ComputerName $packet.server -Port $packet.port -WarningAction SilentlyContinue
  $packet.tcpPortOpen = [bool]$tcp.TcpTestSucceeded
} catch {
  $packet.tcpPortOpen = $false
}

if (-not $packet.tcpPortOpen) { Add-Blocking $blocking "pbx_sip_tcp_port_unreachable" }
if (-not $packet.secretStored) { Add-Blocking $blocking "pbx_secret_missing" }

if ($RegisterCheck) {
  if (-not $packet.secretStored) {
    Add-Blocking $blocking "pbx_register_check_secret_missing"
  } elseif ($packet.transport -ne "udp") {
    Add-Blocking $blocking "pbx_register_check_udp_only"
  } else {
    try {
      $password = ConvertFrom-LocalSecret $secretPath
      try {
        $result = Test-SipRegisterUdp -Server $packet.server -Port $packet.port -Username $packet.username -Password $password
        $packet.registerCheck = $result
        if (-not $result.ok) { Add-Blocking $blocking "pbx_sip_register_failed" }
      }
      finally {
        $password = $null
      }
    } catch {
      $packet.registerCheck = [ordered]@{
        requested = $true
        attempted = $true
        ok = $false
        errorType = $_.Exception.GetType().Name
      }
      Add-Blocking $blocking "pbx_sip_register_exception"
    }
  }
}

$packet.readyForRegistrationTest = [bool]($packet.configFound -and $packet.tcpPortOpen -and $packet.secretStored)
$sidecarProc = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*sip-sidecar.mjs*" })
$packet.sipSidecarRunning = $sidecarProc.Count -gt 0
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$SidecarHealthPort/health" -TimeoutSec 3
  $packet.sipSidecarHealth = $health
} catch {
  $packet.sipSidecarHealth = $null
}

$sidecarOk = [bool]($packet.sipSidecarSupported -and $packet.sipSidecarScriptFound -and $packet.sipSidecarRunning -and $packet.sipSidecarHealth -and $packet.sipSidecarHealth.status -eq "ok")
$packet.readyForLiveAnswer = [bool]($packet.readyForRegistrationTest -and $sidecarOk -and $packet.liveAnswerEnabled)
if (-not $packet.sipSidecarSupported) { Add-Blocking $blocking "sip_sidecar_not_configured" }
if (-not $packet.sipSidecarScriptFound) { Add-Blocking $blocking "sip_sidecar_script_missing" }
if (-not $packet.sipSidecarRunning) { Add-Blocking $blocking "sip_sidecar_not_running" }
if ($packet.sipSidecarRunning -and -not $sidecarOk) { Add-Blocking $blocking "sip_sidecar_health_blocked" }
if (-not $packet.liveAnswerEnabled) { Add-Blocking $blocking "pbx_live_answer_not_enabled" }

$packet.blocking = @($blocking)
$packet | ConvertTo-Json -Depth 8
