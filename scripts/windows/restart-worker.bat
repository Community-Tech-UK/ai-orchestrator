@echo off
REM ---------------------------------------------------------------------------
REM Restart the AI Orchestrator worker node on this machine.
REM
REM Source of truth: scripts\windows\restart-worker.bat
REM Deploy a COPY to: %USERPROFILE%\Desktop\restart-worker.bat
REM
REM *** DO NOT RUN THE COPY THAT LIVES INSIDE THE REPO. ***
REM The launch chain this script triggers performs a `git pull`. cmd.exe reads a
REM .bat incrementally from disk by byte offset while executing it, so a pull
REM that rewrote this file mid-run would resume at a stale offset and execute
REM garbage. That is the same reason start-worker-autoupdate.bat is deployed
REM outside the tree. Run the Desktop copy.
REM
REM WHY A DEDICATED RESTART SCRIPT EXISTS
REM start-worker.bat deliberately SKIPS the build and the start when a worker is
REM already running for the checkout - by design, because the scheduled task
REM fires every few minutes and must not rewrite a live worker's code. The side
REM effect is that `git pull` + rebuild can land a new dist\worker-agent\index.js
REM underneath a long-lived process, and that process keeps serving the OLD code
REM until something stops it.
REM
REM That is exactly what happened on 2026-09-07/08: the checkout was current, the
REM bundle was rebuilt at 09:14, but the worker had been running since 07:49, so
REM the coordinator rejected every browser command and reported the worker as too
REM old. Nothing needed redeploying. It needed restarting.
REM
REM So "restart" is NOT "run the launcher again" - the launcher no-ops against a
REM live worker. The worker must be stopped FIRST, which is what this does.
REM
REM WHY THE POWERSHELL LIVES IN THE TAIL OF THIS FILE
REM Passing a real script through `powershell -Command "..."` means fighting two
REM parsers at once. cmd tracks quotes by naive counting and knows nothing about
REM \" escaping, so every inner quote flips its quote state - and a `|` that
REM lands while that state is OFF silently becomes a cmd pipe instead of a
REM PowerShell one. Rather than hand-verify that for every line, the script is
REM stored below the marker and read back from disk, so it is plain PowerShell
REM with no escaping at all. The one bootstrap line below has no pipes and no
REM inner quotes.
REM
REM Keep this file pure ASCII.
REM ---------------------------------------------------------------------------
setlocal

REM Path passed through the environment, never interpolated into the PowerShell
REM string: C:\Users\O'Brien\Desktop\... is an ordinary Windows profile and would
REM terminate a single-quoted PS literal.
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
$orch     = Join-Path $env:USERPROFILE '.orchestrator'
$vbs      = Join-Path $orch 'run-worker-hidden.vbs'
$bat      = Join-Path $orch 'start-worker-autoupdate.bat'

# Matched on the entrypoint rather than the bare string 'worker-agent', because
# the launcher's build step runs `npx tsx build-worker-agent.ts` - a node process
# whose command line would otherwise be greeted as the restarted worker.
#
# native-host helpers are excluded: they share the entrypoint but serve Chrome's
# native messaging port for the browser extension relay, and killing them would
# drop the shared-tab channel for no reason.
$match = 'worker-agent\index.js'

function Get-Workers {
    $procs = @()
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
    } catch {
        return @()
    }
    # IndexOf/OrdinalIgnoreCase rather than -like: -like reads [ and ] as a
    # character class, so a profile such as C:\Users\John[Contractor] would never
    # match its own worker.
    return @($procs | Where-Object {
        $_.CommandLine -and
        $_.CommandLine.IndexOf($match, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine.IndexOf('native-host', [StringComparison]::OrdinalIgnoreCase) -lt 0
    })
}

function Get-BundlePath {
    param($workers)
    foreach ($w in $workers) {
        $m = [regex]::Match($w.CommandLine, '([A-Za-z]:\\[^"]*?worker-agent\\index\.js)')
        if ($m.Success) { return $m.Groups[1].Value }
    }
    return $null
}

Write-Host ''
Write-Host '=========================================================='
Write-Host '  Restarting the AI Orchestrator worker'
Write-Host '=========================================================='
Write-Host ''

# --- 1. What is running now ------------------------------------------------
Write-Host '[1/5] Current worker processes:'
$before = @(Get-Workers)
$bundle = Get-BundlePath $before
if ($before.Count -gt 0) {
    foreach ($p in $before) {
        Write-Host ('      pid {0}  started {1}' -f $p.ProcessId, $p.CreationDate)
    }
} else {
    Write-Host '      (none running)'
}
if ($bundle -and (Test-Path -LiteralPath $bundle)) {
    Write-Host ('      bundle {0}' -f $bundle)
    Write-Host ('      bundle last built {0}' -f (Get-Item -LiteralPath $bundle).LastWriteTime)
}
Write-Host ''

# --- 1b. Are we running as the account that owns the worker? ----------------
# The worker runs as one specific user (shutu on windows-pc). Run this from a
# different admin account - CTAdmin, say - and $env:USERPROFILE resolves to the
# WRONG .orchestrator: no launcher, no vbs, no logs. The fallback start paths
# would then launch a worker under the wrong profile entirely.
#
# This repo has been bitten by it already. install-worker-launcher.ps1 once
# registered the task against C:\Users\CTAdmin\.orchestrator\run-worker-hidden.vbs,
# a path the worker user cannot even read, and a filename-only check reported it
# as healthy (see start-worker.bat, "Elevating can put you in a different
# account").
#
# Also catches the non-elevated case: Win32_Process hides CommandLine for other
# users' processes, so an unprivileged shell in the wrong account sees no workers
# at all and would otherwise cheerfully "start" a second one.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$owner = $null
foreach ($p in $before) {
    try {
        $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
        if ($o.User) { $owner = ('{0}\{1}' -f $o.Domain, $o.User); break }
    } catch { }
}
if ($owner -and $owner -ne $me) {
    Write-Host ('  *** Wrong account. The worker runs as {0}; you are {1}. ***' -f $owner, $me)
    Write-Host '  Stopping it from here would work, but the restart would target this'
    Write-Host ('  profile ({0}), which is not where the launcher lives.' -f $orch)
    Write-Host ('  Log in as {0} and run this from that desktop.' -f $owner)
    exit 5
}
if ($before.Count -eq 0 -and -not (Test-Path -LiteralPath $bat)) {
    Write-Host ('  No worker running, and no launcher in this profile ({0}).' -f $orch)
    $others = @(Get-ChildItem -LiteralPath 'C:\Users' -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '.orchestrator\start-worker-autoupdate.bat') })
    if ($others.Count -gt 0) {
        Write-Host '  A launcher DOES exist under:'
        foreach ($x in $others) { Write-Host ('    {0}' -f $x.FullName) }
        Write-Host '  You are almost certainly in the wrong account. Run this from that desktop.'
        exit 5
    }
}
Write-Host ''

# --- 2. Stop the scheduled task --------------------------------------------
# Stopped BEFORE killing node. The task blocks for as long as the worker lives
# (that is the whole point of run-worker-hidden.vbs), so leaving it running lets
# its repetition trigger race us and relaunch mid-kill.
#
# Enumerated across all folders rather than `Get-ScheduledTask -TaskName X`:
# the installer preserves an existing task's TaskPath, and the -TaskName form
# only resolves the root folder.
Write-Host '[2/5] Stopping the scheduled task...'
$tasks = $null
try {
    $tasks = Get-ScheduledTask -ErrorAction Stop
} catch {
    Write-Host '      (could not read Task Scheduler - continuing)'
}
if ($tasks) {
    $task = $tasks | Where-Object { $_.TaskName -eq $taskName } | Select-Object -First 1
    if ($task) {
        try {
            $task | Stop-ScheduledTask -ErrorAction Stop
            Write-Host '      stopped'
        } catch {
            Write-Host ('      could not stop it - continuing: {0}' -f $_.Exception.Message)
        }
    } else {
        Write-Host '      (no such task - continuing)'
    }
}
Write-Host ''

# --- 3. Stop the worker ----------------------------------------------------
# The supervisor goes first. It is the same entrypoint run with --supervise and
# its entire job is to respawn the child, so killing the child first just makes
# the supervisor put it straight back.
Write-Host '[3/5] Stopping worker processes...'
foreach ($s in (Get-Workers | Where-Object {
    $_.CommandLine.IndexOf('--supervise', [StringComparison]::OrdinalIgnoreCase) -ge 0
})) {
    try {
        Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop
        Write-Host ('      stopped supervisor pid {0}' -f $s.ProcessId)
    } catch {
        Write-Host ('      could not stop pid {0}: {1}' -f $s.ProcessId, $_.Exception.Message)
    }
}
Start-Sleep -Milliseconds 500
foreach ($r in (Get-Workers)) {
    try {
        Stop-Process -Id $r.ProcessId -Force -ErrorAction Stop
        Write-Host ('      stopped worker pid {0}' -f $r.ProcessId)
    } catch {
        Write-Host ('      could not stop pid {0}: {1}' -f $r.ProcessId, $_.Exception.Message)
    }
}

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and @(Get-Workers).Count -gt 0) {
    Start-Sleep -Milliseconds 500
}
if (@(Get-Workers).Count -gt 0) {
    Write-Host ''
    Write-Host '  *** Could not stop every worker process. ***'
    Write-Host '  Nothing was restarted, so the worker is still serving its old code.'
    Write-Host '  Re-run this from an ELEVATED prompt, or reboot.'
    exit 1
}
Write-Host '      all stopped'
Write-Host ''

# --- 4. Start it again ------------------------------------------------------
# The scheduled task is the preferred route because it is the supported launch
# path: hidden, supervised, detached, and tracked by Task Scheduler for real
# liveness. Launching the .bat from this console instead would tie the worker to
# this window and kill it when the window closes.
Write-Host '[4/5] Starting the worker...'
$started = $false
if ($tasks) {
    $task = $tasks | Where-Object { $_.TaskName -eq $taskName } | Select-Object -First 1
    if ($task) {
        try {
            Start-ScheduledTask -InputObject $task -ErrorAction Stop
            Write-Host '      started via scheduled task'
            $started = $true
        } catch {
            Write-Host ('      scheduled task start failed: {0}' -f $_.Exception.Message)
        }
    }
}
if (-not $started -and (Test-Path -LiteralPath $vbs)) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') | Out-Null
    Write-Host '      started via run-worker-hidden.vbs (no scheduled task)'
    $started = $true
}
if (-not $started -and (Test-Path -LiteralPath $bat)) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $bat + '"') -WindowStyle Hidden | Out-Null
    Write-Host '      started via start-worker-autoupdate.bat (no task, no vbs)'
    $started = $true
}
if (-not $started) {
    Write-Host ''
    Write-Host '  *** The worker launcher is not installed on this host. ***'
    Write-Host '  Install it from the repo checkout with:'
    Write-Host '    powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 -RepoPath "C:\path\to\ai-orchestrator" -RegisterTask'
    Write-Host '  (registering the task needs an ELEVATED PowerShell)'
    exit 2
}
Write-Host ''

# --- 5. Confirm it came back ------------------------------------------------
# Generous timeout on purpose: the launcher runs `git pull` and then rebuilds
# dist\worker-agent\index.js before the worker process appears, which is well
# over a minute on a cold cache. Reporting failure at 15s would just be wrong.
Write-Host '[5/5] Waiting for the worker to come back (up to 3 minutes)...'
$deadline = (Get-Date).AddSeconds(180)
$after = @()
while ((Get-Date) -lt $deadline) {
    $after = @(Get-Workers)
    if ($after.Count -gt 0) { break }
    Start-Sleep -Seconds 2
}
if ($after.Count -eq 0) {
    Write-Host ''
    Write-Host '  *** The worker did not restart. ***'
    Write-Host '  Check the build / stderr logs:'
    Write-Host ('    {0}\logs\worker-stderr.log' -f $orch)
    Write-Host ('    {0}\logs\worker-stderr.log.1' -f $orch)
    Write-Host '  A failed build-worker-agent step is the usual cause.'
    exit 3
}

Write-Host ''
Write-Host '      Worker is back:'
foreach ($p in $after) {
    Write-Host ('      pid {0}  started {1}' -f $p.ProcessId, $p.CreationDate)
}

# The point of the whole exercise: a process that started BEFORE the bundle was
# built is still serving the old code, which is the exact failure this script
# exists to clear. Say so rather than reporting a cheerful success.
$bundle = Get-BundlePath $after
if ($bundle -and (Test-Path -LiteralPath $bundle)) {
    $built  = (Get-Item -LiteralPath $bundle).LastWriteTime
    $newest = ($after | Sort-Object CreationDate -Descending | Select-Object -First 1).CreationDate
    Write-Host ('      bundle last built {0}' -f $built)
    if ($newest -lt $built) {
        Write-Host ''
        Write-Host '  *** WARNING: the worker started BEFORE the bundle was built. ***'
        Write-Host '  It is still running older code. Run this script again.'
        exit 4
    }
}

Write-Host ''
Write-Host '=========================================================='
Write-Host '  Done. The worker is running current code.'
Write-Host ''
Write-Host '  Verify from the Mac: the node should now report'
Write-Host '  extensionRelay.forwardsRuntimeEvidence: true and a'
Write-Host '  fresh workerAgent.startedAt.'
Write-Host '=========================================================='
exit 0
