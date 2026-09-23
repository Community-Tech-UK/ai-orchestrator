<#
.SYNOPSIS
  Bring an ALREADY RUNNING worker onto the code this checkout now holds.

.DESCRIPTION
  Called by start-worker.bat when it finds a live worker for this checkout, right
  after start-worker-autoupdate.bat has run `git pull`. Before this existed the
  launcher simply exited there, so a pull landed new code on disk and the running
  worker kept serving the old build indefinitely (on 2026-09-22 windows-pc was
  still running the 2026-09-19 bundle, and fixes merged since were not live).

  Two independent questions, because they fail independently:

    1. Is the bundle stale? dist\worker-agent\.source-commit records the commit a
       bundle was built from. If HEAD has moved on, rebuild. A missing stamp means
       "unknown", which also rebuilds - once.
    2. Is the PROCESS stale? A worker child that started before the bundle was
       last written is still running older code from memory, whether or not a
       rebuild happened just now (see restart-worker.bat's history). Restart it.

  The restart stops the worker CHILD only. Its supervisor (worker-supervisor.ts)
  respawns it from the new bundle about a second later, so the node blips rather
  than going offline. An unsupervised worker has nothing to bring it back, so it
  is never killed; the script says so instead.

  A worker that is doing something - it has descendant processes other than known
  long-lived helpers, i.e. a provider CLI, a terminal, a build - is left alone
  and the restart is retried on the next scheduled run. Killing it would take
  live agent sessions down with it.

  Exit codes: 0 up to date / restarted / deferred, 1 build failed (the running
  worker is untouched), 2 could not inspect processes.

  Keep this file pure ASCII.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,

  # Report what would happen without building or stopping anything.
  [switch]$DryRun,

  # Restart even if the worker has busy descendants.
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path.TrimEnd('\')
$bundle = Join-Path $RepoPath 'dist\worker-agent\index.js'
$stampPath = Join-Path $RepoPath 'dist\worker-agent\.source-commit'

# Descendants a healthy idle worker legitimately keeps around. Anything else
# (a provider CLI such as agy.exe or claude.exe, node.exe, cmd.exe for a
# terminal session) means work is live.
#
# The walk does not descend INTO these helpers. Measured on windows-pc
# 2026-09-22: the worker's managed Chrome runs ~50 chrome.exe processes, and
# Chrome's native-messaging hosts (cmd.exe -> node.exe native-host) hang off
# them, so walking through Chrome would call every idle worker busy forever.
$idleHelperNames = @('conhost.exe', 'chrome.exe', 'adb.exe', 'crashpad_handler.exe', 'WerFault.exe')

function Get-HeadCommit {
  try {
    $head = (& git -C $RepoPath rev-parse HEAD 2>$null)
  } catch {
    return $null # git not on PATH
  }
  if ($LASTEXITCODE -ne 0 -or -not $head) { return $null }
  return ([string]$head).Trim()
}

function Get-StampCommit {
  if (-not (Test-Path -LiteralPath $stampPath -PathType Leaf)) { return $null }
  $value = (Get-Content -LiteralPath $stampPath -TotalCount 1 -ErrorAction SilentlyContinue)
  if (-not $value) { return $null }
  return ([string]$value).Trim()
}

try {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
  Write-Host "Could not list processes, leaving the worker alone: $($_.Exception.Message)"
  exit 2
}

# Same matching rule as start-worker.bat's live check: this checkout's absolute
# entrypoint path, native-host helpers excluded.
$workers = @($all | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and
  $_.CommandLine.IndexOf($bundle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine.IndexOf('native-host', [StringComparison]::OrdinalIgnoreCase) -lt 0
})
# The supervisor's command line may use the RELATIVE entrypoint
# (`node dist/worker-agent/index.js --supervise`), so identify it by the flag and
# by being a worker child's parent, not by the absolute path.
$supervisorIds = @($all | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and
  $_.CommandLine.IndexOf('--supervise', [StringComparison]::OrdinalIgnoreCase) -ge 0
} | ForEach-Object { $_.ProcessId })
$children = @($workers | Where-Object {
  $_.CommandLine.IndexOf('--supervise', [StringComparison]::OrdinalIgnoreCase) -lt 0
})

if ($children.Count -eq 0) {
  Write-Host 'No running worker child found for this checkout; nothing to update.'
  exit 0
}

# --- 1. rebuild when HEAD has moved past the built commit ----------------------
$head = Get-HeadCommit
$stamp = Get-StampCommit
$rebuilt = $false
if (-not $head) {
  Write-Host 'Could not read HEAD (is git on PATH?); skipping the rebuild check.'
} elseif ($head -ne $stamp) {
  $from = if ($stamp) { $stamp.Substring(0, [Math]::Min(8, $stamp.Length)) } else { 'unknown' }
  Write-Host "Bundle was built from $from, checkout is at $($head.Substring(0, 8)); rebuilding."
  if ($DryRun) {
    Write-Host '  (dry run: not building)'
  } else {
    Push-Location -LiteralPath $RepoPath
    try {
      & cmd.exe /c 'npx tsx build-worker-agent.ts'
      $buildRc = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($buildRc -ne 0) {
      Write-Host "Build failed (exit $buildRc). The running worker was left untouched."
      exit 1
    }
    Set-Content -LiteralPath $stampPath -Value $head -Encoding ASCII
    $rebuilt = $true
  }
}

# --- 2. restart any child older than the bundle -------------------------------
if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) {
  Write-Host "Bundle not found at $bundle; leaving the worker alone."
  exit 0
}
$builtAt = (Get-Item -LiteralPath $bundle).LastWriteTime
# After a rebuild every running child is on old code by definition; do not lean
# on timestamps for that (a copy that preserves mtime, or clock skew, would hide
# it). Otherwise compare start time against the bundle's last write.
$stale = @(if ($rebuilt) { $children } else { $children | Where-Object { $_.CreationDate -lt $builtAt } })
if ($stale.Count -eq 0) {
  Write-Host 'Worker is already running the current bundle.'
  exit 0
}

function Get-Descendants {
  param([uint32]$RootId)
  $found = New-Object System.Collections.Generic.List[object]
  $frontier = @($RootId)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($id in $frontier) {
      foreach ($p in @($all | Where-Object { $_.ParentProcessId -eq $id -and $_.ProcessId -ne $id })) {
        $found.Add($p)
        if ($idleHelperNames -notcontains $p.Name) { $next += $p.ProcessId }
      }
    }
    $frontier = $next
  }
  return $found
}

foreach ($child in $stale) {
  $label = "worker pid $($child.ProcessId) (started $($child.CreationDate), bundle built $builtAt)"
  if ($supervisorIds -notcontains $child.ParentProcessId) {
    Write-Host "$label is NOT supervised, so stopping it would leave the node offline."
    Write-Host '  Restart it by hand (scripts\windows\restart-worker.bat) to pick up the new code.'
    continue
  }
  $busy = @(Get-Descendants -RootId $child.ProcessId | Where-Object { $idleHelperNames -notcontains $_.Name })
  if ($busy.Count -gt 0 -and -not $Force) {
    $names = ($busy | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ', '
    Write-Host "$label is busy ($names); restart deferred to the next scheduled run."
    continue
  }
  if ($DryRun) {
    Write-Host "$label would be restarted onto the new bundle (dry run)."
    continue
  }
  try {
    Stop-Process -Id $child.ProcessId -Force -ErrorAction Stop
    Write-Host "$label stopped; its supervisor will start it on the new bundle."
  } catch {
    Write-Host "Could not stop $label : $($_.Exception.Message)"
  }
}
exit 0
