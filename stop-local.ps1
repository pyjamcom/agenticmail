$ErrorActionPreference = 'Stop'

function Stop-MatchingProcess {
  param([string] $Pattern)
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like $Pattern -and $_.CommandLine -notlike '*Stop-MatchingProcess*' } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host "Stopped process $($_.ProcessId)"
      } catch {}
    }
}

Stop-MatchingProcess '*packages/api/dist/index.js*'
Stop-MatchingProcess '*stalwart.exe*--config*'
Write-Host 'AgenticMail local deployment stopped.'
