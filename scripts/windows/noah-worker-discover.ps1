[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Section {
  param([Parameter(Mandatory = $true)][string]$Title)
  Write-Host ''
  Write-Host "--- $Title ---"
}

function Write-TableOrNone {
  param([AllowNull()]$Value)
  if ($null -eq $Value) {
    Write-Host 'none'
    return
  }
  $text = $Value | Out-String
  if ([string]::IsNullOrWhiteSpace($text)) {
    Write-Host 'none'
    return
  }
  Write-Host $text.TrimEnd()
}

Write-Host "USER     = $env:USERNAME"
Write-Host "APPDATA  = $env:APPDATA"
Write-Host "PROFILE  = $env:USERPROFILE"
Write-Host "COMPUTER = $env:COMPUTERNAME"

Write-Section 'running worker (node.exe running worker-agent)'
$workers = @(
  Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -like '*worker-agent*' } |
    Select-Object ProcessId, CommandLine
)
Write-TableOrNone ($workers | Format-List)

Write-Section 'Startup folder and VBS contents'
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
Write-Host "Startup folder: $startupDir exists=$(Test-Path -LiteralPath $startupDir)"
if (Test-Path -LiteralPath $startupDir) {
  Write-TableOrNone (Get-ChildItem -LiteralPath $startupDir | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize)
  $launchers = @(Get-ChildItem -LiteralPath $startupDir -Filter *.vbs -File)
  foreach ($launcher in $launchers) {
    Write-Host "== $($launcher.FullName) =="
    Get-Content -LiteralPath $launcher.FullName
  }
}

Write-Section '.orchestrator source VBS'
$src = Join-Path $env:USERPROFILE '.orchestrator\run-worker-hidden.vbs'
if (Test-Path -LiteralPath $src) {
  Write-Host "== $src =="
  Get-Content -LiteralPath $src
} else {
  Write-Host "none at $src"
}

Write-Section 'scheduled tasks that might relaunch a worker'
$tasks = @(
  Get-ScheduledTask |
    Where-Object { $_.TaskName -match 'Harness|worker|orchestrat' } |
    Select-Object TaskName, State
)
Write-TableOrNone ($tasks | Format-Table -AutoSize)

Write-Section 'node.exe location'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Write-Host $node.Source } else { Write-Host 'node not on PATH' }

Write-Section 'Harness userData candidates'
$roots = @(
  (Join-Path $env:APPDATA 'harness'),
  (Join-Path $env:APPDATA 'harness-dev'),
  (Join-Path $env:APPDATA 'Harness')
)
foreach ($root in $roots) {
  Write-Host "$root exists=$(Test-Path -LiteralPath $root)"
  if (Test-Path -LiteralPath $root) {
    Write-TableOrNone (Get-ChildItem -LiteralPath $root -Force | Select-Object Name, Mode, Length, LastWriteTime | Format-Table -AutoSize)
  }
}

Write-Section 'database files under Harness userData candidates (names and sizes only)'
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Write-Host "== $root =="
  $dbs = @(
    Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -like '*.db' -or
        $_.Name -like '*.db-wal' -or
        $_.Name -like '*.db-shm' -or
        $_.Name -like '*.sqlite' -or
        $_.Name -like '*.sqlite-wal' -or
        $_.Name -like '*.sqlite-shm'
      } |
      Select-Object FullName, Length, LastWriteTime
  )
  Write-TableOrNone ($dbs | Format-Table -AutoSize)
}
