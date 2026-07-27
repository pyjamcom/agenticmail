[CmdletBinding()]
param(
  [string]$ComputerName = "10.1.0.18",
  [string]$CredentialPath = "X:\Paul\10.1.0.18.txt",
  [string]$RemoteAgenticMailRoot = "C:\codex_tools\agenticmail",
  [string]$RemoteServiceProfile = "C:\Users\pavel",
  [string]$TnvedApiBase = "http://10.0.200.101:8100",
  [string]$TaskName = "AgenticMail-SIP-Sidecar-Service"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (!(Test-Path -LiteralPath $CredentialPath)) {
  throw "Credential file was not found: $CredentialPath"
}

$lines = Get-Content -LiteralPath $CredentialPath
$login = (($lines | Where-Object { $_ -match "^log:" }) -replace "^log:\s*", "").Trim()
$password = (($lines | Where-Object { $_ -match "^pass:" }) -replace "^pass:\s*", "").Trim()
if ([string]::IsNullOrWhiteSpace($login) -or [string]::IsNullOrWhiteSpace($password)) {
  throw "Credential file must contain log: and pass: entries"
}

$secure = ConvertTo-SecureString $password -AsPlainText -Force
$credential = [pscredential]::new($login, $secure)
$session = $null

try {
  $session = New-PSSession `
    -ComputerName $ComputerName `
    -Credential $credential `
    -Authentication Negotiate

  $remoteSidecar = Join-Path $RemoteAgenticMailRoot "sip-sidecar"
  $remoteConfig = Join-Path $RemoteServiceProfile ".agenticmail\pbx199.local.json"
  $stamp = Get-Date -Format "yyyyMMdd_HHmmss"

  Invoke-Command -Session $session -ScriptBlock {
    param($SidecarDir, $ConfigPath, $Stamp)
    $ErrorActionPreference = "Stop"
    if (!(Test-Path -LiteralPath $SidecarDir)) {
      throw "Remote sidecar directory was not found: $SidecarDir"
    }
    if (!(Test-Path -LiteralPath $ConfigPath)) {
      throw "Remote PBX config was not found: $ConfigPath"
    }
    foreach ($name in @("sip-sidecar.mjs", "sales-call-scenario.json", "README.md", "nbr-service-rates.json")) {
      $path = Join-Path $SidecarDir $name
      if (Test-Path -LiteralPath $path) {
        Copy-Item -LiteralPath $path -Destination "$path.tnved-$Stamp.bak" -Force
      }
    }
    Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.tnved-$Stamp.bak" -Force
  } -ArgumentList $remoteSidecar, $remoteConfig, $stamp

  foreach ($name in @("sip-sidecar.mjs", "sales-call-scenario.json", "README.md", "nbr-service-rates.json")) {
    Copy-Item `
      -LiteralPath (Join-Path $PSScriptRoot "sip-sidecar\$name") `
      -Destination (Join-Path $remoteSidecar $name) `
      -ToSession $session `
      -Force
  }

  $result = Invoke-Command -Session $session -ScriptBlock {
    param($ConfigPath, $ApiBase, $ServiceTask, $SidecarDir)
    $ErrorActionPreference = "Stop"
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $config | Add-Member -NotePropertyName tnvedApiBase -NotePropertyValue $ApiBase.TrimEnd("/") -Force
    $config | Add-Member -NotePropertyName tnvedConsultationEnabled -NotePropertyValue $true -Force
    $config | Add-Member -NotePropertyName vehicleCustomsEnabled -NotePropertyValue $true -Force
    $config | Add-Member -NotePropertyName nbrServiceRatesPath -NotePropertyValue (Join-Path $SidecarDir "nbr-service-rates.json") -Force
    $json = $config | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($ConfigPath, $json, [Text.UTF8Encoding]::new($false))

    $task = Get-ScheduledTask -TaskName $ServiceTask -ErrorAction Stop
    if ([string]$task.Principal.UserId -notin @("SYSTEM", "NT AUTHORITY\SYSTEM", "S-1-5-18")) {
      throw "SIP sidecar task is not configured for SYSTEM"
    }

    $tnvedHealth = Invoke-RestMethod -Uri "$($ApiBase.TrimEnd('/'))/tnved/health" -TimeoutSec 15
    if ($tnvedHealth.status -ne "ok" -or $tnvedHealth.preflight.ok -ne $true) {
      throw "TNVED API health is not ok from the voice host"
    }
    if ($tnvedHealth.vehicle_customs.ready -ne $true) {
      throw "Vehicle customs calculator is not ready on the TNVED API"
    }

    Stop-ScheduledTask -TaskName $ServiceTask -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $ServiceTask

    $sidecarHealth = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      Start-Sleep -Seconds 2
      try {
        $sidecarHealth = Invoke-RestMethod -Uri "http://127.0.0.1:3899/health" -TimeoutSec 5
        if ($sidecarHealth.status -eq "ok") { break }
      } catch {}
    }
    if ($null -eq $sidecarHealth -or $sidecarHealth.status -ne "ok") {
      throw "SIP sidecar did not return healthy after restart"
    }
    if ($sidecarHealth.tnvedConsultation.bodyEncoding -ne "masked-gzip-base64-v1") {
      throw "TNVED request transport is not configured for masked-gzip-base64-v1"
    }
    if ($sidecarHealth.vehicleCustomsCalculation.enabled -ne $true) {
      throw "Vehicle customs calculation is not enabled"
    }

    [ordered]@{
      computer = $env:COMPUTERNAME
      task = $ServiceTask
      task_user = [string]$task.Principal.UserId
      sidecar_status = [string]$sidecarHealth.status
      registered = [bool]$sidecarHealth.registered
      tnved_enabled = [bool]$sidecarHealth.tnvedConsultation.enabled
      tnved_body_encoding = [string]$sidecarHealth.tnvedConsultation.bodyEncoding
      vehicle_customs_enabled = [bool]$sidecarHealth.vehicleCustomsCalculation.enabled
      tnved_api = [string]$sidecarHealth.tnvedConsultation.apiBase
      tnved_kb = [string]$tnvedHealth.preflight.kb_version
      tnved_noise_ratio = [double]$tnvedHealth.preflight.retrieval_noise_ratio
    }
  } -ArgumentList $remoteConfig, $TnvedApiBase, $TaskName, $remoteSidecar

  $result | ConvertTo-Json -Depth 8
}
finally {
  if ($null -ne $session) {
    Remove-PSSession $session
  }
  $password = $null
  $secure = $null
  $credential = $null
}
