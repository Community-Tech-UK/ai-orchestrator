[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$HubPath,

  [ValidateSet('scan', 'seed-from-local', 'seed-to-local', 'pull', 'push', 'run')]
  [string]$Mode = 'run',

  [string]$UserDataRoot = '',

  [string]$HarnessExe = '',

  [string]$MachineName = $env:COMPUTERNAME,

  [int]$StaleLockHours = 18,

  [switch]$Force,

  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$durableDirs = @(
  'rlm',
  'conversation-history',
  'conversation-ledger',
  'session-continuity',
  'projects',
  'transaction-logs',
  'archived-sessions',
  'content-store',
  'output-storage',
  'child-results',
  'snapshots',
  'operator',
  'loop-mode'
)

$durableFiles = @(
  'loop-learnings.json'
)

$projectMirrorExcludeDirs = @('shadow-repo')

function Resolve-UserDataRoot {
  param([string]$RequestedRoot)
  if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
    return $RequestedRoot
  }

  $candidates = @(
    (Join-Path $env:APPDATA 'harness'),
    (Join-Path $env:APPDATA 'harness-dev'),
    (Join-Path $env:APPDATA 'Harness')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Container) {
      return $candidate
    }
  }

  return (Join-Path $env:APPDATA 'harness')
}

function Resolve-HarnessExe {
  param([string]$RequestedExe)
  if (-not [string]::IsNullOrWhiteSpace($RequestedExe)) {
    if (-not (Test-Path -LiteralPath $RequestedExe -PathType Leaf)) {
      throw "HarnessExe does not exist: $RequestedExe"
    }
    return $RequestedExe
  }

  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Harness\Harness.exe'),
    (Join-Path $env:ProgramFiles 'Harness\Harness.exe')
  )
  if (-not [string]::IsNullOrWhiteSpace($pf86)) {
    $candidates += (Join-Path $pf86 'Harness\Harness.exe')
  }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }

  throw 'Could not locate Harness.exe. Pass -HarnessExe explicitly.'
}

function Assert-NotOneDrivePath {
  param([string]$PathValue, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return
  }

  $normalized = $PathValue -replace '/', '\'
  if ($normalized -match '(?i)(^|\\)OneDrive(?:\s+-\s+[^\\]+)?($|\\)') {
    throw "$Label must not be under OneDrive: $PathValue"
  }
}

function Assert-HarnessClosed {
  $running = @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessName -eq 'Harness' -or $_.ProcessName -eq 'harness' }
  )
  if ($running.Count -gt 0) {
    $pids = ($running | ForEach-Object { $_.Id }) -join ', '
    throw "Harness is still running (PID $pids). Close it before syncing."
  }
}

function Acquire-SyncLock {
  param([string]$Root)
  if (-not (Test-Path -LiteralPath $Root)) {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
  }

  $lock = Join-Path $Root 'sync.lock'
  if (Test-Path -LiteralPath $lock) {
    $age = (Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime
    $text = Get-Content -LiteralPath $lock -Raw
    if (-not $Force) {
      throw "Sync lock is already held at $lock. Contents:`n$text`nUse -Force only after confirming the other machine is closed. Lock age: $([math]::Round($age.TotalHours, 2)) hours."
    }
    if ($age.TotalHours -lt $StaleLockHours) {
      Write-Warning "Forcing a lock newer than $StaleLockHours hours."
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Move-Item -LiteralPath $lock -Destination "$lock.forced-$stamp" -Force
  }

  $lines = @(
    "HELD-BY $MachineName",
    "PID $PID",
    "USER $env:USERNAME",
    "UTC $((Get-Date).ToUniversalTime().ToString('o'))"
  )
  try {
    New-Item -ItemType File -Path $lock -Value ($lines -join [Environment]::NewLine) -ErrorAction Stop | Out-Null
  } catch {
    throw "Could not acquire sync lock at $lock. Another launcher may have created it first. $($_.Exception.Message)"
  }
  return $lock
}

function Release-SyncLock {
  param([string]$LockPath)
  if (-not [string]::IsNullOrWhiteSpace($LockPath) -and (Test-Path -LiteralPath $LockPath)) {
    Remove-Item -LiteralPath $LockPath -Force
  }
}

function Assert-HubReady {
  param([string]$Root)
  $marker = Join-Path $Root 'STATE-READY.txt'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    throw "Hub is not seeded. Run -Mode seed-from-local on the source machine first: $marker"
  }
}

function Invoke-RobocopyMirror {
  param([string]$Source, [string]$Destination, [string[]]$ExcludeDirs = @())
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  }

  $args = @($Source, $Destination, '/MIR', '/R:2', '/W:2', '/FFT', '/Z')
  if ($ExcludeDirs.Count -gt 0) {
    $args += '/XD'
    $args += $ExcludeDirs
  }
  if ($DryRun) {
    $args += '/L'
  }

  Write-Host "robocopy $Source -> $Destination"
  & robocopy @args | Out-Host
  $code = $LASTEXITCODE
  if ($code -ge 8) {
    throw "robocopy failed with exit code $code for $Source -> $Destination"
  }
}

function Copy-DurableFile {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    Write-Host "skip missing file $Source"
    return
  }

  $parent = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  if ($DryRun) {
    Write-Host "copy $Source -> $Destination"
    return
  }

  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Remove-ProjectShadowRepos {
  param([string]$ProjectsRoot)
  if (-not (Test-Path -LiteralPath $ProjectsRoot -PathType Container)) {
    return
  }

  $shadowRepos = @(
    Get-ChildItem -LiteralPath $ProjectsRoot -Directory -Recurse -Filter 'shadow-repo' -ErrorAction SilentlyContinue |
      Where-Object { ($_.FullName -replace '/', '\') -match '\\checkpoints\\shadow-repo$' } |
      Sort-Object { $_.FullName.Length } -Descending
  )
  foreach ($repo in $shadowRepos) {
    if ($DryRun) {
      Write-Host "remove stale shadow repo $($repo.FullName)"
      continue
    }
    Remove-Item -LiteralPath $repo.FullName -Recurse -Force
  }
}

function Sync-DurableState {
  param([ValidateSet('pull', 'push')][string]$Direction, [string]$LocalRoot, [string]$HubRoot)

  $sourceRoot = if ($Direction -eq 'pull') { $HubRoot } else { $LocalRoot }
  $destRoot = if ($Direction -eq 'pull') { $LocalRoot } else { $HubRoot }

  foreach ($dir in $durableDirs) {
    $source = Join-Path $sourceRoot $dir
    $dest = Join-Path $destRoot $dir
    if (Test-Path -LiteralPath $source -PathType Container) {
      $excludeDirs = if ($dir -eq 'projects') { $projectMirrorExcludeDirs } else { @() }
      Invoke-RobocopyMirror -Source $source -Destination $dest -ExcludeDirs $excludeDirs
      if ($Direction -eq 'push' -and $dir -eq 'projects') {
        Remove-ProjectShadowRepos -ProjectsRoot $dest
      }
    } else {
      Write-Host "skip missing directory $source"
    }
  }

  foreach ($file in $durableFiles) {
    Copy-DurableFile -Source (Join-Path $sourceRoot $file) -Destination (Join-Path $destRoot $file)
  }
}

function Mark-HubReady {
  param([string]$Root)
  $marker = Join-Path $Root 'STATE-READY.txt'
  $lines = @(
    "Seeded by $MachineName",
    "UTC $((Get-Date).ToUniversalTime().ToString('o'))",
    "UserDataRoot $script:ResolvedUserDataRoot"
  )
  if (-not $DryRun) {
    Set-Content -LiteralPath $marker -Value $lines -Encoding ASCII
  }
  Write-Host "Hub marker: $marker"
}

function Write-SyncManifest {
  param([string]$Root, [string]$Action)
  $manifest = Join-Path $Root "last-sync-$MachineName.txt"
  $lines = @(
    "ACTION $Action",
    "MACHINE $MachineName",
    "UTC $((Get-Date).ToUniversalTime().ToString('o'))",
    "USERDATA $script:ResolvedUserDataRoot"
  )
  if (-not $DryRun) {
    Set-Content -LiteralPath $manifest -Value $lines -Encoding ASCII
  }
}

function Scan-StateRoot {
  param([string]$Label, [string]$Root)
  Write-Host ''
  Write-Host "--- ${Label}: $Root ---"
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    Write-Host 'missing'
    return
  }

  foreach ($dir in $durableDirs) {
    $path = Join-Path $Root $dir
    Write-Host "$dir exists=$(Test-Path -LiteralPath $path -PathType Container)"
  }
  foreach ($file in $durableFiles) {
    $path = Join-Path $Root $file
    Write-Host "$file exists=$(Test-Path -LiteralPath $path -PathType Leaf)"
  }

  $dbs = @(
    Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
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
  if ($dbs.Count -eq 0) {
    Write-Host 'no database files found'
  } else {
    $dbs | Format-Table -AutoSize | Out-String | Write-Host
  }
}

$resolvedUserData = Resolve-UserDataRoot -RequestedRoot $UserDataRoot
$resolvedHub = $HubPath

Assert-NotOneDrivePath -PathValue $resolvedUserData -Label 'UserDataRoot'
Assert-NotOneDrivePath -PathValue $resolvedHub -Label 'HubPath'

$script:ResolvedUserDataRoot = $resolvedUserData

Write-Host "Mode         = $Mode"
Write-Host "UserDataRoot = $script:ResolvedUserDataRoot"
Write-Host "HubPath      = $resolvedHub"
Write-Host "Machine      = $MachineName"
Write-Host "DryRun       = $($DryRun.IsPresent)"

if ($Mode -eq 'scan') {
  Scan-StateRoot -Label 'local' -Root $script:ResolvedUserDataRoot
  Scan-StateRoot -Label 'hub' -Root $resolvedHub
  exit 0
}

Assert-HarnessClosed
$lockPath = Acquire-SyncLock -Root $resolvedHub
try {
  switch ($Mode) {
    'seed-from-local' {
      Sync-DurableState -Direction 'push' -LocalRoot $script:ResolvedUserDataRoot -HubRoot $resolvedHub
      Mark-HubReady -Root $resolvedHub
      Write-SyncManifest -Root $resolvedHub -Action 'seed-from-local'
    }
    'seed-to-local' {
      Assert-HubReady -Root $resolvedHub
      Sync-DurableState -Direction 'pull' -LocalRoot $script:ResolvedUserDataRoot -HubRoot $resolvedHub
      Write-SyncManifest -Root $resolvedHub -Action 'seed-to-local'
    }
    'pull' {
      Assert-HubReady -Root $resolvedHub
      Sync-DurableState -Direction 'pull' -LocalRoot $script:ResolvedUserDataRoot -HubRoot $resolvedHub
      Write-SyncManifest -Root $resolvedHub -Action 'pull'
    }
    'push' {
      Assert-HubReady -Root $resolvedHub
      Sync-DurableState -Direction 'push' -LocalRoot $script:ResolvedUserDataRoot -HubRoot $resolvedHub
      Write-SyncManifest -Root $resolvedHub -Action 'push'
    }
    'run' {
      Assert-HubReady -Root $resolvedHub
      $resolvedHarnessExe = Resolve-HarnessExe -RequestedExe $HarnessExe
      Sync-DurableState -Direction 'pull' -LocalRoot $script:ResolvedUserDataRoot -HubRoot $resolvedHub
      Write-Host "Starting Harness: $resolvedHarnessExe"
      $proc = Start-Process -FilePath $resolvedHarnessExe -PassThru
      Wait-Process -Id $proc.Id
      Assert-HarnessClosed
      Sync-DurableState -Direction 'push' -LocalRoot $script:ResolvedUserDataRoot -HubRoot $resolvedHub
      Write-SyncManifest -Root $resolvedHub -Action 'run'
    }
  }
} finally {
  Release-SyncLock -LockPath $lockPath
}
