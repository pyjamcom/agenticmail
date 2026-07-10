function Get-LocalJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [int]$TimeoutSeconds = 5
  )

  $curl = (Get-Command curl.exe -ErrorAction Stop).Source
  $arguments = @(
    "--noproxy"
    "*"
    "--fail"
    "--silent"
    "--show-error"
    "--max-time"
    [string]$TimeoutSeconds
    $Uri
  )
  $raw = & $curl @arguments 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    throw "Local HTTP health request failed: $Uri"
  }
  return (($raw -join [Environment]::NewLine) | ConvertFrom-Json)
}
