@echo off
setlocal
cd /d "%~dp0"

echo Building worker agent...
call npx tsx build-worker-agent.ts
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)

REM Capture raw stderr. V8's fatal handler ("FATAL ERROR: ... JavaScript heap
REM out of memory") is written by C++ straight to fd 2 and bypasses the worker's
REM in-process file logger entirely, so without this redirect an OOM death
REM leaves no evidence anywhere.
REM
REM Local to this script only (hence setlocal) - the worker does NOT read this
REM variable; WorkerFileLogger always uses %USERPROFILE%\.orchestrator\logs.
REM Roll the previous run's file aside rather than appending forever: a fatal
REM error belongs to the run that died, and this bounds growth to two files.
set "_AIO_STDERR_DIR=%USERPROFILE%\.orchestrator\logs"
if not exist "%_AIO_STDERR_DIR%" mkdir "%_AIO_STDERR_DIR%" 2>nul
if exist "%_AIO_STDERR_DIR%\worker-stderr.log" (
    move /y "%_AIO_STDERR_DIR%\worker-stderr.log" "%_AIO_STDERR_DIR%\worker-stderr.log.1" >nul 2>nul
)

REM Drift check. The deployed launcher in %USERPROFILE%\.orchestrator is rendered
REM from scripts\windows\start-worker-autoupdate.template.bat by
REM install-worker-launcher.ps1, which records two hashes. Compare both:
REM   template - the repo moved on (this pull brought a new template).
REM   deployed - someone hand-edited the deployed launcher. That is the
REM              2026-09-03 failure mode; the template hash cannot see it.
REM
REM Warn ONLY. Rewriting the deployed .bat here would be rewriting the file that
REM is currently executing us, which is the byte-offset hazard that put it
REM outside the repo in the first place. Every step is failure-tolerant: a
REM missing stamp, missing certutil or odd output must never block startup.
REM
REM Delayed expansion is scoped to this block on purpose. Script-wide it would
REM also apply to %* on the node line below, mangling any argument containing
REM an exclamation mark.
setlocal EnableDelayedExpansion
set "_AIO_ORCH=%USERPROFILE%\.orchestrator"
set "_AIO_STALE="

set "_AIO_TSTAMP=%_AIO_ORCH%\launcher-template.sha256"
set "_AIO_TFILE=%~dp0scripts\windows\start-worker-autoupdate.template.bat"
if exist "%_AIO_TSTAMP%" if exist "%_AIO_TFILE%" (
    set "_AIO_TW="
    set "_AIO_TH="
    for /f "usebackq delims=" %%S in ("%_AIO_TSTAMP%") do if not defined _AIO_TW set "_AIO_TW=%%S"
    for /f "skip=1 delims=" %%H in ('certutil -hashfile "%_AIO_TFILE%" SHA256 2^>nul') do if not defined _AIO_TH set "_AIO_TH=%%H"
    set "_AIO_TH=!_AIO_TH: =!"
    if defined _AIO_TW if defined _AIO_TH if /i not "!_AIO_TW!"=="!_AIO_TH!" set "_AIO_STALE=1"
)

set "_AIO_DSTAMP=%_AIO_ORCH%\launcher-deployed.sha256"
set "_AIO_DFILE=%_AIO_ORCH%\start-worker-autoupdate.bat"
if exist "%_AIO_DSTAMP%" if exist "%_AIO_DFILE%" (
    set "_AIO_DW="
    set "_AIO_DH="
    for /f "usebackq delims=" %%S in ("%_AIO_DSTAMP%") do if not defined _AIO_DW set "_AIO_DW=%%S"
    for /f "skip=1 delims=" %%H in ('certutil -hashfile "%_AIO_DFILE%" SHA256 2^>nul') do if not defined _AIO_DH set "_AIO_DH=%%H"
    set "_AIO_DH=!_AIO_DH: =!"
    if defined _AIO_DW if defined _AIO_DH if /i not "!_AIO_DW!"=="!_AIO_DH!" set "_AIO_STALE=1"
)

REM "Never installed" is a DIFFERENT failure from drift, and neither check above
REM can see it: both are guarded on their stamp existing, so a host that has never
REM run install-worker-launcher.ps1 has no stamps, sets no flag, and is told
REM nothing at all. The guard detects divergence AFTER a correct install; silence
REM is not evidence of a healthy one.
REM
REM That is exactly the state windows-pc was in on 2026-09-05. The tracked
REM --supervise fix had reached it by git pull, so the worker looked fixed, but
REM the scheduled task was still the old detached `cmd /c start` form with a
REM logon-only trigger. When the process tree died at 15:23 nothing restarted it
REM and the node stayed down for six hours. Name the missing artifacts rather
REM than printing a generic "not installed", so the reader can see which half of
REM the launch chain is absent.
set "_AIO_VBS=%_AIO_ORCH%\run-worker-hidden.vbs"
set "_AIO_MISSING="
if not exist "%_AIO_DFILE%" set "_AIO_MISSING=1"
if not exist "%_AIO_VBS%" set "_AIO_MISSING=1"
if not exist "%_AIO_TSTAMP%" set "_AIO_MISSING=1"
if not exist "%_AIO_DSTAMP%" set "_AIO_MISSING=1"

REM The four files above are all written BEFORE the installer's -RegisterTask
REM gate, so finding them proves only that the launcher was DEPLOYED - never that
REM anything is left to run it. Installing without -RegisterTask is the script's
REM own documented first step, and a task can also be removed later by a GPO
REM reset, an AV sweep, or a re-registration that was refused for lack of
REM elevation. Every one of those leaves all four files sitting on disk and the
REM node exactly as unrecoverable as windows-pc was on 2026-09-05. Without this
REM probe the warning below would be asserting more than it had checked.
REM
REM Two distinct bad states, and they need different words: MISSING (no such
REM task) and STALE (a task exists but does not run our launcher). windows-pc had
REM the latter right through the 2026-09-05 outage - its action was the old
REM `cmd /c start ... /min`, which DETACHES, so Task Scheduler saw it succeed in
REM milliseconds and never learned the worker had died. A bare existence check
REM would have called that healthy.
REM
REM Probed through PowerShell rather than `schtasks`, for two reasons that both
REM caused wrong answers in review:
REM   - `schtasks /fo list /v` prints one flat verbose record, so grepping it for
REM     the launcher filename also matches the Comment and Author fields; a task
REM     merely DOCUMENTED as running the .vbs while still carrying the old action
REM     would be passed as healthy. Get-ScheduledTask lets us read Execute and
REM     Arguments alone. Scoping the grep to the "Task To Run" label instead would
REM     have swapped one bug for a worse one, because that label is localised.
REM   - `schtasks /tn <name>` resolves only the root folder, while the installer
REM     deliberately preserves an existing task's TaskPath (see its $taskPath
REM     handling). Get-ScheduledTask enumerates every folder, so the two files now
REM     agree about which task they mean.
REM
REM Existence, not enabled-ness: WORKER_AGENT_SETUP.md documents
REM `Disable-ScheduledTask` as the supported way to stop the worker deliberately,
REM so a disabled task must not be reported as broken.
REM
REM Exit codes are the whole interface: 0 healthy, 2 missing, 3 stale, and 1 or
REM anything else means the probe could not answer, which must say NOTHING - the
REM same fail-open contract as the certutil steps above. Hence the errorlevel 4
REM guard: `if errorlevel` means ">=", so without it a PowerShell that failed to
REM launch (cmd reports 9009) would be read as "stale" and raise a false alarm.
REM For the same reason the branches test 3 before 2. `if errorlevel` is a
REM run-time test, unlike %ERRORLEVEL%, so it is safe inside this block.
REM
REM Enumerate-then-filter rather than `Get-ScheduledTask -TaskName X
REM -ErrorAction SilentlyContinue`: that form swallows every non-terminating
REM error, so a stopped Task Scheduler service or an RPC failure would come back
REM indistinguishable from "no such task" and we would report MISSING and send
REM the reader to re-run an installer that cannot fix it. Listing the tasks
REM throws on a genuine service or permission fault, which the catch turns into
REM silence, and only a successful listing that lacks the name means MISSING.
REM
REM Both values reach PowerShell through the ENVIRONMENT, never by pasting them
REM into the -Command string. Interpolating a path into a single-quoted PS literal
REM breaks on the first apostrophe, and `C:\Users\O'Brien\...` is an ordinary
REM Windows profile. That failure is quiet in the worst way: the parse error exits
REM 1, which this block treats as "could not answer", so the probe would simply
REM stop detecting missing and stale tasks for that user. The variables are set
REM inside this setlocal, so they vanish at endlocal and never reach the worker.
REM
REM IndexOf/OrdinalIgnoreCase rather than -like for the same class of reason:
REM -like reads [ and ] as a character class, so a profile such as
REM `C:\Users\John[Contractor]` would never match its own launcher and would be
REM reported stale. IndexOf compares text as text. Empty values are treated as
REM unanswerable rather than matching everything.
REM
REM Match the FULL expected path from %_AIO_VBS%, not the bare filename. On
REM 2026-09-06 an installer run from an elevated shell belonging to a different
REM admin account registered the task against
REM C:\Users\CTAdmin\.orchestrator\run-worker-hidden.vbs - a profile the worker
REM user cannot even read - and a filename-only match reported that as HEALTHY.
REM The launcher this host will actually use is the one in its own install root;
REM anything else is as broken as no task at all.
set "_AIO_TASKNAME=AI Orchestrator Worker"
set "_AIO_NOTASK="
set "_AIO_TASKSTALE="
set "AIO_PROBE_TASK=%_AIO_TASKNAME%"
set "AIO_PROBE_VBS=%_AIO_VBS%"
where powershell >nul 2>&1
if not errorlevel 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "if (-not $env:AIO_PROBE_TASK -or -not $env:AIO_PROBE_VBS) { exit 1 }; try { $all = Get-ScheduledTask -ErrorAction Stop } catch { exit 1 }; $t = $all | Where-Object { $_.TaskName -eq $env:AIO_PROBE_TASK }; if (-not $t) { exit 2 }; $a = ($t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' '; if ($a.IndexOf($env:AIO_PROBE_VBS, [StringComparison]::OrdinalIgnoreCase) -ge 0) { exit 0 } else { exit 3 }" >nul 2>&1
    if errorlevel 4 (
        rem Unexpected exit code: the probe could not run. Say nothing.
    ) else if errorlevel 3 (
        set "_AIO_TASKSTALE=1"
    ) else if errorlevel 2 (
        set "_AIO_NOTASK=1"
    )
)
if defined _AIO_NOTASK set "_AIO_MISSING=1"
if defined _AIO_TASKSTALE set "_AIO_MISSING=1"

if defined _AIO_MISSING (
    echo.
    echo *** WARNING: the worker launcher is not fully installed on this host. ***
    echo     Nothing will restart this worker if its process tree dies.
    if not exist "%_AIO_DFILE%" echo       missing: %_AIO_DFILE%
    if not exist "%_AIO_VBS%" echo       missing: %_AIO_VBS%
    if not exist "%_AIO_TSTAMP%" echo       missing: %_AIO_TSTAMP%
    if not exist "%_AIO_DSTAMP%" echo       missing: %_AIO_DSTAMP%
    if defined _AIO_NOTASK echo       missing: scheduled task "%_AIO_TASKNAME%"
    if defined _AIO_TASKSTALE echo       stale:   scheduled task "%_AIO_TASKNAME%" does not run %_AIO_VBS%
    echo     Install with: powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 -RepoPath "%CD%" -RegisterTask
    REM Parentheses MUST be escaped here: an unescaped ) inside a parenthesised
    REM block closes the block early. Caught by testing - the first draft printed
    REM "...ELEVATED PowerShell" with the closing bracket silently eaten.
    echo     ^(registering the task needs an ELEVATED PowerShell^)
    echo.
)

REM Suppressed when the install is already known incomplete, because the two
REM blocks would otherwise describe the same file two different ways. Delete the
REM deployed .bat while the repo's template has also moved on and you get
REM "missing: ...start-worker-autoupdate.bat" immediately followed by a message
REM saying that same file "was hand-edited" - contradictory text at the one moment
REM this output has to be unambiguous. Nothing is lost by dropping it: the remedy
REM printed above is the same installer re-run, and drift on a host that is not
REM properly installed yet is not the headline.
if defined _AIO_STALE if not defined _AIO_MISSING (
    echo.
    echo *** WARNING: the deployed worker launcher does not match the repo. ***
    echo     Either scripts\windows\start-worker-autoupdate.template.bat has changed,
    echo     or %%USERPROFILE%%\.orchestrator\start-worker-autoupdate.bat was hand-edited.
    echo     Re-run: powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 -RepoPath "%CD%"
    echo.
)
endlocal

REM --supervise runs the worker under its own restart parent (worker-supervisor.ts).
REM Without it a single process exit leaves the node dead until someone notices:
REM on 2026-09-03 the worker died at 12:45 and stayed down for 23 hours because
REM this script simply ended and the launching `cmd /K` sat at a prompt.
REM
REM The flag goes LAST: index.ts dispatches positional subcommands off argv[0]
REM ("native-host", "pair", "install-extension-relay"), so putting it first would
REM shadow them. Supervision is selected with argv.includes(), not by position.
echo Starting worker agent (supervised)...
node dist/worker-agent/index.js %* --supervise 2>> "%_AIO_STDERR_DIR%\worker-stderr.log"
