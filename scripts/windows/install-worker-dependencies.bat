@echo off
REM ---------------------------------------------------------------------------
REM Bring a stuck worker onto the latest code when its update needs new
REM dependencies. Double-click it as the account that runs the worker.
REM
REM Source of truth: scripts\windows\install-worker-dependencies.bat
REM
REM WHY THIS EXISTS
REM The worker updates itself when idle (src\worker-agent\worker-self-update.ts),
REM but a worker built before 2026-10-30 never installs dependencies. When an
REM update adds one, its build fails ("Could not resolve ...") and the update is
REM retried and refused every two hours. On 2026-10-30 windows-pc was stuck on
REM 68a187c that way after toml-eslint-parser was added.
REM
REM What it does, in order:
REM   1. stops the scheduled task and the worker (supervisors first, repeated
REM      until none is left), then holds the launcher lock so the task's repeat
REM      trigger cannot start a worker over a half-installed node_modules;
REM   2. fast-forwards the checkout to its upstream branch;
REM   3. runs npm install without rewriting package-lock.json (a changed lockfile
REM      would block every later fast-forward);
REM   4. test-builds the new worker beside the live one and self-checks it, as
REM      the updater does;
REM   5. releases the lock and starts the worker through the scheduled task. The
REM      launcher rebuilds the bundle from the new code on a cold start, and the
REM      new worker tells the browser extension to reload onto that version.
REM If any step before the start fails, the checkout goes back to the commit it
REM was on and the worker is started again on its old code, so the node is never
REM left offline.
REM
REM Same bootstrap as restart-worker.bat: the PowerShell below the marker is read
REM back from disk, so it needs no cmd escaping. Keep this file pure ASCII.
REM ---------------------------------------------------------------------------
setlocal
set "AIO_SELF=%~f0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:AIO_SELF); Invoke-Expression $s.Substring($s.LastIndexOf('#PS_START'))"

set "AIO_RC=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %AIO_RC%

REM LastIndexOf, not IndexOf: the marker name also appears in the bootstrap line
REM above, and the first match would slice the file from there.

#PS_START
$ErrorActionPreference = 'Continue'

$taskName = 'AI Orchestrator Worker'
$updateTaskName = 'AI Orchestrator Worker Update'
$orch = Join-Path $env:USERPROFILE '.orchestrator'
$launcher = Join-Path $orch 'start-worker-autoupdate.bat'
$vbs = Join-Path $orch 'run-worker-hidden.vbs'
# start-worker.bat treats this directory as "a launcher run is in progress" for
# 20 minutes, so holding it keeps the scheduled task from starting a worker.
$launcherLock = Join-Path $orch 'launcher.lock'
# The launcher starts the worker with forward slashes, a manual start with
# backslashes; match both.
$match = 'worker-agent[\\/]index\.js'

function Get-Workers {
    $procs = @()
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
    } catch {
        return @()
    }
    return @($procs | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $match -and
        $_.CommandLine.IndexOf('native-host', [StringComparison]::OrdinalIgnoreCase) -lt 0
    })
}

# The checkout, from the deployed launcher's REPO line. A worker's command line
# is not a reliable source: node is not quoted there, so a path match starting
# at the first drive letter would swallow the node.exe path.
function Get-RepoPath {
    if (-not (Test-Path -LiteralPath $launcher)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $launcher)) {
        $m = [regex]::Match($line, '^\s*set\s+"REPO=(.+)"\s*$')
        if ($m.Success -and $m.Groups[1].Value -ne '__REPO_PATH__') { return $m.Groups[1].Value }
    }
    return $null
}

function Hold-LauncherLock {
    if (-not (Test-Path -LiteralPath $launcherLock)) {
        New-Item -ItemType Directory -Path $launcherLock -Force | Out-Null
    }
    (Get-Item -LiteralPath $launcherLock).LastWriteTime = Get-Date
}

function Start-Worker {
    Remove-Item -LiteralPath $launcherLock -Recurse -Force -ErrorAction SilentlyContinue
    $tasks = $null
    try { $tasks = Get-ScheduledTask -ErrorAction Stop } catch { }
    $task = $tasks | Where-Object { $_.TaskName -eq $taskName } | Select-Object -First 1
    if ($task) {
        try {
            Start-ScheduledTask -InputObject $task -ErrorAction Stop
            Write-Host '      started via scheduled task'
            return $true
        } catch {
            Write-Host ('      scheduled task start failed: {0}' -f $_.Exception.Message)
        }
    }
    if (Test-Path -LiteralPath $vbs) {
        Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') | Out-Null
        Write-Host '      started via run-worker-hidden.vbs'
        return $true
    }
    Write-Host '      *** No launcher found. Start the worker by hand. ***'
    return $false
}

# Put the checkout back and start the worker on the code it had.
function Undo-AndRestart {
    param([string]$why)
    Write-Host ''
    Write-Host ('  *** {0} ***' -f $why)
    Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
    $now = ([string](& git -C $repo rev-parse HEAD 2>$null)).Trim()
    if ($now -ne $oldHead) {
        & git -C $repo reset --keep $oldHead
        if ($LASTEXITCODE -eq 0) {
            Write-Host ('  The checkout was put back on {0}.' -f $oldHead)
        } else {
            Write-Host ('  *** Could not put the checkout back on {0}. Run: git -C "{1}" reset --keep {0} ***' -f $oldHead, $repo)
        }
    }
    Write-Host '  Starting the worker again on the code it had, so the node stays online.'
    Start-Worker | Out-Null
    exit 1
}

Write-Host ''
Write-Host '=========================================================='
Write-Host '  Installing worker dependencies and updating the worker'
Write-Host '=========================================================='
Write-Host ''

# --- 1. Find the checkout and check the account ------------------------------
$repo = Get-RepoPath
if (-not $repo -or -not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    Write-Host ('  No worker launcher in this profile ({0}).' -f $orch)
    $others = @(Get-ChildItem -LiteralPath 'C:\Users' -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '.orchestrator\start-worker-autoupdate.bat') })
    foreach ($x in $others) { Write-Host ('  A launcher exists under {0}: run this from that account.' -f $x.FullName) }
    exit 5
}
Write-Host ('[1/6] Checkout: {0}' -f $repo)
foreach ($tool in @('git', 'npm.cmd', 'node')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host ('  *** {0} is not on PATH for this account. Nothing was changed. ***' -f $tool)
        exit 5
    }
}
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($p in (Get-Workers)) {
    try {
        $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
        $owner = ('{0}\{1}' -f $o.Domain, $o.User)
        if ($o.User -and $owner -ne $me) {
            Write-Host ('  *** Wrong account. The worker runs as {0}; you are {1}. Nothing was changed. ***' -f $owner, $me)
            exit 5
        }
    } catch { }
}
# On failure the checkout goes back to the commit the RUNNING worker was built
# from (the launcher rebuilds from HEAD on a cold start). HEAD itself may already
# be the new code: the updater fast-forwards before it builds.
$stampFile = Join-Path $repo 'dist\worker-agent\.source-commit'
$oldHead = ''
if (Test-Path -LiteralPath $stampFile) { $oldHead = ([string](Get-Content -LiteralPath $stampFile -TotalCount 1)).Trim() }
if ($oldHead -notmatch '^[0-9a-f]{40}$') {
    Write-Host '  *** Could not tell which commit the worker was built from. Nothing was changed. ***'
    exit 5
}
& git -C $repo fetch --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host '  *** git fetch failed. Check the network and run this again. Nothing was changed. ***'
    exit 5
}
# Going back to the running build must never drop a commit that exists only here.
& git -C $repo merge-base --is-ancestor $oldHead HEAD
$runningIsBehind = $LASTEXITCODE -eq 0
& git -C $repo merge-base --is-ancestor HEAD '@{u}'
if (-not $runningIsBehind -or $LASTEXITCODE -ne 0) {
    Write-Host '  *** The checkout has commits that are not upstream, or has diverged. Nothing was changed. ***'
    exit 5
}
$candidate = Join-Path $repo 'dist\worker-agent\index.next.js'
Write-Host ('      the worker runs {0}' -f $oldHead)
Write-Host ''

# --- 2. Stop the scheduled task and the worker --------------------------------
Write-Host '[2/6] Stopping the worker...'
try {
    $tasks = Get-ScheduledTask -ErrorAction Stop
    foreach ($name in @($taskName, $updateTaskName)) {
        $task = $tasks | Where-Object { $_.TaskName -eq $name } | Select-Object -First 1
        if ($task) { try { $task | Stop-ScheduledTask -ErrorAction Stop } catch { } }
    }
} catch { }
Hold-LauncherLock
# Repeated, supervisors first: a supervisor left alive respawns its child within
# about a second.
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $workers = @(Get-Workers)
    if ($workers.Count -eq 0) { break }
    # A supervisor is started with --supervise, and is the parent of a worker.
    $parentIds = @($workers | ForEach-Object { $_.ParentProcessId })
    $supervisors = @($workers | Where-Object { $_.CommandLine -match '--supervise' -or $parentIds -contains $_.ProcessId })
    foreach ($w in ($supervisors + $workers)) {
        try { Stop-Process -Id $w.ProcessId -Force -ErrorAction Stop } catch { }
    }
    # A launcher run caught mid-build would start a worker once its build ends.
    $launchers = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'start-worker' })
    foreach ($l in $launchers) {
        try { Stop-Process -Id $l.ProcessId -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Seconds 1
}
if (@(Get-Workers).Count -gt 0) {
    Remove-Item -LiteralPath $launcherLock -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host '  *** Could not stop every worker process. Nothing was changed. ***'
    Write-Host '  Re-run this from an elevated prompt, or reboot.'
    exit 1
}
Write-Host '      stopped'
Write-Host ''

# --- 3. Fast-forward to the upstream branch ----------------------------------
Write-Host '[3/6] Moving to the latest code...'
& git -C $repo merge --ff-only --quiet '@{u}'
if ($LASTEXITCODE -ne 0) { Undo-AndRestart 'The checkout could not fast-forward (local changes or a diverged branch).' }
$newHead = ([string](& git -C $repo rev-parse HEAD 2>$null)).Trim()
Write-Host ('      code now at {0}' -f $newHead)
Write-Host ''

# --- 4. Install dependencies --------------------------------------------------
# --no-save keeps package-lock.json as committed: npm can rewrite it, and a dirty
# lockfile would stop every later fast-forward by the worker's own updater.
# The repo's postinstall also runs (Electron download, native rebuild for the
# desktop app); a failure there fails this step too.
Write-Host '[4/6] Installing dependencies (this can take several minutes)...'
Hold-LauncherLock
Push-Location -LiteralPath $repo
& npm.cmd install --no-save --no-audit --no-fund
$npmRc = $LASTEXITCODE
Pop-Location
if ($npmRc -ne 0) { Undo-AndRestart ('npm install failed (exit {0}); see its output above.' -f $npmRc) }
Write-Host '      done'
Write-Host ''

# --- 5. Test-build the new worker ---------------------------------------------
Write-Host '[5/6] Test-building the new worker...'
Hold-LauncherLock
Push-Location -LiteralPath $repo
$env:AIO_WORKER_BUILD_OUTFILE = $candidate
& node (Join-Path $repo 'node_modules\tsx\dist\cli.mjs') build-worker-agent.ts
$buildRc = $LASTEXITCODE
Remove-Item Env:\AIO_WORKER_BUILD_OUTFILE -ErrorAction SilentlyContinue
Pop-Location
if ($buildRc -ne 0 -or -not (Test-Path -LiteralPath $candidate)) { Undo-AndRestart ('The new worker did not build (exit {0}).' -f $buildRc) }
& node $candidate --self-check
if ($LASTEXITCODE -ne 0) { Undo-AndRestart 'The new worker built but failed its self-check.' }
Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
Write-Host '      ok'
Write-Host ''

# --- 6. Start the worker on the new code --------------------------------------
# A cold start makes the launcher rebuild dist\worker-agent\index.js from HEAD.
Write-Host '[6/6] Starting the worker (it rebuilds itself first)...'
if (-not (Start-Worker)) { exit 2 }
$deadline = (Get-Date).AddSeconds(240)
$after = @()
while ((Get-Date) -lt $deadline) {
    $after = @(Get-Workers)
    if ($after.Count -gt 0) { break }
    Start-Sleep -Seconds 2
}
if ($after.Count -eq 0) {
    Write-Host '  *** The worker did not come back within 4 minutes. ***'
    Write-Host ('  Check {0}\logs\worker-stderr.log' -f $orch)
    exit 3
}
$stamp = Join-Path $repo 'dist\worker-agent\.source-commit'
$built = if (Test-Path -LiteralPath $stamp) { ([string](Get-Content -LiteralPath $stamp -TotalCount 1)).Trim() } else { 'unknown' }
Write-Host ('      worker is back, built from {0}' -f $built)
if ($built -ne $newHead) {
    Write-Host '  *** The bundle is not from the new code. Check worker-stderr.log. ***'
    exit 4
}
Write-Host ''
Write-Host '=========================================================='
Write-Host '  Done. The worker is on the latest code.'
Write-Host '=========================================================='
exit 0
