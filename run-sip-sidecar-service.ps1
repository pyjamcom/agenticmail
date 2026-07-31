param([string]$ServiceProfile = $env:AGENTICMAIL_SERVICE_PROFILE)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoRoot "windows-service-common.ps1")
$ServiceProfile = Set-AgenticMailServiceEnvironment $ServiceProfile
$null = Write-AgenticMailServiceIdentity -Role "sip" -ServiceProfile $ServiceProfile
$NodeExe = "C:\codex_tools\node-v22.23.1-win-x64\node.exe"
$ScriptPath = Join-Path $RepoRoot "sip-sidecar\sip-sidecar.mjs"
$PbxConfig = Join-Path $env:AGENTICMAIL_DATA_DIR "pbx199.local.json"
$AgenticMailConfig = Join-Path $env:AGENTICMAIL_DATA_DIR "config.json"
$LogDir = Join-Path $env:AGENTICMAIL_DATA_DIR "logs"
$TnvedRoot = Join-Path (Split-Path -Parent $RepoRoot) "TNVED"
$TnvedStartScript = Join-Path $TnvedRoot "run_tnved_api_service.ps1"
$TnvedDatabase = "C:\ProgramData\NevskyBroker\TNVED\ved_info_runtime.sqlite"
$TnvedPython = "C:\Program Files\Python314\python.exe"
$TnvedHealthUri = "http://127.0.0.1:8111/tnved/health"

$env:SIP_SIDECAR_HTTP_PORT = "3899"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location -LiteralPath $RepoRoot
$stdoutLog = Join-Path $LogDir "sip.service.stdout.log"
$stderrLog = Join-Path $LogDir "sip.service.stderr.log"
$PbxRuntimeConfig = Get-Content -LiteralPath $PbxConfig -Raw | ConvertFrom-Json
$SignalingPort = [int]$PbxRuntimeConfig.signalingPort
if ($SignalingPort -le 0) { $SignalingPort = 5060 }

try {
  $existingHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$($env:SIP_SIDECAR_HTTP_PORT)/health" -TimeoutSec 3 -ErrorAction Stop
  if ([int]$existingHealth.activeCalls -gt 0) {
    throw "Existing SIP sidecar has an active call; refusing to replace it."
  }
} catch {
  if ($_.Exception.Message -like "*active call*") { throw }
}

Get-NetUDPEndpoint -LocalPort $SignalingPort -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  Where-Object { $_ -and $_ -ne $PID } |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort $([int]$env:SIP_SIDECAR_HTTP_PORT),8111 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  Where-Object { $_ -and $_ -ne $PID } |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

Get-CimInstance Win32_Process | Where-Object {
  $_.Name -like "python*.exe" -and
  $_.CommandLine -like "*tnved_api_server.py*" -and
  $_.CommandLine -like "*--port 8111*"
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$tnvedArguments = @(
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy", "Bypass",
  "-WindowStyle", "Hidden",
  "-File", ('"{0}"' -f $TnvedStartScript),
  "-DatabasePath", ('"{0}"' -f $TnvedDatabase),
  "-BindHost", "127.0.0.1",
  "-Port", "8111",
  "-PythonPath", ('"{0}"' -f $TnvedPython)
) -join " "
$tnvedProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $tnvedArguments -WindowStyle Hidden -PassThru

try {
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $tnvedReady = $false
  do {
    Start-Sleep -Seconds 1
    try {
      $tnvedHealth = Invoke-RestMethod -Uri $TnvedHealthUri -TimeoutSec 5 -ErrorAction Stop
      $tnvedReady = $tnvedHealth.status -eq "ok" -and $tnvedHealth.preflight.ok -eq $true
    } catch {
      $tnvedReady = $false
    }
  } while (-not $tnvedReady -and [DateTime]::UtcNow -lt $deadline)
  if (-not $tnvedReady) {
    throw "TNVED API did not become ready on port 8111"
  }

  $arguments = @($ScriptPath, "--config", $PbxConfig, "--agenticmailConfig", $AgenticMailConfig)
  $process = Start-Process -FilePath $NodeExe -ArgumentList $arguments -WorkingDirectory $RepoRoot -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -Wait -PassThru
  exit $process.ExitCode
} finally {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -like "python*.exe" -and
    $_.CommandLine -like "*tnved_api_server.py*" -and
    $_.CommandLine -like "*--port 8111*"
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($tnvedProcess -and -not $tnvedProcess.HasExited) {
    Stop-Process -Id $tnvedProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
