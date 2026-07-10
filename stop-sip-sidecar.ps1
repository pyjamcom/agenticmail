$ErrorActionPreference = "Stop"

$stopped = 0
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -like "*sip-sidecar.mjs*" } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force
      $stopped += 1
    } catch {}
  }

[pscustomobject]@{
  status = "ok"
  stopped = $stopped
} | ConvertTo-Json
