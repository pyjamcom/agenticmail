$ErrorActionPreference = "Stop"
$stopped = 0
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -like 'python*.exe' -and $_.CommandLine -like '*exchange-ews-sidecar.py*' } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force; $stopped++ } catch {}
  }
[pscustomobject]@{ Status = "ok"; Stopped = $stopped } | ConvertTo-Json
