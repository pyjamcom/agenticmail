$ErrorActionPreference = 'Stop'

function Stop-MatchingProcess {
  param(
    [string] $ProcessName,
    [string] $Pattern
  )
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -ieq $ProcessName `
        -and $_.CommandLine -like $Pattern `
        -and $_.CommandLine -notlike '*Stop-MatchingProcess*'
    } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host "Stopped process $($_.ProcessId)"
      } catch {}
    }
}

Stop-MatchingProcess -ProcessName 'node.exe' -Pattern '*packages/api/dist/index.js*'
Stop-MatchingProcess -ProcessName 'stalwart.exe' -Pattern '*stalwart.exe*--config*'
Write-Host 'AgenticMail local deployment stopped.'
