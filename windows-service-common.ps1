$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$script:AgenticMailMachineSecretEntropy = [Text.Encoding]::UTF8.GetBytes(
  "AgenticMail.WindowsService.LocalMachine.v1"
)

function Resolve-AgenticMailServiceProfile {
  param([string]$ServiceProfile)

  $candidate = if ($ServiceProfile) { $ServiceProfile } elseif ($env:AGENTICMAIL_SERVICE_PROFILE) {
    $env:AGENTICMAIL_SERVICE_PROFILE
  } else {
    $env:USERPROFILE
  }
  if (-not $candidate) { throw "AgenticMail service profile is required." }
  $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath (Join-Path $resolved ".agenticmail"))) {
    throw "AgenticMail data directory is missing under service profile: $resolved"
  }
  return $resolved
}

function Set-AgenticMailServiceEnvironment {
  param([Parameter(Mandatory = $true)][string]$ServiceProfile)

  $resolved = Resolve-AgenticMailServiceProfile $ServiceProfile
  $env:AGENTICMAIL_SERVICE_PROFILE = $resolved
  $env:AGENTICMAIL_DATA_DIR = Join-Path $resolved ".agenticmail"
  $env:USERPROFILE = $resolved
  $env:HOME = $resolved
  $env:HOMEDRIVE = [IO.Path]::GetPathRoot($resolved).TrimEnd('\')
  $env:HOMEPATH = $resolved.Substring([IO.Path]::GetPathRoot($resolved).Length - 1)
  $env:APPDATA = Join-Path $resolved "AppData\Roaming"
  $env:LOCALAPPDATA = Join-Path $resolved "AppData\Local"
  $env:PYTHONUSERBASE = Join-Path $env:APPDATA "Python"
  $env:PYTHONDONTWRITEBYTECODE = "1"
  return $resolved
}

function Add-AgenticMailPythonPath {
  param([string[]]$AdditionalPaths = @())

  $candidates = @($AdditionalPaths | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
  $pythonRoot = Join-Path $env:APPDATA "Python"
  if (Test-Path -LiteralPath $pythonRoot) {
    $userSite = Get-ChildItem -LiteralPath $pythonRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "Python*" } |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "site-packages" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($userSite) { $candidates += $userSite }
  }
  if ($env:PYTHONPATH) { $candidates += ($env:PYTHONPATH -split [IO.Path]::PathSeparator) }
  $env:PYTHONPATH = (@($candidates | Select-Object -Unique) -join [IO.Path]::PathSeparator)
  return $env:PYTHONPATH
}

function Write-AgenticMailServiceIdentity {
  param(
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][string]$ServiceProfile
  )

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $payload = [ordered]@{
    role = $Role
    identity = $identity.Name
    sid = $identity.User.Value
    isSystem = $identity.User.Value -eq "S-1-5-18"
    serviceProfile = $ServiceProfile
    wrapperPid = $PID
    startedAt = [DateTime]::UtcNow.ToString("o")
  }
  $path = Join-Path $env:AGENTICMAIL_DATA_DIR "logs\$Role.service.identity.json"
  New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
  [IO.File]::WriteAllText($path, ($payload | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  return $path
}

function ConvertFrom-AgenticMailSecretFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  $raw = (Get-Content -LiteralPath $Path -Raw).Trim()
  if ($raw.StartsWith("{")) {
    $payload = $raw | ConvertFrom-Json
    if ($payload.version -ne 1 -or $payload.scope -ne "LocalMachine" -or -not $payload.ciphertext) {
      throw "Unsupported AgenticMail machine secret format: $Path"
    }
    $ciphertext = [Convert]::FromBase64String([string]$payload.ciphertext)
    $clear = [Security.Cryptography.ProtectedData]::Unprotect(
      $ciphertext,
      $script:AgenticMailMachineSecretEntropy,
      [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    try { return [Text.Encoding]::UTF8.GetString($clear) }
    finally { [Array]::Clear($clear, 0, $clear.Length) }
  }

  $secure = $raw | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
}

function Write-AgenticMailMachineSecretFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Secret,
    [string]$OperatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  )

  if (-not $Secret) { throw "Secret cannot be empty." }
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $clear = [Text.Encoding]::UTF8.GetBytes($Secret)
  try {
    $ciphertext = [Security.Cryptography.ProtectedData]::Protect(
      $clear,
      $script:AgenticMailMachineSecretEntropy,
      [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    $payload = [ordered]@{
      version = 1
      provider = "windows_dpapi"
      scope = "LocalMachine"
      entropy = "AgenticMail.WindowsService.LocalMachine.v1"
      ciphertext = [Convert]::ToBase64String($ciphertext)
    }
    [IO.File]::WriteAllText(
      $Path,
      ($payload | ConvertTo-Json -Compress),
      [Text.UTF8Encoding]::new($false)
    )
  } finally {
    [Array]::Clear($clear, 0, $clear.Length)
  }

  & icacls.exe $Path /inheritance:r /grant:r `
    "*${OperatorSid}:F" `
    '*S-1-5-18:F' `
    '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to protect machine secret file ACL: $Path" }
}
