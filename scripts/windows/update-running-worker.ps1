<#
.SYNOPSIS
  Bring an ALREADY RUNNING worker onto the code this checkout now holds.

.DESCRIPTION
  Run explicitly after updating the checkout to bring a live worker onto the new
  code. The normal launcher leaves a running worker alone. On 2026-09-22
  windows-pc was still running the 2026-09-19 bundle after a pull; this script
  provides a deliberate way to rebuild and restart the worker child.

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
  and the operator can retry after work finishes. Killing it would take live
  agent sessions down with it.

  Exit codes: 0 up to date / restarted / dry run with no pending obstacle,
  1 build failed or bundle missing, 2 could not inspect processes,
  3 restart still needed (busy, unsupervised, or stop failed). A deferred
  restart must be retried manually after the worker becomes idle.

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

function Get-WorkerState {
  param([object[]]$Processes)
  # Same matching rule as start-worker.bat's live check: this checkout's
  # absolute entrypoint path, native-host helpers excluded.
  $workers = @($Processes | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($bundle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine.IndexOf('native-host', [StringComparison]::OrdinalIgnoreCase) -lt 0
  })
  # A supervisor may use the relative entrypoint. Its child relationship is
  # checked before stopping a worker; the flag alone is not enough.
  $supervisorIds = @($Processes | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf('--supervise', [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | ForEach-Object { $_.ProcessId })
  $children = @($workers | Where-Object {
    $_.CommandLine.IndexOf('--supervise', [StringComparison]::OrdinalIgnoreCase) -lt 0
  })
  return @{ Children = $children; SupervisorIds = $supervisorIds }
}

function Get-Descendants {
  param([uint32]$RootId, [object[]]$Processes)
  $found = New-Object System.Collections.Generic.List[object]
  $frontier = @($RootId)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($id in $frontier) {
      foreach ($p in @($Processes | Where-Object { $_.ParentProcessId -eq $id -and $_.ProcessId -ne $id })) {
        $found.Add($p)
        if ($idleHelperNames -notcontains $p.Name) { $next += $p.ProcessId }
      }
    }
    $frontier = $next
  }
  return $found
}

try {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
  Write-Host "Could not list processes, leaving the worker alone: $($_.Exception.Message)"
  exit 2
}
$state = Get-WorkerState -Processes $all
$children = @($state.Children)
$preBuildChildren = @($children | ForEach-Object { "$($_.ProcessId):$($_.CreationDate.Ticks)" })

if ($children.Count -eq 0) {
  Write-Host 'No running worker child found for this checkout; nothing to update.'
  exit 0
}
foreach ($child in $children) {
  if ($state.SupervisorIds -notcontains $child.ParentProcessId) {
    Write-Host "Worker pid $($child.ProcessId) is not supervised; use restart-worker.bat in a maintenance window. No build was run."
    exit 3
  }
  $busy = @(Get-Descendants -RootId $child.ProcessId -Processes $all |
    Where-Object { $idleHelperNames -notcontains $_.Name })
  if ($busy.Count -gt 0 -and -not $Force) {
    $names = ($busy | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ', '
    Write-Host "Worker pid $($child.ProcessId) is busy ($names); no build was run. Retry after it is idle."
    exit 3
  }
}

# --- 1. rebuild when HEAD has moved past the built commit ----------------------
$head = Get-HeadCommit
$stamp = Get-StampCommit
$bundleExists = Test-Path -LiteralPath $bundle -PathType Leaf
$rebuildNeeded = $head -and ($head -ne $stamp -or -not $bundleExists)
$rebuilt = $false
if (-not $head) {
  Write-Host 'Could not read HEAD (is git on PATH?); skipping the rebuild check.'
} elseif ($rebuildNeeded) {
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
    if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) {
      Write-Host "Build reported success but bundle is missing at $bundle. The running worker was left untouched."
      exit 1
    }
    Set-Content -LiteralPath $stampPath -Value $head -Encoding ASCII
    $rebuilt = $true
  }
}

# --- 2. restart any child older than the bundle -------------------------------
if (-not (Test-Path -LiteralPath $bundle -PathType Leaf) -and -not ($DryRun -and $rebuildNeeded)) {
  Write-Host "Bundle not found at $bundle; the worker cannot be brought onto this checkout."
  exit 1
}
$builtAt = if (Test-Path -LiteralPath $bundle -PathType Leaf) {
  (Get-Item -LiteralPath $bundle).LastWriteTime
} else {
  $null # A dry run projects the rebuild that would create this bundle.
}
# A build can take a minute or more. A worker may have restarted or begun work
# during that time, so discard the process snapshot taken before the build.
try {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
  Write-Host "Could not refresh processes after the build; retry the update: $($_.Exception.Message)"
  exit 2
}
$state = Get-WorkerState -Processes $all
$children = @($state.Children)
if ($children.Count -eq 0) {
  Write-Host 'No running worker child remains after the build; verify the supervisor and retry.'
  exit 3
}
# A child that survived the rebuild is stale even if timestamps were preserved.
# A replacement child that started after the new bundle was written is current.
# Dry-run projects a future rebuild, so every current child would need review.
$stale = @(if ($DryRun -and $rebuildNeeded) {
  $children
} else {
  $children | Where-Object {
    ($rebuilt -and $preBuildChildren -contains "$($_.ProcessId):$($_.CreationDate.Ticks)") -or
    $_.CreationDate -lt $builtAt
  }
})
if ($stale.Count -eq 0) {
  Write-Host 'Worker is already running the current bundle.'
  exit 0
}

$restartPending = $false
foreach ($child in $stale) {
  # Recheck immediately before a stop. A newly started provider CLI must block
  # the restart, and PID plus creation time prevents acting on a recycled PID.
  try {
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    Write-Host "Could not refresh processes before stopping worker pid $($child.ProcessId): $($_.Exception.Message)"
    $restartPending = $true
    continue
  }
  $state = Get-WorkerState -Processes $all
  $current = @($state.Children | Where-Object {
    $_.ProcessId -eq $child.ProcessId -and $_.CreationDate -eq $child.CreationDate
  }) | Select-Object -First 1
  if (-not $current) {
    Write-Host "Worker pid $($child.ProcessId) changed while checking; verify the new child and retry."
    $restartPending = $true
    continue
  }
  $child = $current
  $bundleState = if ($DryRun -and $rebuildNeeded) { 'bundle would be rebuilt' } else { "bundle built $builtAt" }
  $label = "worker pid $($child.ProcessId) (started $($child.CreationDate), $bundleState)"
  if ($state.SupervisorIds -notcontains $child.ParentProcessId) {
    Write-Host "$label is NOT supervised, so stopping it would leave the node offline."
    Write-Host '  Restart it by hand (scripts\windows\restart-worker.bat) to pick up the new code.'
    $restartPending = $true
    continue
  }
  $busy = @(Get-Descendants -RootId $child.ProcessId -Processes $all |
    Where-Object { $idleHelperNames -notcontains $_.Name })
  if ($busy.Count -gt 0 -and -not $Force) {
    $names = ($busy | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ', '
    Write-Host "$label is busy ($names); rerun this command after the worker is idle."
    $restartPending = $true
    continue
  }
  if ($DryRun) {
    Write-Host "$label would be restarted onto the new bundle (dry run)."
    continue
  }
  try {
    Stop-Process -Id $child.ProcessId -Force -ErrorAction Stop
  } catch {
    Write-Host "Could not stop $label : $($_.Exception.Message)"
    $restartPending = $true
    continue
  }
  # Stop-Process is asynchronous. Do not report success until the original
  # process is gone and this supervisor has created a replacement child.
  $deadline = (Get-Date).AddSeconds(30)
  $replacement = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
      $after = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    } catch {
      continue
    }
    $afterState = Get-WorkerState -Processes $after
    $oldAlive = @($afterState.Children | Where-Object {
      $_.ProcessId -eq $child.ProcessId -and $_.CreationDate -eq $child.CreationDate
    }).Count -gt 0
    $replacement = @($afterState.Children | Where-Object {
      $_.ParentProcessId -eq $child.ParentProcessId -and
      $_.CreationDate -gt $child.CreationDate
    }) | Select-Object -First 1
    if (-not $oldAlive -and $replacement) { break }
    $replacement = $null
  }
  if ($replacement) {
    Write-Host "$label stopped; supervisor started replacement pid $($replacement.ProcessId)."
  } else {
    Write-Host "Could not confirm a replacement for $label within 30 seconds; check the supervisor and retry."
    $restartPending = $true
  }
}
if ($restartPending) { exit 3 }
exit 0
